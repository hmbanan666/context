import type { DatabaseSync } from "node:sqlite";

// One scope-indexed relation lookup per result set. Validate both endpoints and
// provenance in SQL before any ID can affect a card or canonical substitution.
export function retrievalRelations(db: DatabaseSync, scope: string) {
  const duplicates = new Map<string, string>();
  const superseded = new Map<string, string>();
  if (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_relations'")
      .get()
  ) {
    const rows = db
      .prepare(`WITH readable AS NOT MATERIALIZED (
      SELECT id FROM sources WHERE scope=?
      UNION ALL SELECT k.id FROM knowledge_items k WHERE k.scope=?
        AND COALESCE((SELECT status FROM knowledge_reviews v WHERE v.knowledge_id=k.id AND v.scope=k.scope ORDER BY v.rowid DESC LIMIT 1),'suggested')<>'rejected'
        AND NOT EXISTS (SELECT 1 FROM json_each(k.source_refs) ref WHERE NOT EXISTS
          (SELECT 1 FROM sources s WHERE s.id=json_extract(ref.value,'$.sourceId') AND s.scope=k.scope))
    ) SELECT r.kind,r.from_id,r.to_id FROM knowledge_relations r
      WHERE r.scope=? AND r.kind IN ('duplicates','supersedes')
        AND EXISTS (SELECT 1 FROM readable WHERE id=r.from_id)
        AND EXISTS (SELECT 1 FROM readable WHERE id=r.to_id)
        AND NOT EXISTS (SELECT 1 FROM json_each(r.source_refs) ref WHERE NOT EXISTS
          (SELECT 1 FROM sources s WHERE s.id=json_extract(ref.value,'$.sourceId') AND s.scope=r.scope))
      ORDER BY r.created_at,r.id`)
      .all(scope, scope, scope);
    for (const row of rows) {
      if (row.kind === "duplicates") {
        // Retain the earliest recorded decision if a source has multiple links.
        if (!duplicates.has(String(row.from_id)))
          duplicates.set(String(row.from_id), String(row.to_id));
      } else superseded.set(String(row.to_id), String(row.from_id));
    }
  }
  return {
    superseded,
    canonical(id: string) {
      const seen = new Map<string, number>();
      let current = id;
      while (duplicates.has(current)) {
        const cycleStart = seen.get(current);
        // Every entry into a cycle must choose the same member, including tails.
        if (cycleStart !== undefined)
          return [...seen.keys()].slice(cycleStart).sort()[0] ?? current;
        seen.set(current, seen.size);
        current = duplicates.get(current) ?? current;
      }
      return current;
    },
  };
}
