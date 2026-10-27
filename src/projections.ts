import { z } from "zod";
import { scopeSchema } from "./contracts.js";
import type {
  KnowledgeItem,
  KnowledgeRelation,
  KnowledgeStore,
} from "./knowledge.js";
import type { Material } from "./materials.js";
import type { SourceStore } from "./store.js";

export const projectContextSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  limit: z.number().int().min(1).max(20).default(10),
  maxBytes: z.number().int().min(1024).max(65536).default(16384),
});
export type ProjectContextInput = z.input<typeof projectContextSchema>;
export interface ProjectContext {
  readonly version: 1;
  readonly scope: string;
  readonly generatedAt: string;
  sources: Material[];
  items: KnowledgeItem[];
  relations: KnowledgeRelation[];
  truncated: boolean;
}

// The byte budget covers this entire JSON payload, including its envelope.
// MCP transport framing and duplicated text/structured representations are separate.
function fits(context: ProjectContext, maxBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify(context), "utf8") <= maxBytes;
}

// Scope grants are checked by the authenticated caller before this read-only builder.
// All records remain untrusted source data; this function never interprets approval.
export function buildProjectContext(
  sources: SourceStore,
  knowledge: KnowledgeStore,
  input: ProjectContextInput,
): ProjectContext {
  const request = projectContextSchema.parse(input);
  let context: ProjectContext = {
    version: 1,
    scope: request.scope,
    generatedAt: new Date().toISOString(),
    sources: [],
    items: [],
    relations: [],
    truncated: false,
  };
  const materialCache = new Map<string, Material | undefined>();
  const includedSources = new Set<string>();
  const includedItems = new Set<string>();
  const material = (id: string): Material | undefined => {
    if (materialCache.has(id)) return materialCache.get(id);
    const found = sources.findMaterial(id, request.scope);
    const scoped =
      found?.source.scope === request.scope && found.source.id === id
        ? found
        : undefined;
    materialCache.set(id, scoped);
    return scoped;
  };
  const references = (
    refs: KnowledgeItem["sourceRefs"],
  ): Material[] | undefined => {
    const required: Material[] = [];
    for (const ref of refs) {
      const found = material(ref.sourceId);
      if (
        !found ||
        (ref.quote !== undefined && !found.source.text.includes(ref.quote))
      )
        return undefined;
      if (!includedSources.has(ref.sourceId)) required.push(found);
    }
    return required;
  };
  const accept = (
    candidate: ProjectContext,
    addedSources: Material[],
  ): boolean => {
    if (!fits(candidate, request.maxBytes)) {
      context.truncated = true;
      return false;
    }
    context = candidate;
    for (const entry of addedSources) includedSources.add(entry.source.id);
    return true;
  };

  // Fixed scan bounds avoid an unbounded traversal when a project has a large history.
  // A saturated scan reports possible truncation even if its exact total is unknown.
  const candidates = knowledge.list(request.scope, 100);
  if (candidates.length === 100) context.truncated = true;
  for (const item of candidates) {
    if (context.items.length >= request.limit) {
      context.truncated = true;
      break;
    }
    if (item.scope !== request.scope) {
      context.truncated = true;
      continue;
    }
    const required = references(item.sourceRefs);
    if (!required) {
      context.truncated = true;
      continue;
    }
    if (
      accept(
        {
          ...context,
          items: [...context.items, item],
          sources: [...context.sources, ...required],
        },
        required,
      )
    ) {
      includedItems.add(item.id);
    }
  }

  const recent = sources.list(request.scope, 20);
  if (recent.length === 20) context.truncated = true;
  let standaloneSources = 0;
  for (const source of recent) {
    if (includedSources.has(source.id)) continue;
    if (standaloneSources >= request.limit) {
      context.truncated = true;
      break;
    }
    const found = material(source.id);
    if (!found) {
      context.truncated = true;
      continue;
    }
    if (accept({ ...context, sources: [...context.sources, found] }, [found]))
      standaloneSources++;
  }

  const relationCandidates = knowledge.relations(request.scope, 100);
  if (relationCandidates.length === 100) context.truncated = true;
  for (const relation of relationCandidates) {
    if (context.relations.length >= request.limit) {
      context.truncated = true;
      break;
    }
    if (
      relation.scope !== request.scope ||
      !includedItems.has(relation.fromId) ||
      !includedItems.has(relation.toId)
    ) {
      context.truncated = true;
      continue;
    }
    const required = references(relation.sourceRefs);
    if (!required) {
      context.truncated = true;
      continue;
    }
    accept(
      {
        ...context,
        relations: [...context.relations, relation],
        sources: [...context.sources, ...required],
      },
      required,
    );
  }
  return context;
}
