import type { CallToolResult } from "@modelcontextprotocol/server";
import { ZodError } from "zod";
import type { OperationScope } from "./access.js";
import type { personalDataScope } from "./contracts.js";
import { IdempotencyConflict } from "./store.js";

export type AuthorizeTool = (
  scope: string,
  operation: OperationScope,
) => CallToolResult | undefined;

export function oauthMetadata(
  protectedMode: boolean,
  scopes: readonly (OperationScope | typeof personalDataScope)[],
) {
  return protectedMode
    ? { _meta: { securitySchemes: [{ type: "oauth2", scopes: [...scopes] }] } }
    : {};
}

export function toolResult(
  data: Record<string, unknown>,
  isError = false,
): CallToolResult {
  const output = { version: 1, ...data };
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
    isError,
  };
}

export function storageError(error: unknown): CallToolResult {
  return toolResult(
    {
      error:
        error instanceof IdempotencyConflict
          ? "idempotency_conflict"
          : error instanceof ZodError
            ? "invalid_input"
            : "storage_unavailable",
    },
    true,
  );
}
