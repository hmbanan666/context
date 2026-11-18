import type { z } from "zod";
import type { DocType } from "./documents.js";
import type { SemanticHits } from "./embedding-index.js";
import {
  bestCosine,
  explainStoredGrounding,
  groundingHeading,
  passageVectors,
  type Grounding,
  type GroundingPassage,
  type GroundingReport,
} from "./grounding.js";
import {
  datedJournalExcerpt,
  datedJournalExcerptFloor,
  journalExcerpt,
  undatedJournalExcerpt,
} from "./journal.js";
import type {
  KnowledgeItem,
  KnowledgeRelation,
  KnowledgeStore,
} from "./knowledge.js";
import type { Material } from "./materials.js";
import { contextPackageSchema, questionTerms } from "./package-query.js";
import { conceptCoverage } from "./search-lexical.js";
import {
  cardFloorTerms,
  idsWithinCardFloor,
  readCardFloor,
} from "./search-when-none.js";
import { addPhase, type SearchPhases } from "./search-timing.js";
import { visibleSourceText } from "./source-text.js";
import type { SourceStore } from "./store.js";

// Offsets are UTF-16 code units into the indexed text; avoid splitting emoji pairs.
// Source excerpts use the visible text so a stored PR footer is not the excerpt.
const sentenceGaps = [". ", "! ", "? ", "… "] as const;
const sentenceMarks = ["。", "！", "？", "…"] as const;

function boundaryAt(text: string, offset: number): number {
  const at = Math.min(Math.max(0, offset), text.length);
  const head = text.slice(0, at);
  let start = 0;
  const take = (index: number, length: number) => {
    const next = index + length;
    if (next > start && next <= at) start = next;
  };
  for (const mark of sentenceGaps) {
    const index = head.lastIndexOf(mark);
    if (index >= 0) take(index, mark.length);
  }
  for (const mark of sentenceMarks) {
    const index = head.lastIndexOf(mark);
    if (index >= 0) take(index, mark.length);
  }
  const line = head.lastIndexOf("\n");
  if (line >= 0) take(line, 1);
  while (start < at && /[ \t]/u.test(text[start] ?? "")) start++;
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? "")) start--;
  return start;
}

function endOnSentence(
  text: string,
  start: number,
  hardEnd: number,
  offset: number,
): number {
  if (hardEnd >= text.length) return text.length;
  const window = text.slice(start, hardEnd);
  let cut = -1;
  for (const mark of sentenceGaps) {
    const index = window.lastIndexOf(mark);
    if (index >= 0 && index + 1 > cut) cut = index + 1;
  }
  for (const mark of sentenceMarks) {
    const index = window.lastIndexOf(mark);
    if (index >= 0 && index + mark.length > cut) cut = index + mark.length;
  }
  if (cut > 0 && start + cut > offset) return start + cut;
  let end = hardEnd;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end] ?? "")) end--;
  return end;
}

interface TextSpan {
  start: number;
  end: number;
}

function scriptCounts(text: string): { cyr: number; lat: number } {
  let cyr = 0;
  let lat = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x0400 && code <= 0x04ff) cyr++;
    else if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x00c0 && code <= 0x024f)
    )
      lat++;
  }
  return { cyr, lat };
}

function questionScript(question: string): "cyr" | "lat" | undefined {
  const { cyr, lat } = scriptCounts(question);
  if (cyr === lat) return undefined;
  return cyr > lat ? "cyr" : "lat";
}

function pushSpan(
  spans: TextSpan[],
  text: string,
  start: number,
  end: number,
): void {
  let from = start;
  let to = end;
  while (from < to && (text.charCodeAt(from) ?? 0) <= 32) from++;
  while (to > from && (text.charCodeAt(to - 1) ?? 0) <= 32) to--;
  if (to - from >= 16) spans.push({ start: from, end: to });
}

/** Paragraphs, lines and sentences, so a language switch can be either. */
function languageSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  const emit = (start: number, end: number) => {
    pushSpan(spans, text, start, end);
    let line = start;
    for (let i = start; i <= end; i++) {
      if (i === end || text[i] === "\n") {
        pushSpan(spans, text, line, i);
        line = i + 1;
      }
    }
    let sentence = start;
    for (let i = start; i < end; i++) {
      const ch = text[i] ?? "";
      if (
        ch !== "\n" &&
        ch !== "." &&
        ch !== "!" &&
        ch !== "?" &&
        ch !== "…" &&
        ch !== "。" &&
        ch !== "！" &&
        ch !== "？"
      )
        continue;
      let stop = i + 1;
      while (stop < end && (text[stop] === " " || text[stop] === "\t")) stop++;
      pushSpan(spans, text, sentence, stop);
      sentence = stop;
      i = stop - 1;
    }
    pushSpan(spans, text, sentence, end);
  };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n" || text[i + 1] !== "\n") continue;
    emit(start, i);
    let next = i + 2;
    while (
      next < text.length &&
      (text[next] === "\n" ||
        text[next] === " " ||
        text[next] === "\t" ||
        text[next] === "\r")
    )
      next++;
    start = next;
    i = next - 1;
  }
  emit(start, text.length);
  return spans;
}

/**
 * When the question is mostly one script and the note has a real run of that
 * script plus the other, prefer that run. A one-script note returns undefined
 * so the match anchor stays.
 */
function languageRegion(
  text: string,
  question: string | undefined,
  matchOffset: number,
): TextSpan | undefined {
  if (!question) return undefined;
  const script = questionScript(question);
  if (!script) return undefined;
  const whole = scriptCounts(text);
  const wanted = script === "cyr" ? whole.cyr : whole.lat;
  const other = script === "cyr" ? whole.lat : whole.cyr;
  if (wanted < 12 || other < 12) return undefined;
  const letters = wanted + other;
  if (wanted / letters < 0.15 || other / letters < 0.15) return undefined;
  let containing: TextSpan | undefined;
  let containingLength = -1;
  let richest: TextSpan | undefined;
  let richestLetters = -1;
  for (const span of languageSpans(text)) {
    const counts = scriptCounts(text.slice(span.start, span.end));
    const spanWanted = script === "cyr" ? counts.cyr : counts.lat;
    const spanOther = script === "cyr" ? counts.lat : counts.cyr;
    const spanLetters = spanWanted + spanOther;
    if (spanWanted < 12 || spanLetters === 0) continue;
    if (spanWanted <= spanOther || spanWanted / spanLetters < 0.6) continue;
    if (
      matchOffset >= span.start &&
      matchOffset < span.end &&
      span.end - span.start > containingLength
    ) {
      containing = span;
      containingLength = span.end - span.start;
    }
    if (
      !richest ||
      spanWanted > richestLetters ||
      (spanWanted === richestLetters && span.start < richest.start)
    ) {
      richest = span;
      richestLetters = spanWanted;
    }
  }
  return containing ?? richest;
}

/**
 * Knowledge cards open on a sentence or item boundary and lose text only at
 * the end, on a whole sentence when one fits in the budget.
 */
export function knowledgeExcerpt(
  text: string,
  matchOffset = 0,
  maximum = 480,
  question?: string,
) {
  const visible = visibleSourceText(text);
  const offset = Math.min(Math.max(0, matchOffset), visible.length);
  const region = languageRegion(visible, question, offset);
  const anchor =
    region && (offset < region.start || offset >= region.end)
      ? region.start
      : offset;
  let start = boundaryAt(visible, anchor);
  if (region && start < region.start) start = region.start;
  const ceiling = region?.end ?? visible.length;
  const hardEnd = Math.min(ceiling, start + maximum);
  const end = endOnSentence(visible, start, hardEnd, anchor);
  return {
    text: visible.slice(start, end),
    start,
    end,
    truncated: start > 0 || end < visible.length,
  };
}

function snapWordStart(text: string, start: number, offset: number): number {
  if (start <= 0) return 0;
  const previous = text[start - 1] ?? "";
  if (/[\s.!?…。！？]/u.test(previous)) return start;
  let index = start;
  while (index < offset && !/\s/u.test(text[index] ?? "")) index += 1;
  if (index >= offset) return start;
  while (index < offset && /\s/u.test(text[index] ?? "")) index += 1;
  if (/[\uDC00-\uDFFF]/u.test(text[index] ?? "")) index -= 1;
  return Math.max(0, index);
}

function snapWordEnd(
  text: string,
  start: number,
  hardEnd: number,
  offset: number,
): number {
  if (hardEnd >= text.length) return text.length;
  const sentence = endOnSentence(text, start, hardEnd, offset);
  if (sentence > offset && sentence < hardEnd) return sentence;
  let end = hardEnd;
  const window = text.slice(Math.min(offset, hardEnd), hardEnd);
  let best = -1;
  for (const mark of [" ", "\n", "\t"]) {
    const index = window.lastIndexOf(mark);
    if (index > best) best = index;
  }
  if (best > 0) end = Math.min(offset, hardEnd) + best;
  if (end <= offset) end = hardEnd;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end] ?? "")) end -= 1;
  return end;
}

export function excerpt(
  text: string,
  matchOffset = 0,
  maximum = 360,
  question?: string,
) {
  const visible = visibleSourceText(text);
  const offset =
    visible === text
      ? matchOffset
      : Math.min(Math.max(0, matchOffset), visible.length);
  const bounded = Math.min(Math.max(0, offset), visible.length);
  const region = languageRegion(visible, question, bounded);
  const anchor =
    region && (bounded < region.start || bounded >= region.end)
      ? region.start
      : offset;
  const floor = region?.start ?? 0;
  const ceiling = region?.end ?? visible.length;
  let start = Math.max(floor, anchor - 80);
  if (start > floor && /[\uDC00-\uDFFF]/u.test(visible[start] ?? "")) start--;
  if (start < floor) start = floor;
  start = snapWordStart(visible, start, Math.min(anchor, visible.length));
  if (start < floor) start = floor;
  let end = Math.min(ceiling, start + maximum);
  if (end < ceiling && /[\uDC00-\uDFFF]/u.test(visible[end] ?? "")) end--;
  end = snapWordEnd(visible, start, end, Math.min(anchor, visible.length));
  if (end > ceiling) end = ceiling;
  return {
    text: visible.slice(start, end),
    start,
    end,
    truncated: start > 0 || end < visible.length,
  };
}
function sourceCard(
  m: Material,
  matchOffset = 0,
  supersededBy?: string,
  question?: string,
) {
  return {
    id: m.source.id,
    ...(supersededBy ? { supersededBy } : {}),
    checksum: m.source.checksum,
    origin: m.source.origin,
    status: m.source.status,
    capturedAt: m.source.capturedAt,
    sourceDate: m.metadata.createdAt ?? m.source.capturedAt,
    excerpt: excerpt(m.source.text, matchOffset, 360, question),
    ...(m.doc
      ? {
          doc: {
            type: m.doc.type,
            key: m.doc.key,
            title: m.doc.title,
            status: m.doc.status,
            revision: m.doc.revision,
            setBy: m.doc.setBy,
            projectId: m.doc.projectId,
          },
        }
      : {}),
  };
}
function leadingKind(kind: KnowledgeItem["kind"]) {
  return kind === "fact" || kind === "decision" || kind === "journal";
}
function itemCard(
  k: KnowledgeItem,
  matchOffset = 0,
  supersededBy?: string,
  sourceLinks?: { id: string; url?: string }[],
  citedIds?: readonly string[],
  journalMaximum = datedJournalExcerpt,
) {
  return {
    id: k.id,
    ...(supersededBy ? { supersededBy } : {}),
    kind: k.kind,
    status: k.status,
    createdAt: k.createdAt,
    creator: k.creator,
    excerpt:
      k.kind === "journal"
        ? journalExcerpt(k.text, journalMaximum)
        : knowledgeExcerpt(k.text, matchOffset, 480),
    sourceIds: k.sourceRefs.map((r) => r.sourceId),
    ...(sourceLinks ? { sourceLinks } : {}),
    ...(citedIds?.length ? { citedIds: [...citedIds] } : {}),
  };
}
// Worst-case coverage strings reserved before a bundle is accepted, so adding
// a reason later cannot push the package over maxBytes.
const budgetReasonList = [
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
] as const;

function budgetReasons(journalsTruncated: boolean): string[] {
  return journalsTruncated
    ? [...budgetReasonList, "journals_truncated"]
    : [...budgetReasonList];
}

/**
 * Largest shared excerpt cap at which every reserved journal still fits.
 * Full cards win. Otherwise the cap stays at or above the floor when that
 * still fits, and only then drops further so a week is not replaced by a
 * later shorter row.
 */
function chooseDatedJournalMaximum(
  fits: (maximum: number, journalsTruncated: boolean) => boolean,
): number {
  if (fits(datedJournalExcerpt, false)) return datedJournalExcerpt;
  const search = (low: number, high: number) => {
    let best = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (fits(mid, true)) {
        best = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    return best;
  };
  const aboveFloor = search(datedJournalExcerptFloor, datedJournalExcerpt - 1);
  if (aboveFloor !== -1) return aboveFloor;
  const belowFloor = search(1, datedJournalExcerptFloor - 1);
  return belowFloor === -1 ? datedJournalExcerptFloor : belowFloor;
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
  /** Present on search. Absolute evidence, not rank. */
  grounding?: Grounding;
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
  projectId?: string,
  documents?: { readonly type?: DocType },
  phases?: SearchPhases,
): ContextPackage {
  const request = contextPackageSchema.parse(input);
  const dated = request.from !== undefined || request.until !== undefined;
  const terms =
    request.mode === "timeline" ? [] : questionTerms(request.question);
  const expansion = terms.length ? sources.expandedTerms(terms, projectId) : [];
  const selection = {
    scope: request.scope,
    terms,
    limit: 101,
    ...(expansion.length ? { expansion } : {}),
    ...(request.from ? { from: request.from } : {}),
    ...(request.until ? { until: request.until } : {}),
    ...(projectId ? { projectId } : {}),
    ...(documents
      ? {
          documentsOnly: true,
          ...(documents.type ? { docType: documents.type } : {}),
        }
      : {}),
  };
  const retrievalStarted = performance.now();
  const original = sources.packageCandidates({
    ...selection,
    ...(semantic ? { vectors: semantic.sources } : {}),
  });
  const derived = knowledge.packageCandidates(
    { ...selection, ...(semantic ? { vectors: semantic.items } : {}) },
    original.materials.slice(0, 100).map((m) => m.source.id),
  );
  addPhase(phases, "retrievalMs", retrievalStarted);
  const groundingStarted = performance.now();
  const frequencyStarted = performance.now();
  const frequency =
    request.mode === "search"
      ? sources.documentFrequency(request.scope, terms, projectId, documents)
      : undefined;
  addPhase(phases, "frequencyMs", frequencyStarted);
  const passageStarted = performance.now();
  const passages: GroundingPassage[] = [];
  if (frequency) {
    const stored = semantic?.storedCosines?.([
      ...original.materials.map((material) => ({
        kind: "sources" as const,
        id: material.source.id,
      })),
      ...derived.items.map((item) => ({
        kind: "knowledge_items" as const,
        id: item.id,
      })),
    ]);
    for (const material of original.materials) {
      const vectors = passageVectors(
        material.source.id,
        semantic?.sources,
        stored,
      );
      const text = visibleSourceText(material.source.text);
      const heading = groundingHeading(
        material.doc?.title ?? material.metadata.title,
        text,
      );
      passages.push({
        text,
        ...(heading ? { heading } : {}),
        ...(vectors.length ? { vectors } : {}),
      });
    }
    for (const item of derived.items) {
      const vectors = passageVectors(item.id, semantic?.items, stored);
      passages.push({
        text: item.text,
        ...(vectors.length ? { vectors } : {}),
      });
    }
  }
  const explained = frequency
    ? explainStoredGrounding({
        terms,
        passages,
        documents: frequency.documents,
        documentFrequency: frequency.counts,
        vectorsAvailable: semantic?.available === true,
        unmatchedCosine: Math.max(
          bestCosine(semantic?.sources),
          bestCosine(semantic?.items),
        ),
        ...(semantic?.available === true
          ? { backgroundCosine: semantic.background ?? 0 }
          : {}),
        ...(projectId
          ? { protectedTerms: sources.projectIdentityTerms(projectId) }
          : {}),
      })
    : undefined;
  addPhase(phases, "passageMs", passageStarted);
  addPhase(phases, "groundingMs", groundingStarted);
  const grounding = explained?.label;
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
  const linked = (kind: "source" | "knowledge", id: string) =>
    projectId === undefined || sources.linkedToProject(kind, id, projectId);
  const eligible = (m: Material) => {
    const date = Date.parse(m.metadata.createdAt ?? m.source.capturedAt);
    return (
      m.source.scope === request.scope &&
      Number.isFinite(date) &&
      (!request.from || date >= Date.parse(request.from)) &&
      (!request.until || date < Date.parse(request.until)) &&
      linked("source", m.source.id)
    );
  };
  const references = (refs: KnowledgeItem["sourceRefs"], dates = true) => {
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
      // A journal cites the week's sources. The week overlap is already applied;
      // a source dated earlier in that week must not drop the paragraph.
      if (dates && !eligible(m)) {
        reasons.add("outside_period");
        return undefined;
      }
      found.push(m);
    }
    return found;
  };
  const validItem = (item: KnowledgeItem) =>
    item.scope === request.scope &&
    item.status !== "rejected" &&
    linked("knowledge", item.id);
  // Sources cited by a distilled item that was actually returned.
  const citedSources = new Set<string>();
  let journalMaximum = dated ? datedJournalExcerpt : undatedJournalExcerpt;
  const knowledgeCard = (k: KnowledgeItem, maximum = journalMaximum) =>
    itemCard(
      k,
      derived.matchOffsets.get(k.id),
      state.superseded.get(k.id),
      projectId !== undefined && leadingKind(k.kind)
        ? k.sourceRefs.map((ref) => {
            const url = material(ref.sourceId)?.metadata.sourceUri;
            return url ? { id: ref.sourceId, url } : { id: ref.sourceId };
          })
        : undefined,
      k.kind === "journal"
        ? knowledge.journalCitations(k.id)?.citedIds
        : undefined,
      maximum,
    );
  let topHit: { id: string; title: string } | undefined;
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
        references(canonical.sourceRefs, canonical.kind !== "journal")
        ? canonical
        : k;
    });
    if (projectId !== undefined) {
      ms = ms.filter(
        (m) => linked("source", m.source.id) && !citedSources.has(m.source.id),
      );
      ks = ks.filter((k) => linked("knowledge", k.id));
      rs = rs.filter((r) =>
        [r.fromId, r.toId].every(
          (id) => linked("source", id) || linked("knowledge", id),
        ),
      );
      if (ms.length + ks.length === 0) return false;
    }
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
            request.question,
          ),
        ),
      ],
      items: [...result.items, ...newItems.map((k) => knowledgeCard(k))],
      relations: [...result.relations, ...rs.map(relationCard)],
    };
    // Reserve space for every bounded coverage reason before accepting a bundle.
    const reserve = {
      ...candidate,
      truncated: true,
      coverage: {
        ...candidate.coverage,
        reasons: budgetReasons(reasons.has("journals_truncated")),
      },
    };
    if (Buffer.byteLength(JSON.stringify(reserve), "utf8") > request.maxBytes) {
      reasons.add("byte_limit");
      return false;
    }
    if (!topHit) {
      const source = newSources[0];
      const item = newItems[0];
      if (source)
        topHit = {
          id: source.source.id,
          title: source.doc?.title ?? source.metadata.title ?? "",
        };
      else if (item) topHit = { id: item.id, title: "" };
    }
    result = candidate;
    return true;
  };
  // Interleave the independently ranked lists; raw BM25 scores are not comparable across indexes.
  // Project search order is already applied: one hybrid list without dates.
  // With since or until, journals are chronological and uncapped, then
  // decisions, then facts. Dated journals are reserved first and shortened
  // together when the full cards do not fit. Raw sources follow those rows.
  const candidates: Array<{
    source?: Material;
    item?: KnowledgeItem;
    rank: number;
    tier: number;
  }> = [];
  // Below the margin corpus floor, reciprocal-rank scores barely separate a
  // real hit from a neighbour that shares one word. Drop source cards far
  // below the best match. Larger corpora keep every hit.
  const cardFloor = readCardFloor(process.env);
  const floorHits = new Map<string, { concepts: number }>();
  if (explained && frequency) {
    const distinctive = cardFloorTerms(
      terms,
      frequency.counts,
      explained.documents,
    );
    for (const material of original.materials) {
      const text = visibleSourceText(material.source.text);
      const heading = groundingHeading(
        material.doc?.title ?? material.metadata.title,
        text,
      );
      floorHits.set(material.source.id, {
        concepts: conceptCoverage(
          heading ? `${heading}\n${text}` : text,
          distinctive,
        ).concepts,
      });
    }
  }
  // No distinctive term means every hit is tied on words. Rank and document
  // status must not then drop a card: an accepted ADR is scored one point
  // higher, and a superseded one is halved.
  const distinctiveHit = [...floorHits.values()].some(
    (hit) => hit.concepts > 0,
  );
  const sourceKeep =
    explained &&
    explained.documents < explained.thresholds.marginMinCorpus &&
    cardFloor > 0 &&
    distinctiveHit
      ? idsWithinCardFloor(
          original.materials.map((material) => material.source.id),
          original.scores,
          floorHits,
          cardFloor,
        )
      : undefined;
  const keepSource = (id: string) => sourceKeep?.has(id) !== false;
  if (projectId === undefined) {
    original.materials.slice(0, 100).forEach((source, i) => {
      if (!keepSource(source.source.id)) return;
      candidates.push({ source, rank: i * 2 + 1, tier: 0 });
    });
    derived.items.slice(0, 100).forEach((item, i) => {
      candidates.push({ item, rank: i * 2, tier: 0 });
    });
  } else {
    let leadingRank = 0;
    let restRank = 0;
    for (const item of derived.items.slice(0, 100)) {
      if (leadingKind(item.kind))
        candidates.push({ item, rank: leadingRank++, tier: 0 });
      else candidates.push({ item, rank: restRank++, tier: 1 });
    }
    original.materials.slice(0, 100).forEach((source, i) => {
      if (!keepSource(source.source.id)) return;
      candidates.push({ source, rank: i, tier: 1 });
    });
  }
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
  const ordered = candidates.sort(
    (a, b) =>
      historical(a) - historical(b) || a.tier - b.tier || a.rank - b.rank,
  );
  const placedJournals = new Set<string>();
  // A dated journal that does not fit must not leave its bytes to a later
  // shorter decision, fact, or week.
  let holdForJournals = false;
  if (dated && projectId !== undefined && request.mode === "search") {
    const leading: { item: KnowledgeItem; refs: Material[] }[] = [];
    for (const candidate of ordered) {
      const item = candidate.item;
      if (!item || item.kind !== "journal") break;
      if (!validItem(item)) continue;
      const refs = references(item.sourceRefs, false);
      if (!refs) continue;
      leading.push({ item, refs });
    }
    const reserved = leading.slice(0, request.limit);
    if (reserved.length > 0) {
      const fits = (maximum: number, journalsTruncated: boolean) => {
        const probe = {
          ...result,
          items: [
            ...result.items,
            ...reserved.map(({ item }) => knowledgeCard(item, maximum)),
          ],
          truncated: true,
          coverage: {
            ...result.coverage,
            reasons: budgetReasons(journalsTruncated),
          },
        };
        return (
          Buffer.byteLength(JSON.stringify(probe), "utf8") <= request.maxBytes
        );
      };
      const maximum = chooseDatedJournalMaximum(fits);
      journalMaximum = maximum;
      const shortened = reserved.some(({ item }) => {
        const full = journalExcerpt(item.text, datedJournalExcerpt).text;
        return journalExcerpt(item.text, maximum).text.length < full.length;
      });
      if (shortened) reasons.add("journals_truncated");
      for (const { item, refs } of reserved) {
        if (!add([], [item])) {
          holdForJournals = true;
          break;
        }
        placedJournals.add(item.id);
        for (const source of refs) citedSources.add(source.source.id);
      }
      if (reserved.some(({ item }) => !placedJournals.has(item.id)))
        holdForJournals = true;
    }
  }
  for (const candidate of ordered) {
    if (holdForJournals) break;
    if (candidate.item && placedJournals.has(candidate.item.id)) continue;
    if (candidate.source) {
      if (citedSources.has(candidate.source.source.id)) continue;
      if (eligible(candidate.source)) add([candidate.source]);
      continue;
    }
    const item = candidate.item;
    if (!item || !validItem(item)) continue;
    const refs = references(item.sourceRefs, item.kind !== "journal");
    if (!refs) continue;
    const prefer = projectId !== undefined && leadingKind(item.kind);
    if (add(prefer ? [] : refs, [item]) && prefer)
      for (const source of refs) citedSources.add(source.source.id);
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
    if (refs && endpointSources.every(eligible) && !holdForJournals)
      add([...refs, ...endpointSources], endpointItems, [link]);
  }
  result.sources.sort(
    (a, b) => Number(!!a.supersededBy) - Number(!!b.supersededBy),
  );
  result.items.sort(
    (a, b) => Number(!!a.supersededBy) - Number(!!b.supersededBy),
  );
  if (projectId !== undefined) {
    const cited = new Set(
      result.items
        .filter((item) => leadingKind(item.kind))
        .flatMap((item) => item.sourceIds),
    );
    result.sources = result.sources.filter((source) => !cited.has(source.id));
  }
  result.coverage.reasons = [...reasons];
  result.truncated = reasons.size > 0;
  // Outside the evidence budget: a few dozen bytes must not drop a card.
  if (grounding) result.grounding = grounding;
  const finish = (pack: ContextPackage) => {
    if (explained) groundingReports.set(pack, explained);
    if (topHit) groundingTopHits.set(pack, topHit);
    return pack;
  };
  if (projectId === undefined) return finish(result);
  // Serialise distilled items before raw excerpts for the caller.
  return finish({
    version: result.version,
    scope: result.scope,
    mode: result.mode,
    ...(result.grounding ? { grounding: result.grounding } : {}),
    dateBasis: result.dateBasis,
    items: result.items,
    sources: result.sources,
    relations: result.relations,
    coverage: result.coverage,
    truncated: result.truncated,
    readMore: result.readMore,
  });
}

const groundingReports = new WeakMap<ContextPackage, GroundingReport>();
const groundingTopHits = new WeakMap<
  ContextPackage,
  { id: string; title: string }
>();

/** Features from the same passage scoring that set `pack.grounding`. */
export function searchGroundingReport(
  pack: ContextPackage,
): GroundingReport | undefined {
  return groundingReports.get(pack);
}

/** First card `search` accepted, with a stored title when the source has one. */
export function searchTopHit(
  pack: ContextPackage,
): { id: string; title: string } | undefined {
  return groundingTopHits.get(pack);
}
