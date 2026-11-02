import type { z } from "zod";
import type { SemanticHits } from "./embedding-index.js";
import type {
  KnowledgeItem,
  KnowledgeRelation,
  KnowledgeStore,
} from "./knowledge.js";
import type { Material } from "./materials.js";
import { contextPackageSchema, questionTerms } from "./package-query.js";
import type { SourceStore } from "./store.js";

// Offsets are UTF-16 code units into the immutable text; avoid splitting emoji pairs.
export function excerpt(text: string, matchOffset = 0, maximum = 360) {
  let start = Math.max(0, matchOffset - 80);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? "")) start--;
  let end = Math.min(text.length, start + maximum);
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end] ?? "")) end--;
  return {
    text: text.slice(start, end),
    start,
    end,
    truncated: start > 0 || end < text.length,
  };
}
function sourceCard(m: Material, matchOffset = 0, supersededBy?: string) {
  return {
    id: m.source.id,
    ...(supersededBy ? { supersededBy } : {}),
    checksum: m.source.checksum,
    origin: m.source.origin,
    status: m.source.status,
    capturedAt: m.source.capturedAt,
    sourceDate: m.metadata.createdAt ?? m.source.capturedAt,
    excerpt: excerpt(m.source.text, matchOffset),
  };
}
function itemCard(k: KnowledgeItem, matchOffset = 0, supersededBy?: string) {
  return {
    id: k.id,
    ...(supersededBy ? { supersededBy } : {}),
    kind: k.kind,
    status: k.status,
    createdAt: k.createdAt,
    creator: k.creator,
    excerpt: excerpt(k.text, matchOffset, 480),
    sourceIds: k.sourceRefs.map((r) => r.sourceId),
  };
}
function relationCard(r: KnowledgeRelation) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    fromId: r.fromId,
    toId: r.toId,
    createdAt: r.createdAt,
    sourceIds: r.sourceRefs.map((s) => s.sourceId),
  };
}
export interface ContextPackage {
  version: 1;
  scope: string;
  mode: "search" | "timeline";
  dateBasis: "source_created_at_else_captured_at";
  sources: ReturnType<typeof sourceCard>[];
  items: ReturnType<typeof itemCard>[];
  relations: ReturnType<typeof relationCard>[];
  coverage: {
    sourceMatches: number;
    knowledgeMatches: number;
    candidateLimit: number;
    reasons: string[];
    exhaustive: false;
  };
  truncated: boolean;
  readMore: {
    sources: "read_material";
    items: "read_knowledge";
    relations: "read_relations";
    arguments: "version=1, scope=this scope, id=selected ID (relations: list by scope)";
  };
}

// One authorized scope only. Retrieval and counts happen after the MCP access check.
export function buildContextPackage(
  sources: SourceStore,
  knowledge: KnowledgeStore,
  input: z.input<typeof contextPackageSchema>,
  semantic?: SemanticHits,
): ContextPackage {
  const request = contextPackageSchema.parse(input);
  const terms =
    request.mode === "timeline" ? [] : questionTerms(request.question);
  const selection = {
    scope: request.scope,
    terms,
    limit: 101,
    ...(request.from ? { from: request.from } : {}),
    ...(request.until ? { until: request.until } : {}),
  };
  const original = sources.packageCandidates({
    ...selection,
    ...(semantic ? { vectors: semantic.sources } : {}),
  });
  const derived = knowledge.packageCandidates(
    { ...selection, ...(semantic ? { vectors: semantic.items } : {}) },
    original.materials.slice(0, 100).map((m) => m.source.id),
  );
  const state = knowledge.retrievalRelations(request.scope);
  let result: ContextPackage = {
    version: 1,
    scope: request.scope,
    mode: request.mode,
    dateBasis: "source_created_at_else_captured_at",
    sources: [],
    items: [],
    relations: [],
    coverage: {
      sourceMatches: original.total,
      knowledgeMatches: derived.total,
      candidateLimit: 100,
      reasons: [],
      exhaustive: false,
    },
    truncated: false,
    readMore: {
      sources: "read_material",
      items: "read_knowledge",
      relations: "read_relations",
      arguments:
        "version=1, scope=this scope, id=selected ID (relations: list by scope)",
    },
  };
  const reasons = new Set<string>(semantic?.reasons);
  if (original.total > 100 || derived.total > 100)
    reasons.add("candidate_limit");
  if (request.mode === "timeline" && original.total > 100)
    reasons.add("knowledge_limited_to_source_candidates");
  const materialCache = new Map<string, Material | undefined>();
  const material = (id: string) => {
    if (!materialCache.has(id))
      materialCache.set(id, sources.findMaterial(id, request.scope));
    return materialCache.get(id);
  };
  const eligible = (m: Material) => {
    const date = Date.parse(m.metadata.createdAt ?? m.source.capturedAt);
    return (
      m.source.scope === request.scope &&
      Number.isFinite(date) &&
      (!request.from || date >= Date.parse(request.from)) &&
      (!request.until || date < Date.parse(request.until))
    );
  };
  const references = (refs: KnowledgeItem["sourceRefs"]) => {
    const found: Material[] = [];
    for (const ref of refs) {
      const m = material(ref.sourceId);
      if (
        !m ||
        m.source.id !== ref.sourceId ||
        m.source.scope !== request.scope ||
        (ref.quote !== undefined && !m.source.text.includes(ref.quote))
      ) {
        reasons.add("invalid_provenance");
        return undefined;
      }
      if (!eligible(m)) {
        reasons.add("outside_period");
        return undefined;
      }
      found.push(m);
    }
    return found;
  };
  const validItem = (item: KnowledgeItem) =>
    item.scope === request.scope && item.status !== "rejected";
  const add = (
    ms: Material[],
    ks: KnowledgeItem[] = [],
    rs: KnowledgeRelation[] = [],
  ) => {
    ms = ms.map((m) => {
      const canonical = material(state.canonical(m.source.id));
      return canonical && eligible(canonical) ? canonical : m;
    });
    ks = ks.map((k) => {
      const canonical = knowledge.find(state.canonical(k.id), request.scope);
      return canonical &&
        validItem(canonical) &&
        references(canonical.sourceRefs)
        ? canonical
        : k;
    });
    const newSources = ms.filter(
      (m, i) =>
        !result.sources.some((s) => s.id === m.source.id) &&
        ms.findIndex((x) => x.source.id === m.source.id) === i,
    );
    const newItems = ks.filter(
      (k, i) =>
        !result.items.some((x) => x.id === k.id) &&
        ks.findIndex((x) => x.id === k.id) === i,
    );
    if (
      result.sources.length + newSources.length > request.limit ||
      result.items.length + newItems.length > request.limit ||
      result.relations.length + rs.length > request.limit
    ) {
      reasons.add("entry_limit");
      return false;
    }
    const candidate = {
      ...result,
      sources: [
        ...result.sources,
        ...newSources.map((m) =>
          sourceCard(
            m,
            original.matchOffsets.get(m.source.id),
            state.superseded.get(m.source.id),
          ),
        ),
      ],
      items: [
        ...result.items,
        ...newItems.map((k) =>
          itemCard(
            k,
            derived.matchOffsets.get(k.id),
            state.superseded.get(k.id),
          ),
        ),
      ],
      relations: [...result.relations, ...rs.map(relationCard)],
    };
    // Reserve space for every bounded coverage reason before accepting a bundle.
    const reserve = {
      ...candidate,
      truncated: true,
      coverage: {
        ...candidate.coverage,
        reasons: [
          "candidate_limit",
          "knowledge_limited_to_source_candidates",
          "invalid_provenance",
          "outside_period",
          "entry_limit",
          "byte_limit",
          "relation_limit",
          "embeddings_pending",
          "embeddings_unavailable",
          "vector_scan_limit",
        ],
      },
    };
    if (Buffer.byteLength(JSON.stringify(reserve), "utf8") > request.maxBytes) {
      reasons.add("byte_limit");
      return false;
    }
    result = candidate;
    return true;
  };
  // Interleave the independently ranked lists; raw BM25 scores are not comparable across indexes.
  const candidates: Array<{
    source?: Material;
    item?: KnowledgeItem;
    rank: number;
  }> = [];
  original.materials.slice(0, 100).forEach((source, i) => {
    candidates.push({ source, rank: i * 2 + 1 });
  });
  derived.items.slice(0, 100).forEach((item, i) => {
    candidates.push({ item, rank: i * 2 });
  });
  // Substitute a readable canonical even when only its copy matched.
  for (const candidate of candidates) {
    const id = candidate.source?.source.id ?? candidate.item?.id;
    if (!id) continue;
    const canonical = state.canonical(id);
    if (canonical !== id) {
      const source = material(canonical);
      const item = knowledge.find(canonical, request.scope);
      if (source && eligible(source)) {
        delete candidate.item;
        candidate.source = source;
      } else if (item && validItem(item) && references(item.sourceRefs)) {
        delete candidate.source;
        candidate.item = item;
      }
    }
  }
  const historical = (c: (typeof candidates)[number]) =>
    Number(
      state.superseded.has(c.source?.source.id ?? c.item?.id ?? "") ||
        !!c.item?.sourceRefs.some((r) => state.superseded.has(r.sourceId)),
    );
  for (const candidate of candidates.sort(
    (a, b) => historical(a) - historical(b) || a.rank - b.rank,
  )) {
    if (candidate.source) {
      if (eligible(candidate.source)) add([candidate.source]);
      continue;
    }
    const item = candidate.item;
    if (!item || !validItem(item)) continue;
    const refs = references(item.sourceRefs);
    if (refs) add(refs, [item]);
  }
  // Expand only the included search/timeline seeds, never recursively traverse the graph.
  const links = knowledge.packageRelations(request.scope, [
    ...result.items.map((k) => k.id),
    ...result.sources.map((s) => s.id),
  ]);
  if (links.length > 50) reasons.add("relation_limit");
  for (const link of links.slice(0, 50)) {
    if (link.scope !== request.scope) continue;
    const endpointItems = [link.fromId, link.toId].flatMap((id) => {
      const item = knowledge.find(id, request.scope);
      return item ? [item] : [];
    });
    const endpointSources = [link.fromId, link.toId].flatMap((id) => {
      const source = material(id);
      return source ? [source] : [];
    });
    if (
      endpointItems.length + endpointSources.length !== 2 ||
      endpointItems.some((k) => !validItem(k))
    )
      continue;
    const refs = references([
      ...endpointItems.flatMap((k) => k.sourceRefs),
      ...link.sourceRefs,
    ]);
    if (refs && endpointSources.every(eligible))
      add([...refs, ...endpointSources], endpointItems, [link]);
  }
  result.sources.sort(
    (a, b) => Number(!!a.supersededBy) - Number(!!b.supersededBy),
  );
  result.items.sort(
    (a, b) => Number(!!a.supersededBy) - Number(!!b.supersededBy),
  );
  result.coverage.reasons = [...reasons];
  result.truncated = reasons.size > 0;
  return result;
}
