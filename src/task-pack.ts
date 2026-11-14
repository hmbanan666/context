import type { SemanticHits } from "./embedding-index.js";
import type { KnowledgeItem, KnowledgeStore } from "./knowledge.js";
import type { Material } from "./materials.js";
import { questionTerms } from "./package-query.js";
import { profileId, type ProjectProfile } from "./projects.js";
import { excerpt } from "./context-package.js";
import type { SourceStore } from "./store.js";

export const packBudgetMin = 512;
export const packBudgetMax = 65536;
export const packBudgetDefault = 8192;

const sections = ["profile", "decisions", "facts", "sources"] as const;
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
}
interface PackSource {
  id: string;
  sourceDate: string;
  excerpt: ReturnType<typeof excerpt>;
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
  sources: "off",
});

/** Purpose, then rules, then pinned decisions that are still in force. */
export function profileSection(profile: ProjectProfile): string {
  return [
    profile.purpose,
    profile.rules,
    ...profile.inForce.map((item) => item.text),
  ].join("\n");
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
  omitted.push("journals");
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

function sourceCard(material: Material, offset = 0): PackSource {
  return {
    id: material.source.id,
    sourceDate: material.metadata.createdAt ?? material.source.capturedAt,
    excerpt: excerpt(material.source.text, offset),
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
 * One budgeted pack for a task. No processor call. Ranking of decisions and
 * raw sources is the existing project search; facts are newest first.
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
  const budget = input.budgetBytes;
  const profile = sources.profile(input.projectId);
  const loaded =
    profile && profile.homeArea === input.scope ? profile : undefined;
  const section = loaded ? profileSection(loaded) : "";
  const pinSources = new Map<string, string[]>();
  for (const pin of loaded?.inForce ?? []) {
    const item = knowledge.find(pin.id, input.scope);
    pinSources.set(pin.text, item?.sourceRefs.map((ref) => ref.sourceId) ?? []);
  }
  const distilled = knowledge.projectDistilled(input.scope, input.projectId);
  const superseded = knowledge.retrievalRelations(input.scope).superseded;
  const pinned = new Set(loaded?.pinned ?? []);
  const ranked = knowledge.packageCandidates(
    {
      scope: input.scope,
      terms,
      limit: 101,
      projectId: input.projectId,
      ...(input.semantic?.items.length
        ? { vectors: input.semantic.items }
        : {}),
    },
    [],
  );
  const searchRank = new Map<string, number>();
  for (const item of ranked.items) {
    if (item.kind === "decision" && !searchRank.has(item.id))
      searchRank.set(item.id, searchRank.size);
  }
  const inForce = distilled.items.filter(
    (item) =>
      item.kind === "decision" &&
      item.status === "approved" &&
      !superseded.has(item.id) &&
      !pinned.has(item.id),
  );
  const decisions = [
    ...inForce
      .filter((item) => searchRank.has(item.id))
      .sort(
        (a, b) => (searchRank.get(a.id) ?? 0) - (searchRank.get(b.id) ?? 0),
      ),
    ...inForce.filter((item) => !searchRank.has(item.id)),
  ];
  const facts = [
    ...distilled.items.filter(
      (item) =>
        item.kind === "fact" &&
        item.status === "approved" &&
        !superseded.has(item.id),
    ),
    ...distilled.items.filter(
      (item) =>
        item.kind === "fact" &&
        item.status !== "approved" &&
        !superseded.has(item.id),
    ),
  ];
  const found = sources.packageCandidates({
    scope: input.scope,
    terms,
    limit: 101,
    projectId: input.projectId,
    ...(input.semantic?.sources.length
      ? { vectors: input.semantic.sources }
      : {}),
  });
  const reasons = [...new Set(input.semantic?.reasons ?? [])];
  if (distilled.truncated || ranked.total > 100 || found.total > 100)
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
  });
  const bytes = (pack: TaskPack) =>
    Buffer.byteLength(JSON.stringify(pack), "utf8");
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

  if (section) {
    const id = profileId(input.projectId);
    const fullFlags = { ...flags, profile: "full" as const };
    const full = profileCard(id, section, false, pinsIn(section));
    if (fits(fullFlags, [full], [], reasons.length > 0, undefined)) {
      flags = fullFlags;
      items = [full];
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

  const cited = new Set<string>();
  const profileText = items.find((item) => item.kind === "profile")?.excerpt
    .text;
  if (profileText) {
    for (const [sentence, ids] of pinSources) {
      if (!profileText.includes(sentence)) continue;
      for (const id of ids) cited.add(id);
    }
  }

  const take = (section: "decisions" | "facts", cards: PackItem[]) => {
    if (cut) return;
    for (let index = 0; index < cards.length; index++) {
      const card = cards[index];
      if (!card) continue;
      const last = index === cards.length - 1;
      const nextFlags = {
        ...flags,
        [section]: last ? ("full" as const) : ("partial" as const),
      };
      const next = [...items, card];
      const more = !last || section === "decisions";
      const stopReason = more || reasons.length > 0 ? "byte_limit" : undefined;
      if (!fits(nextFlags, next, [], more || reasons.length > 0, stopReason)) {
        cut = true;
        return;
      }
      flags = nextFlags;
      items = next;
      for (const id of card.sourceIds) cited.add(id);
    }
  };
  take(
    "decisions",
    decisions.map((item) => memoryCard(item, sources, input.scope)),
  );
  take(
    "facts",
    facts.map((item) => memoryCard(item, sources, input.scope)),
  );

  const packSources: PackSource[] = [];
  if (!cut) {
    const materials = found.materials.filter(
      (material) => !cited.has(material.source.id),
    );
    for (let index = 0; index < materials.length; index++) {
      const material = materials[index];
      if (!material) continue;
      const card = sourceCard(
        material,
        found.matchOffsets.get(material.source.id) ?? 0,
      );
      const last = index === materials.length - 1;
      const nextFlags = {
        ...flags,
        sources: last ? ("full" as const) : ("partial" as const),
      };
      const next = [...packSources, card];
      const stopReason = !last || reasons.length > 0 ? "byte_limit" : undefined;
      if (
        !fits(nextFlags, items, next, !last || reasons.length > 0, stopReason)
      ) {
        cut = true;
        break;
      }
      flags = nextFlags;
      packSources.push(card);
    }
  }

  const truncated = cut || reasons.length > 0;
  const pack = render(flags, items, packSources, truncated, coverage);
  if (cut) {
    const list = [...(pack.coverage?.reasons ?? reasons), "byte_limit"];
    pack.coverage = { reasons: [...new Set(list)] };
    if (bytes(pack) > budget) delete pack.coverage;
  }
  if (pack.coverage && bytes(pack) > budget) delete pack.coverage;
  return pack;
}
