import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { scopeSchema } from "./contracts.js";
import {
  enqueueProcessingSchema,
  type JobStore,
  ProcessingSourceNotFound,
} from "./jobs.js";
import { materialLookupSchema } from "./materials.js";
import {
  type AuthorizeTool,
  storageError,
  toolResult,
} from "./tool-results.js";

export function registerProcessingTools(
  server: McpServer,
  jobs: JobStore,
  authorize: AuthorizeTool,
) {
  server.registerTool(
    "queue_processing",
    {
      description:
        "Queue one persisted synthetic source for explicit operator-launched local model processing. Does not authorize decisions or run a model inside MCP.",
      inputSchema: enqueueProcessingSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => {
      const denied =
        authorize(input.scope, "context:read") ??
        authorize(input.scope, "context:write");
      if (denied) return denied;
      try {
        return toolResult(jobs.enqueue(input));
      } catch (error) {
        if (error instanceof ProcessingSourceNotFound)
          return toolResult({ error: "not_found" }, true);
        return storageError(error);
      }
    },
  );
  server.registerTool(
    "processing_status",
    {
      description:
        "Read bounded processing job status in one authorized scope. Lease credentials and raw model output are never returned.",
      inputSchema: z.strictObject({
        version: z.literal(1),
        scope: scopeSchema,
        id: materialLookupSchema.shape.id.optional(),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => {
      const denied = authorize(input.scope, "context:read");
      if (denied) return denied;
      try {
        if (input.id !== undefined) {
          const job = jobs.find(input.id, input.scope);
          return job
            ? toolResult({ jobs: [job] })
            : toolResult({ error: "not_found" }, true);
        }
        return toolResult({ jobs: jobs.list(input.scope, input.limit) });
      } catch (error) {
        return storageError(error);
      }
    },
  );
}
