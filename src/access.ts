import { z } from "zod";
import { scopeSchema } from "./contracts.js";

export const operationScopes = [
  "context:read",
  "context:write",
  "context:process",
] as const;
export type OperationScope = (typeof operationScopes)[number];

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
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9._-]+$/),
    grantSchema,
  )
  .refine(
    (grants) =>
      Object.keys(grants).length > 0 && Object.keys(grants).length <= 64,
    {
      message: "Configure 1–64 clients explicitly",
    },
  );
export type ClientGrants = z.infer<typeof clientGrantsSchema>;

export function configuredDataScopes(grants?: ClientGrants): string[] {
  if (grants === undefined) return [];
  const validated = clientGrantsSchema.parse(grants);
  const scopes = new Set<string>();
  for (const client of Object.values(validated)) {
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
    !scopeSchema.safeParse(scope).success ||
    !Object.hasOwn(grantOperations, operation) ||
    !signedTokenScopes.includes(operation) ||
    !signedTokenScopes.includes(scope)
  ) {
    return false;
  }
  if (grants === undefined) return false;
  const validated = clientGrantsSchema.safeParse(grants);
  if (!validated.success || !Object.hasOwn(validated.data, clientId))
    return false;
  return (
    validated.data[clientId]?.[grantOperations[operation]].includes(scope) ??
    false
  );
}
