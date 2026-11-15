import type { SemanticHits } from "./embedding-index.js";
import { knowledgeExcerpt } from "./context-package.js";
import type { GlossaryEntry } from "./glossary.js";
import type { KnowledgeItem, KnowledgeStore } from "./knowledge.js";
import type { Material } from "./materials.js";
import { questionTerms } from "./package-query.js";
import { profileId, type ProjectProfile } from "./projects.js";
import type { TermHit } from "./search-lexical.js";
import type { SourceStore } from "./store.js";

export const packBudgetMin = 512;
export const packBudgetMax = 65536;
export const packBudgetDefault = 8192;
export const packSourceShare = 0.25;
export const packJournalShare = 0.15;
export const packProfileShare = 0.2;
export const packApprovedBoost = 1.25;
export const packSourceLimit = 2;
export const packJournalLimit = 2;

const sections = [
  "profile",
  "decisions",
  "facts",
  "journals",
  "sources",
] as const;
type Section = (typeof sections)[number];
type Presence = "off" | "partial" | "full";
type Flags = Record<Section, Presence>;

interface PackExcerpt {
  text: string;
  truncated?: boolean;
}
interface PackItem {
  id: string;
  kind?: string;
  status?: string;
  createdAt?: string;
  excerpt: PackExcerpt;
  sourceIds: string[];
  sourceLinks?: { id: string; url?: string }[];
  pins?: { id: string }[];
  citedIds?: string[];
}
interface Ranked {
  id: string;
  status?: string;
  createdAt?: string;
}
interface PackSource {
  id: string;
  sourceDate: string;
  excerpt: ReturnType<typeof knowledgeExcerpt>;
}
export interface TaskPack {
  version: 1;
  scope: string;
  mode: "pack";
  project: string;
  header: string;
  items: PackItem[];
  sources: PackSource[];
  relations: [];
  coverage?: { reasons: string[] };
  truncated: boolean;
  budgetBytes: number;
  bytesUsed: number;
}

interface PackInput {
  scope: string;
  projectId: string;
  question: string;
  budgetBytes: number;
  semantic?: SemanticHits;
}

const off = (): Flags => ({
  profile: "off",
  decisions: "off",
  facts: "off",
  journals: "off",
  sources: "off",
});

export function packRelevance(
  score: number,
  status: string | undefined,
): number {
  return status === "approved" ? score * packApprovedBoost : score;
}

/** Hybrid score, then an approved boost, then recency. A missing score is below the floor. */
export function rankPackItems<T extends Ranked>(
  items: readonly T[],
  scores: ReadonlyMap<string, number>,
): T[] {
  return items
    .filter((item) => (scores.get(item.id) ?? 0) > 0)
    .sort((a, b) => {
      const delta =
        packRelevance(scores.get(b.id) ?? 0, b.status) -
        packRelevance(scores.get(a.id) ?? 0, a.status);
      if (delta !== 0) return delta;
      const recency = (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      if (recency) return recency;
      return a.id.localeCompare(b.id);
    });
}

function presence(included: number, eligible: number): Presence {
  if (included <= 0) return "off";
  if (included < eligible) return "partial";
  return "full";
}

/** Purpose, then rules, then pinned decisions that are still in force. */
export function profileSection(profile: ProjectProfile): string {
  return [
    profile.purpose,
    profile.rules,
    ...profile.inForce.map((item) => item.text),
  ].join("\n");
}

function glossaryPackLine(entries: readonly GlossaryEntry[]): string {
  return entries
    .map((entry) => `${entry.term}: ${entry.synonyms.join(", ")}`)
    .join("; ");
}

function trimGlossary(line: string, room: number): string {
  if (room <= 0 || !line) return "";
  if (Buffer.byteLength(line, "utf8") <= room) return line;
  const kept: string[] = [];
  for (const entry of line.split("; ")) {
    const next = kept.length ? `${kept.join("; ")}; ${entry}` : entry;
    if (Buffer.byteLength(next, "utf8") > room) break;
    kept.push(entry);
  }
  return kept.join("; ");
}

function fieldPrefix(field: string, room: number): string {
  if (room <= 0 || !field) return "";
  if (Buffer.byteLength(field, "utf8") <= room) return field;
  let chosen = "";
  for (const end of sentenceEnds(field)) {
    const slice = field.slice(0, end);
    if (Buffer.byteLength(slice, "utf8") <= room) chosen = slice;
    else break;
  }
  if (chosen) return chosen;
  const first = field.slice(0, sentenceEnds(field)[0] ?? field.length);
  return utf8Prefix(first, room);
}

/**
 * Pack rendering of a profile, capped at about 20% of the caller's budget.
 * Purpose, then rules, then pinned sentences, then a trimmed project glossary.
 * The stored profile is unchanged.
 */
export function renderPackProfile(
  profile: ProjectProfile,
  glossary: readonly GlossaryEntry[],
  budgetBytes: number,
): { text: string; partial: boolean; shownPins: string[] } {
  const cap = Math.max(1, Math.floor(budgetBytes * packProfileShare));
  const parts: string[] = [];
  const used = () => Buffer.byteLength(parts.join("\n"), "utf8");
  const room = () => cap - used() - (parts.length ? 1 : 0);
  const push = (text: string) => {
    if (!text || Buffer.byteLength(text, "utf8") > room()) return false;
    parts.push(text);
    return true;
  };
  if (profile.purpose && !push(profile.purpose)) {
    const prefix = fieldPrefix(profile.purpose, cap);
    if (prefix) parts.push(prefix);
    return { text: parts.join("\n"), partial: true, shownPins: [] };
  }
  let rulesPartial = false;
  if (profile.rules && !push(profile.rules)) {
    const prefix = fieldPrefix(profile.rules, room());
    if (prefix) parts.push(prefix);
    rulesPartial = true;
  }
  const shownPins: string[] = [];
  for (const pin of profile.inForce) {
    if (!push(pin.text)) break;
    shownPins.push(pin.id);
  }
  const glossaryText = glossaryPackLine(glossary);
  const glossaryOut = trimGlossary(glossaryText, room());
  if (glossaryOut) parts.push(glossaryOut);
  return {
    text: parts.join("\n"),
    partial:
      rulesPartial ||
      shownPins.length < profile.inForce.length ||
      (glossaryText !== "" && glossaryOut !== glossaryText),
    shownPins,
  };
}

/** Drop single-concept and vector-only rows once a two-concept hit exists. */
export function packFloor<T extends { id: string }>(
  items: readonly T[],
  hits: ReadonlyMap<string, TermHit>,
): T[] {
  const multi = items.some((item) => (hits.get(item.id)?.concepts ?? 0) >= 2);
  if (!multi) return [...items];
  return items.filter((item) => {
    const hit = hits.get(item.id);
    return !!hit && (hit.original || hit.concepts >= 2);
  });
}

function packHeader(flags: Flags): string {
  const included: string[] = [];
  const omitted: string[] = [];
  for (const section of sections) {
    const presence = flags[section];
    if (presence === "off") omitted.push(section);
    else if (presence === "partial") included.push(`${section} (partial)`);
    else included.push(section);
  }
  const present = included.length ? included.join(", ") : "none";
  return `Included: ${present}. Omitted: ${omitted.join(", ")}.`;
}

function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const mark = text[i];
    if (
      mark !== "." &&
      mark !== "!" &&
      mark !== "?" &&
      mark !== "…" &&
      mark !== "。" &&
      mark !== "！" &&
      mark !== "？"
    )
      continue;
    const next = text[i + 1];
    if (next === undefined || next === " " || next === "\n" || next === "\t")
      ends.push(i + 1);
  }
  return ends;
}

function utf8Prefix(text: string, maxBytes: number): string {
  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const mid = Math.ceil((low + high) / 2);
    let slice = text.slice(0, mid);
    if (slice && /[\uD800-\uDBFF]/u.test(slice.at(-1) ?? ""))
      slice = slice.slice(0, -1);
    if (slice && Buffer.byteLength(slice, "utf8") <= maxBytes) {
      best = slice;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best;
}

function memoryCard(
  item: KnowledgeItem,
  sources: SourceStore,
  scope: string,
): PackItem {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    createdAt: item.createdAt,
    excerpt: { text: item.text },
    sourceIds: item.sourceRefs.map((ref) => ref.sourceId),
    sourceLinks: item.sourceRefs.map((ref) => {
      const url = sources.findMaterial(ref.sourceId, scope)?.metadata.sourceUri;
      return url ? { id: ref.sourceId, url } : { id: ref.sourceId };
    }),
  };
}

function sourceDate(material: Material): string {
  return material.metadata.createdAt ?? material.source.capturedAt;
}

function sourceCard(material: Material, offset = 0): PackSource {
  return {
    id: material.source.id,
    sourceDate: sourceDate(material),
    excerpt: knowledgeExcerpt(material.source.text, offset),
  };
}

function journalCard(
  item: KnowledgeItem,
  sources: SourceStore,
  scope: string,
  citedIds: readonly string[] | undefined,
): PackItem {
  return {
    ...memoryCard(item, sources, scope),
    excerpt: { text: item.text },
    ...(citedIds?.length ? { citedIds: [...citedIds] } : {}),
  };
}

function profileCard(
  id: string,
  text: string,
  partial: boolean,
  pins: readonly { id: string }[],
): PackItem {
  return {
    id,
    kind: "profile",
    excerpt: partial ? { text, truncated: true } : { text },
    sourceIds: [],
    ...(pins.length ? { pins: pins.map((pin) => ({ id: pin.id })) } : {}),
  };
}

/**
 * One budgeted pack for a task. No processor call. Decisions and facts use the
 * hybrid project rank (FTS RU/EN plus embeddings). Recency breaks ties.
 * Unmatched rows are left out. A share of the budget is held for raw sources.
 */
export function buildTaskPack(
  sources: SourceStore,
  knowledge: KnowledgeStore,
  input: PackInput,
): TaskPack {
  if (
    !Number.isInteger(input.budgetBytes) ||
    input.budgetBytes < packBudgetMin ||
    input.budgetBytes > packBudgetMax
  )
    throw new Error("Invalid pack budget");
  const terms = questionTerms(input.question);
  const expansion = sources.expandedTerms(terms, input.projectId);
  const budget = input.budgetBytes;
  const profile = sources.profile(input.projectId);
  const loaded =
    profile && profile.homeArea === input.scope ? profile : undefined;
  const rendered = loaded
    ? renderPackProfile(
        loaded,
        sources.projectGlossary(input.projectId),
        budget,
      )
    : undefined;
  const section = rendered?.text ?? "";
  const shownPins = new Set(rendered?.shownPins ?? []);
  const pinSources = new Map<string, string[]>();
  for (const pin of loaded?.inForce ?? []) {
    const item = knowledge.find(pin.id, input.scope);
    pinSources.set(pin.text, item?.sourceRefs.map((ref) => ref.sourceId) ?? []);
  }
  const superseded = knowledge.retrievalRelations(input.scope).superseded;
  const hybrid = {
    scope: input.scope,
    terms,
    limit: 101,
    projectId: input.projectId,
    ...(expansion.length ? { expansion } : {}),
  };
  const memory = knowledge.projectHybrid(
    {
      ...hybrid,
      ...(input.semantic?.items.length
        ? { vectors: input.semantic.items }
        : {}),
    },
    "memory",
  );
  const journals = knowledge.projectHybrid(
    {
      ...hybrid,
      ...(input.semantic?.items.length
        ? { vectors: input.semantic.items }
        : {}),
    },
    "journal",
  );
  const found = sources.packageCandidates({
    ...hybrid,
    ...(input.semantic?.sources.length
      ? { vectors: input.semantic.sources }
      : {}),
  });
  const load = (id: string) => knowledge.find(id, input.scope);
  const eligible = (item: KnowledgeItem | undefined): item is KnowledgeItem =>
    !!item && item.status !== "rejected" && !superseded.has(item.id);
  const loadedMemory = memory.ids
    .map(load)
    .filter(eligible)
    .filter((item) => item.kind === "fact" || item.kind === "decision");
  const journalCandidates = journals.ids
    .map(load)
    .filter(eligible)
    .filter(
      (item) =>
        item.kind === "journal" && (journals.scores.get(item.id) ?? 0) > 0,
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
  const rankedSources = [...found.materials].sort((a, b) => {
    const delta =
      (found.scores.get(b.source.id) ?? 0) -
      (found.scores.get(a.source.id) ?? 0);
    if (delta !== 0) return delta;
    const recency = sourceDate(b).localeCompare(sourceDate(a));
    if (recency) return recency;
    return a.source.id.localeCompare(b.source.id);
  });
  const citingBySource = new Map<string, KnowledgeItem[]>();
  const citingIds = rankedSources.map((material) => material.source.id);
  if (citingIds.length) {
    for (const item of knowledge.memoryCiting(
      input.scope,
      input.projectId,
      citingIds,
    )) {
      if (!eligible(item)) continue;
      if (item.kind !== "fact" && item.kind !== "decision") continue;
      for (const ref of item.sourceRefs) {
        const list = citingBySource.get(ref.sourceId) ?? [];
        list.push(item);
        citingBySource.set(ref.sourceId, list);
      }
    }
  }
  const hitOf = (hits: ReadonlyMap<string, TermHit>, id: string): TermHit =>
    hits.get(id) ?? { original: false, concepts: 0 };
  const preferDistilled = (items: readonly KnowledgeItem[]) =>
    [...items].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "decision" ? -1 : 1;
      const score =
        (memory.scores.get(b.id) ?? 0) - (memory.scores.get(a.id) ?? 0);
      if (score) return score;
      const size =
        Buffer.byteLength(a.text, "utf8") - Buffer.byteLength(b.text, "utf8");
      if (size) return size;
      return a.id.localeCompare(b.id);
    })[0];
  const byId = new Map(loadedMemory.map((item) => [item.id, item]));
  for (const material of rankedSources.slice(0, packSourceLimit)) {
    const sourceScore = found.scores.get(material.source.id) ?? 0;
    if (sourceScore <= 0) continue;
    const best = preferDistilled(
      (citingBySource.get(material.source.id) ?? []).filter(
        (item) => !(item.kind === "decision" && shownPins.has(item.id)),
      ),
    );
    if (!best) continue;
    const ownScore = memory.scores.get(best.id) ?? 0;
    const own = hitOf(memory.termHits, best.id);
    const sourceHit = hitOf(found.termHits, material.source.id);
    // A hit that already ranks keeps its score. Only a miss inherits the
    // source, so a short weak neighbour cannot jump a better decision.
    if (ownScore <= 0) memory.scores.set(best.id, sourceScore);
    memory.termHits.set(best.id, {
      original: own.original || sourceHit.original,
      concepts: Math.max(own.concepts, sourceHit.concepts),
    });
    byId.set(best.id, best);
  }
  const beforeFloor = rankPackItems(
    [...byId.values()].filter(
      (item) => !(item.kind === "decision" && shownPins.has(item.id)),
    ),
    memory.scores,
  );
  const ranked = packFloor(beforeFloor, memory.termHits);
  const dropped = new Set(
    beforeFloor
      .filter((item) => !ranked.some((kept) => kept.id === item.id))
      .map((item) => item.id),
  );
  const blockedSources = new Set<string>();
  for (const [sourceId, citedItems] of citingBySource) {
    if (!citedItems.length) continue;
    if (citedItems.every((item) => dropped.has(item.id)))
      blockedSources.add(sourceId);
  }
  const reasons = [...new Set(input.semantic?.reasons ?? [])];
  if (memory.total > 100 || journals.total > 100 || found.total > 100)
    reasons.push("candidate_limit");

  const render = (
    flags: Flags,
    items: PackItem[],
    packSources: PackSource[],
    truncated: boolean,
    coverage: boolean,
  ): TaskPack => ({
    version: 1,
    scope: input.scope,
    mode: "pack",
    project: input.projectId,
    header: packHeader(flags),
    items,
    sources: packSources,
    relations: [],
    ...(coverage ? { coverage: { reasons: [...reasons] } } : {}),
    truncated,
    budgetBytes: budget,
    bytesUsed: 0,
  });
  const settle = (pack: TaskPack): TaskPack => {
    let current = pack;
    for (let step = 0; step < 6; step++) {
      const size = Buffer.byteLength(JSON.stringify(current), "utf8");
      if (size === current.bytesUsed) return current;
      current = { ...current, bytesUsed: size };
    }
    return current;
  };
  const bytes = (pack: TaskPack) =>
    Buffer.byteLength(JSON.stringify(settle(pack)), "utf8");
  let coverage = bytes(render(off(), [], [], true, true)) <= budget;
  const fits = (
    flags: Flags,
    items: PackItem[],
    packSources: PackSource[],
    truncated: boolean,
    reason: string | undefined,
  ) => {
    const pack = render(flags, items, packSources, truncated, coverage);
    if (reason && pack.coverage)
      pack.coverage = { reasons: [...pack.coverage.reasons, reason] };
    else if (reason) pack.coverage = { reasons: [reason] };
    return bytes(pack) <= budget;
  };

  const pinsIn = (text: string) =>
    (loaded?.inForce ?? [])
      .filter((pin) => text.includes(pin.text))
      .map((pin) => ({ id: pin.id }));
  let flags = off();
  let items: PackItem[] = [];
  let cut = false;

  let profilePartial = false;
  if (section) {
    const id = profileId(input.projectId);
    const partial = rendered?.partial ?? false;
    const presence = partial ? ("partial" as const) : ("full" as const);
    const card = profileCard(id, section, partial, pinsIn(section));
    const nextFlags = { ...flags, profile: presence };
    if (fits(nextFlags, [card], [], reasons.length > 0, undefined)) {
      flags = nextFlags;
      items = [card];
      profilePartial = partial;
    } else {
      let chosen = "";
      for (const end of sentenceEnds(section)) {
        const slice = section.slice(0, end);
        const card = profileCard(id, slice, true, pinsIn(slice));
        const partialFlags = { ...flags, profile: "partial" as const };
        if (fits(partialFlags, [card], [], true, "byte_limit")) chosen = slice;
        else break;
      }
      if (!chosen) {
        const first = section.slice(
          0,
          sentenceEnds(section)[0] ?? section.length,
        );
        let low = 1;
        let high = first.length;
        while (low <= high) {
          const mid = Math.ceil((low + high) / 2);
          const slice = utf8Prefix(
            first,
            Buffer.byteLength(first.slice(0, mid), "utf8"),
          );
          const card = profileCard(id, slice, true, []);
          const partialFlags = { ...flags, profile: "partial" as const };
          if (slice && fits(partialFlags, [card], [], true, "byte_limit")) {
            chosen = slice;
            low = mid + 1;
          } else high = mid - 1;
        }
      }
      if (chosen) {
        flags = { ...flags, profile: "partial" };
        items = [profileCard(id, chosen, true, pinsIn(chosen))];
      }
      cut = true;
    }
  }

  let cited = new Set<string>();
  const profileText = items.find((item) => item.kind === "profile")?.excerpt
    .text;
  if (profileText) {
    for (const [sentence, ids] of pinSources) {
      if (!profileText.includes(sentence)) continue;
      for (const id of ids) cited.add(id);
    }
  }

  const profileItems = items;
  const memoryCards: PackItem[] = [];
  const journalCards: PackItem[] = [];
  let sourceCards: PackSource[] = [];
  const decisionEligible = ranked.filter(
    (item) => item.kind === "decision",
  ).length;
  const factEligible = ranked.filter((item) => item.kind === "fact").length;
  const journalGoal = Math.min(packJournalLimit, journalCandidates.length);
  const view = () => [...profileItems, ...memoryCards, ...journalCards];
  const sourceGoal = () =>
    Math.min(
      packSourceLimit,
      sourceCards.length +
        rankedSources.filter(
          (material) =>
            !cited.has(material.source.id) &&
            !blockedSources.has(material.source.id),
        ).length,
    );
  const sectionFlags = (): Flags => ({
    ...flags,
    decisions: presence(
      memoryCards.filter((item) => item.kind === "decision").length,
      decisionEligible,
    ),
    facts: presence(
      memoryCards.filter((item) => item.kind === "fact").length,
      factEligible,
    ),
    journals: presence(journalCards.length, journalGoal),
    sources: presence(sourceCards.length, sourceGoal()),
  });
  const packOf = (truncated: boolean, reason: string | undefined) => {
    const nextFlags = sectionFlags();
    const pack = render(nextFlags, view(), sourceCards, truncated, coverage);
    if (reason && pack.coverage)
      pack.coverage = { reasons: [...pack.coverage.reasons, reason] };
    else if (reason) pack.coverage = { reasons: [reason] };
    return pack;
  };

  const pushMemory = (ceiling: number) => {
    if (cut) return;
    for (const item of ranked) {
      if (memoryCards.some((card) => card.id === item.id)) continue;
      const card = memoryCard(item, sources, input.scope);
      const nextCited = new Set(cited);
      for (const id of card.sourceIds) nextCited.add(id);
      const savedSources = sourceCards;
      sourceCards = sourceCards.filter((source) => !nextCited.has(source.id));
      memoryCards.push(card);
      const probe = packOf(true, "byte_limit");
      const size = bytes(probe);
      if (size > ceiling || size > budget) {
        memoryCards.pop();
        sourceCards = savedSources;
        continue;
      }
      cited = nextCited;
      flags = sectionFlags();
    }
  };

  if (!cut) {
    const sourceReserve = Math.floor(budget * packSourceShare);
    const journalReserve = Math.floor(budget * packJournalShare);
    pushMemory(budget - sourceReserve - journalReserve);
    const beforeSources = bytes(packOf(true, "byte_limit"));
    for (const material of rankedSources) {
      if (sourceCards.length >= packSourceLimit) break;
      if (cited.has(material.source.id)) continue;
      if (blockedSources.has(material.source.id)) continue;
      const card = sourceCard(
        material,
        found.matchOffsets.get(material.source.id) ?? 0,
      );
      sourceCards.push(card);
      const size = bytes(packOf(true, "byte_limit"));
      if (size > budget || size - beforeSources > sourceReserve) {
        sourceCards.pop();
        continue;
      }
      flags = sectionFlags();
    }
    const beforeJournals = bytes(packOf(true, "byte_limit"));
    for (const item of journalCandidates) {
      if (journalCards.length >= packJournalLimit) break;
      const card = journalCard(
        item,
        sources,
        input.scope,
        knowledge.journalCitations(item.id)?.citedIds,
      );
      journalCards.push(card);
      const nextCited = new Set(cited);
      for (const id of card.sourceIds) nextCited.add(id);
      const savedSources = sourceCards;
      sourceCards = sourceCards.filter((source) => !nextCited.has(source.id));
      const size = bytes(packOf(true, "byte_limit"));
      if (size > budget || size - beforeJournals > journalReserve) {
        journalCards.pop();
        sourceCards = savedSources;
        continue;
      }
      cited = nextCited;
      flags = sectionFlags();
    }
    pushMemory(budget);
  }

  const memoryShort = !cut && memoryCards.length < ranked.length;
  const truncated = cut || profilePartial || memoryShort || reasons.length > 0;
  flags = sectionFlags();
  const pack = packOf(truncated, undefined);
  if (cut || memoryShort) {
    const list = [...(pack.coverage?.reasons ?? reasons), "byte_limit"];
    pack.coverage = { reasons: [...new Set(list)] };
    if (bytes(pack) > budget) delete pack.coverage;
  }
  if (pack.coverage && bytes(pack) > budget) delete pack.coverage;
  let settled = settle(pack);
  while (settled.bytesUsed > budget && memoryCards.length > 0) {
    memoryCards.pop();
    flags = sectionFlags();
    const retry = packOf(true, "byte_limit");
    if (retry.coverage && bytes(retry) > budget) delete retry.coverage;
    settled = settle(retry);
  }
  if (settled.bytesUsed > budget) {
    delete settled.coverage;
    settled = settle({ ...settled, truncated: true });
  }
  return settled;
}
