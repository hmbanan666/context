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
      if (row.kind === "duplicates")
        duplicates.set(String(row.from_id), String(row.to_id));
      else superseded.set(String(row.to_id), String(row.from_id));
    }
  }
  return {
    superseded,
    canonical(id: string) {
      const seen = new Set<string>();
      let current = id;
      while (duplicates.has(current)) {
        if (seen.has(current)) return id; // Malformed cycles never hide evidence.
        seen.add(current);
        current = duplicates.get(current) ?? current;
      }
      return current;
    },
  };
}
