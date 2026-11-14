// Item status is the latest knowledge_reviews row. Project-proposal audits share
// that table; their evidence subject keeps them out of the item status.
// json_valid guards legacy rows whose evidence is plain text, not JSON.
export const projectReviewSubject = "project";

export function itemReviewPredicateSql(evidenceExpr: string): string {
  if (!/^(?:[a-z]+\.)?evidence$/.test(evidenceExpr))
    throw new Error("Invalid review evidence column");
  return `COALESCE(CASE WHEN json_valid(${evidenceExpr})
    THEN json_extract(${evidenceExpr}, '$.subject') END, '') <> '${projectReviewSubject}'`;
}

export function latestReviewStatusSql(
  idExpr: string,
  scopeExpr: string,
  fallback: "proposed" | "suggested",
): string {
  if (
    !/^[a-z]\.(id|scope)$/.test(idExpr) ||
    !/^[a-z]\.(id|scope)$/.test(scopeExpr)
  )
    throw new Error("Invalid review status column");
  return `COALESCE((SELECT rev.status FROM knowledge_reviews rev
    WHERE rev.knowledge_id = ${idExpr} AND rev.scope = ${scopeExpr}
      AND ${itemReviewPredicateSql("rev.evidence")}
    ORDER BY rev.rowid DESC LIMIT 1), '${fallback}')`;
}
