import { AuthStore } from "./auth-store.js";
import { scopeSchema } from "./contracts.js";
import { processorState } from "./llm.js";
import { SourceStore } from "./store.js";

function areas(env: NodeJS.ProcessEnv): string[] {
  const list = (env.CONTEXT_AREAS ?? "personal").split(",");
  if (list.length > 8 || new Set(list).size !== list.length)
    throw new Error("Invalid configured areas");
  for (const area of list) scopeSchema.parse(area);
  return list;
}

/** Owner-local counts. Does not need CONTEXT_PUBLIC_URL. */
export function statusCommand(env: NodeJS.ProcessEnv): void {
  const path = env.CONTEXT_DB_PATH ?? "./data/context.db";
  if (!path.trim() || path === ":memory:")
    throw new Error("Persistent database required");
  const configured = areas(env);
  const sources = new SourceStore(path);
  const auth = new AuthStore(path, configured);
  try {
    const counts = sources.instanceCounts();
    process.stdout.write(
      `${JSON.stringify({
        sources: {
          active: counts.sourcesActive,
          retired: counts.sourcesRetired,
        },
        docs: counts.docs,
        knowledgeItems: counts.knowledgeItems,
        tokens: auth.listTokens().length,
        projects: counts.projects,
        processor: processorState(env),
      })}\n`,
    );
  } finally {
    auth.close();
    sources.close();
  }
}
