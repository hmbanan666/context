import { DatabaseSync } from "node:sqlite";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import type { EmbeddingIndex } from "./embedding-index.js";
import type { EvalQuestion } from "./eval-questions.js";
import { KnowledgeStore } from "./knowledge.js";
import { createContextMcp } from "./mcp.js";
import { SourceStore } from "./store.js";

const card = z.object({
  id: z.string(),
  excerpt: z.object({ text: z.string() }),
});
const packageResult = z.object({
  scope: z.string(),
  sources: z.array(card),
  items: z.array(card.extend({ sourceIds: z.array(z.string()) })),
  relations: z.array(
    z.object({
      id: z.string(),
      fromId: z.string(),
      toId: z.string(),
      sourceIds: z.array(z.string()),
    }),
  ),
});
export interface EvalHit {
  id: string;
  externalIds: string[];
  excerpts: string[];
}

// No network listener, OAuth credentials, auth writes, corpus copies or search SQL.
// The owner supplies a simulated client's grants to the real protected MCP handler.
export async function retrieveForEval(
  databasePath: string,
  question: EvalQuestion,
  k: number,
  embeddings?: EmbeddingIndex,
) {
  const sources = new SourceStore(databasePath, { readOnly: true });
  let knowledge: KnowledgeStore | undefined;
  let metadata: DatabaseSync | undefined;
  let handler: ReturnType<typeof createContextMcp> | undefined;
  const client = new Client({ name: "context-eval", version: "1" });
  let semanticUsed = false;
  let semanticUnavailable = false;
  try {
    knowledge = new KnowledgeStore(databasePath, { readOnly: true });
    metadata = new DatabaseSync(databasePath, {
      readOnly: true,
      timeout: 5000,
    });
    handler = createContextMcp(sources, [], true, {
      knowledge,
      ...(embeddings
        ? {
            embeddings: {
              status: (scope?: string) => embeddings.status(scope),
              search: async (input) => {
                const hits = await embeddings.search(input);
                if (question.areas.includes(input.scope)) {
                  semanticUsed ||= hits.available;
                  semanticUnavailable ||= !hits.available;
                }
                return hits;
              },
            },
          }
        : {}),
      clientGrants: {
        "context-eval": { read: question.read_areas, write: [], process: [] },
      },
    });
    const mcp = handler;
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://eval.invalid/mcp"), {
        fetch: async (input, init) =>
          mcp.fetch(new Request(input, init), {
            authInfo: {
              token: "owner-local-eval",
              clientId: "context-eval",
              scopes: ["context:read", ...question.read_areas],
            },
          }),
      }),
    );
    const sourceInfo = metadata.prepare(
      "SELECT s.scope, m.source_uri, i.external_id FROM sources s LEFT JOIN source_metadata m ON m.source_id = s.id LEFT JOIN source_imports i ON i.source_id = s.id WHERE s.id = ?",
    );
    const itemInfo = metadata.prepare(
      "SELECT scope FROM knowledge_items WHERE id = ?",
    );
    const relationInfo = metadata.prepare(
      "SELECT scope FROM knowledge_relations WHERE id = ?",
    );
    const violations = new Set<string>();
    const lists: EvalHit[][] = [];
    let failed = false;
    for (const area of [
      ...new Set([...question.areas, ...question.forbidden_areas]),
    ]) {
      try {
        const response = await client.callTool({
          name: "context_package",
          arguments: {
            question: question.question,
            scope: area,
            limit: k,
            maxBytes: 65536,
          },
        });
        const authorized = question.read_areas.includes(area);
        if (response.isError) {
          const error = z
            .object({ error: z.string() })
            .safeParse(response.structuredContent).data?.error;
          if (
            !authorized &&
            (error === "insufficient_scope" || error === "forbidden_scope")
          )
            continue;
          throw new Error("Eval retrieval failed");
        }
        if (!authorized) violations.add(`access:${area}`);
        const result = packageResult.parse(response.structuredContent);
        if (result.scope !== area) violations.add(`scope:${area}`);
        const check = (
          kind: string,
          id: string,
          info: Record<string, unknown> | undefined,
        ) => {
          if (
            !info ||
            info.scope !== area ||
            !question.read_areas.includes(String(info.scope)) ||
            question.forbidden_areas.includes(String(info.scope))
          )
            violations.add(`${kind}:${id}`);
        };
        // Audit every returned card and reference, even beyond the metric's top k.
        for (const source of result.sources)
          check("source", source.id, sourceInfo.get(source.id));
        for (const item of result.items) {
          check("item", item.id, itemInfo.get(item.id));
          for (const id of item.sourceIds)
            check("source", id, sourceInfo.get(id));
        }
        for (const relation of result.relations) {
          check("relation", relation.id, relationInfo.get(relation.id));
          for (const id of [relation.fromId, relation.toId])
            check("item", id, itemInfo.get(id));
          for (const id of relation.sourceIds)
            check("source", id, sourceInfo.get(id));
        }
        if (question.areas.includes(area))
          lists.push(
            result.sources.map((source) => {
              const info = sourceInfo.get(source.id);
              return {
                id: source.id,
                excerpts: [
                  source.excerpt.text,
                  ...result.items
                    .filter((item) => item.sourceIds.includes(source.id))
                    .map((item) => item.excerpt.text),
                ],
                externalIds: [info?.external_id, info?.source_uri].filter(
                  (id): id is string => typeof id === "string",
                ),
              };
            }),
          );
      } catch {
        failed = true;
      }
    }
    // MCP has single-area rankings. Round-robin preserves each area's rank without
    // comparing strategy-specific scores; area order is part of the frozen eval set.
    const hits: EvalHit[] = [];
    for (let rank = 0; rank < k && hits.length < k; rank++) {
      for (const list of lists) {
        const hit = list[rank];
        if (hit && !hits.some((h) => h.id === hit.id) && hits.length < k)
          hits.push(hit);
      }
    }
    return {
      hits,
      isolationViolations: violations.size,
      violationKeys: [...violations],
      failed,
      semanticUsed,
      semanticUnavailable,
    };
  } finally {
    await client.close();
    await handler?.close();
    metadata?.close();
    knowledge?.close();
    sources.close();
  }
}
