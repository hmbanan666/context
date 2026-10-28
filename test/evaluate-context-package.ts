import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPackageFixture } from "./fixtures/package-client.js";
import {
  facts,
  period,
  questions,
  scope,
  seedPackageCorpus,
} from "./fixtures/package-corpus.js";

const directory = await mkdtemp(join(tmpdir(), "context-package-eval-"));
try {
  const methods = process.argv.includes("--baseline")
    ? [
        "phrase",
        "memory-question",
        "memory-keywords",
        "memory-paged",
        "project",
      ]
    : [
        "phrase",
        "memory-question",
        "memory-keywords",
        "memory-paged",
        "project",
        "package",
      ];
  const rows: Array<{
    question: string;
    method: string;
    complete: boolean;
    evidenceComplete: boolean;
    missingFacts: string[];
    recall: number;
    precision: number;
    calls: number;
    bytes: number;
    overBudgetResponses: number;
    missing: string[];
    found: string[];
    errors: number;
    truncated: boolean;
  }> = [];
  for (const method of methods) {
    // Independent sessions keep each replay below the unchanged 60 requests/minute gate.
    const fixture = await openPackageFixture(join(directory, "memory.db"));
    try {
      const { labels } = seedPackageCorpus(fixture.store, fixture.knowledge);
      const client = await fixture.connect();
      for (const q of questions) {
        const tool =
          method === "phrase"
            ? "recall"
            : method === "project"
              ? "project_context"
              : method === "package"
                ? "context_package"
                : "memory_context";
        const args =
          method === "phrase"
            ? { version: 1, scope, query: q.question, limit: 20 }
            : method === "project"
              ? { version: 1, scope, limit: 8, maxBytes: 4096 }
              : method === "package"
                ? {
                    question: q.question,
                    ...period,
                    mode: "mode" in q ? q.mode : "search",
                    limit: 8,
                    maxBytes: 4096,
                  }
                : {
                    ...period,
                    query:
                      method === "memory-keywords" || method === "memory-paged"
                        ? q.keywords
                        : q.question,
                    limit: 8,
                    maxBytes: 4096,
                  };
        let calls = 1;
        let errors = 0;
        const evidence = new Map<string, string>();
        const collect = (payload: unknown) => {
          const data = payload as {
            sources?: Array<{
              id?: string;
              excerpt?: { text: string };
              text?: string;
              source?: { id: string; text: string };
            }>;
            material?: { source: { id: string; text: string } };
          };
          for (const s of [
            ...(data.sources ?? []),
            ...(data.material ? [data.material] : []),
          ]) {
            const source = "source" in s ? s.source : undefined;
            const id = source?.id ?? ("id" in s ? s.id : undefined);
            const text =
              source?.text ??
              ("excerpt" in s ? s.excerpt?.text : undefined) ??
              ("text" in s ? s.text : undefined);
            if (id && text)
              evidence.set(id, `${evidence.get(id) ?? ""}\n${text}`);
          }
        };
        const r = await client.callTool({ name: tool, arguments: args });
        errors += Number(!!r.isError);
        collect(r.structuredContent);
        const data = r.structuredContent as {
          sources?: Array<{ id?: string; source?: { id: string } }>;
          truncated?: boolean;
          oversizedSources?: Array<{ id: string }>;
          nextCursor?: string | null;
        };
        const found = (data?.sources ?? []).map(
          (s) => labels.get(s.id ?? s.source?.id ?? "") ?? "FOREIGN",
        );
        assert(!found.includes("FOREIGN"), "Scope leak");
        let bytes = Buffer.byteLength(JSON.stringify(data));
        let overBudgetResponses = Number(bytes > 4096);
        if (method === "memory-paged") {
          let page = data;
          while (calls < 4) {
            for (const entry of page.oversizedSources ?? []) {
              if (calls >= 4) break;
              const full = await client.callTool({
                name: "read_material",
                arguments: { version: 1, scope, id: entry.id },
              });
              calls++;
              errors += Number(!!full.isError);
              collect(full.structuredContent);
              const payload = JSON.stringify(full.structuredContent);
              bytes += Buffer.byteLength(payload);
              overBudgetResponses += Number(Buffer.byteLength(payload) > 4096);
              if (!full.isError) {
                const label = labels.get(entry.id);
                if (label && !found.includes(label)) found.push(label);
              }
            }
            if (!page.nextCursor || calls >= 4) break;
            const next = await client.callTool({
              name: "memory_context",
              arguments: { ...args, cursor: page.nextCursor },
            });
            calls++;
            errors += Number(!!next.isError);
            collect(next.structuredContent);
            overBudgetResponses += Number(
              Buffer.byteLength(JSON.stringify(next.structuredContent)) > 4096,
            );
            page = next.structuredContent as typeof data;
            bytes += Buffer.byteLength(JSON.stringify(page));
            for (const source of page.sources ?? []) {
              const label = labels.get(source.source?.id ?? "");
              if (label && !found.includes(label)) found.push(label);
            }
          }
        }
        const expected: readonly string[] = q.expected;
        const missing = expected.filter((id) => !found.includes(id));
        assert(!found.includes("FOREIGN"), "Scope leak");
        const suppliedFacts = new Set(
          [...evidence]
            .filter(([id, text]) => {
              const fact = facts[labels.get(id) ?? ""];
              return fact && text.includes(fact);
            })
            .map(([id]) => labels.get(id)),
        );
        const missingFacts = expected.filter((id) => !suppliedFacts.has(id));
        const relevant = found.filter((id) => expected.includes(id)).length;
        rows.push({
          question: q.id,
          method,
          complete:
            missing.length === 0 &&
            !errors &&
            (expected.length > 0 || found.length === 0),
          evidenceComplete:
            !errors &&
            !missingFacts.length &&
            (expected.length > 0 || found.length === 0),
          missingFacts,
          recall: expected.length ? relevant / expected.length : 1,
          precision: found.length
            ? relevant / found.length
            : expected.length
              ? 0
              : 1,
          calls,
          bytes,
          overBudgetResponses,
          missing,
          found,
          errors,
          truncated: !!data?.truncated,
        });
      }
    } finally {
      await fixture.close();
    }
  }
  const summary = methods.map((method) => {
    const all = rows.filter((r) => r.method === method);
    return {
      method,
      complete: all.filter((r) => r.complete).length,
      evidenceComplete: all.filter((r) => r.evidenceComplete).length,
      questions: all.length,
      meanRecall:
        all
          .filter((r) => r.question !== "absent")
          .reduce((n, r) => n + r.recall, 0) /
        all.filter((r) => r.question !== "absent").length,
      meanPrecision: all.reduce((n, r) => n + r.precision, 0) / all.length,
      calls: all.reduce((n, r) => n + r.calls, 0),
      bytes: all.reduce((n, r) => n + r.bytes, 0),
      overBudgetResponses: all.reduce((n, r) => n + r.overBudgetResponses, 0),
      errors: all.reduce((n, r) => n + r.errors, 0),
    };
  });
  console.log(
    JSON.stringify(
      {
        protocol:
          "One call per question except memory-paged (up to 4, including oversized original reads); 4096 structured JSON bytes per response where supported. Complete means required source IDs; evidenceComplete also requires verbatim facts in originals/excerpts. No LLM answer grading.",
        summary,
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
