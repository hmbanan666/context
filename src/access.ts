import { z } from "zod";
import { scopeSchema } from "./contracts.js";

export const pilotDataScope = "synthetic:hosted-pilot";
export const operationScopes = [
  "context:read",
  "context:write",
  "context:process",
] as const;
export type OperationScope = (typeof operationScopes)[number];

const clientIds = ["context-chatgpt", "context-codex"] as const;
const scopeList = z
  .array(scopeSchema)
  .max(8)
  .refine((scopes) => new Set(scopes).size === scopes.length, {
    message: "Scope grants must be distinct",
  });
const grantSchema = z.strictObject({
  read: scopeList,
  write: scopeList,
  process: scopeList,
});

export const clientGrantsSchema = z
  .strictObject({
    "context-chatgpt": grantSchema.optional(),
    "context-codex": grantSchema.optional(),
  })
  .refine(
    (grants) => clientIds.some((clientId) => grants[clientId] !== undefined),
    { message: "Configure at least one client explicitly" },
  );
export type ClientGrants = z.infer<typeof clientGrantsSchema>;

export function configuredDataScopes(grants?: ClientGrants): string[] {
  if (grants === undefined) return [pilotDataScope];
  const validated = clientGrantsSchema.parse(grants);
  const scopes = new Set<string>();
  for (const clientId of clientIds) {
    const client = validated[clientId];
    if (!client) continue;
    for (const operation of ["read", "write", "process"] as const) {
      for (const scope of client[operation]) scopes.add(scope);
    }
  }
  return [...scopes].sort();
}

const grantOperations = {
  "context:read": "read",
  "context:write": "write",
  "context:process": "process",
} as const;

// Signed token scopes and operator grants are independent requirements.
export function authorizeScope(
  clientId: string,
  signedTokenScopes: readonly string[],
  scope: string,
  operation: OperationScope,
  grants?: ClientGrants,
): boolean {
  if (
    (clientId !== "context-chatgpt" && clientId !== "context-codex") ||
    !scopeSchema.safeParse(scope).success ||
    !Object.hasOwn(grantOperations, operation) ||
    !signedTokenScopes.includes(operation) ||
    !signedTokenScopes.includes(scope)
  ) {
    return false;
  }
  if (grants === undefined) {
    return operation !== "context:process" && scope === pilotDataScope;
  }
  const validated = clientGrantsSchema.safeParse(grants);
  if (!validated.success) return false;
  return (
    validated.data[clientId]?.[grantOperations[operation]].includes(scope) ??
    false
  );
}
