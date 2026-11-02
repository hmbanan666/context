import { z } from "zod";
import { operationScopes } from "./access.js";
import {
  type AuthStore,
  type BrowserSession,
  digest,
  equal,
  type Grants,
  grantScopes,
  secret,
  type TokenRecord,
} from "./auth-store.js";

export interface OAuthConfig {
  readonly resource: string;
  readonly issuer: string;
  readonly areas: readonly string[];
  readonly refreshSeconds: number;
  readonly offlineSeconds: number;
}
const registration = z.object({
  client_name: z.string().trim().min(1).max(128).default("MCP client"),
  redirect_uris: z.array(z.string().max(2048).url()).min(1).max(8),
  token_endpoint_auth_method: z.literal("none").default("none"),
  grant_types: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .default(["authorization_code"]),
  response_types: z.array(z.literal("code")).default(["code"]),
});
export function validRedirect(value: string) {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname)))
  );
}
export class OAuthFailure extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
export function page(body: string, cookie?: string) {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Context owner</title><body><main><h1>Context</h1>${body}</main></body></html>`,
    { headers },
  );
}
export const csrfInput = (s: BrowserSession) =>
  `<input type="hidden" name="csrf" value="${s.csrf}">`;
export class AuthorizationServer {
  private readonly budgets = new Map<
    string,
    { start: number; count: number }
  >();
  constructor(
    readonly store: AuthStore,
    readonly config: OAuthConfig,
  ) {}
  private limit(key: string, max: number) {
    const now = this.store.time();
    let budget = this.budgets.get(key);
    if (!budget || now - budget.start >= 60) {
      budget = { start: now, count: 0 };
      this.budgets.set(key, budget);
    }
    if (++budget.count > max)
      throw new OAuthFailure("temporarily_unavailable", 429);
  }
  // One owner: global budgets also cap attacker-controlled client/IP cardinality.
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin !== this.config.issuer)
        throw new OAuthFailure("invalid_request");
      const path = url.pathname;
      if (
        request.method === "GET" &&
        path === "/.well-known/oauth-authorization-server"
      )
        return json({
          issuer: this.config.issuer,
          authorization_endpoint: `${this.config.issuer}/oauth/authorize`,
          token_endpoint: `${this.config.issuer}/oauth/token`,
          registration_endpoint: `${this.config.issuer}/oauth/register`,
          revocation_endpoint: `${this.config.issuer}/oauth/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          revocation_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: [
            ...operationScopes,
            ...this.config.areas,
            "offline_access",
          ],
          authorization_response_iss_parameter_supported: true,
        });
      if (
        request.method === "GET" &&
        [
          "/.well-known/oauth-protected-resource",
          "/.well-known/oauth-protected-resource/mcp",
        ].includes(path)
      )
        return json({
          resource: this.config.resource,
          authorization_servers: [this.config.issuer],
          scopes_supported: [...operationScopes, ...this.config.areas],
          bearer_methods_supported: ["header"],
          resource_name: "Context",
        });
      if (request.method === "POST" && path === "/oauth/register") {
        this.limit("register", 10);
        if (
          !request.headers.get("content-type")?.startsWith("application/json")
        )
          throw new OAuthFailure("invalid_client_metadata");
        const input = registration.parse(await request.json());
        if (
          !input.redirect_uris.every(validRedirect) ||
          !input.grant_types.includes("authorization_code") ||
          input.response_types.length !== 1
        )
          throw new OAuthFailure("invalid_client_metadata");
        const client = this.store.register(
          input.client_name,
          input.redirect_uris,
          input.grant_types.includes("refresh_token"),
        );
        return json(
          {
            ...input,
            client_id: client.id,
            client_id_issued_at: client.created,
          },
          201,
        );
      }
      if (request.method === "POST" && path === "/oauth/token") {
        this.limit("token", 120);
        return this.exchange(await this.form(request));
      }
      if (request.method === "POST" && path === "/oauth/revoke") {
        this.limit("revoke", 60);
        const form = await this.form(request);
        try {
          const t = this.store.token(form.get("token") ?? "");
          if (t.clientId === form.get("client_id"))
            this.store.revokeFamily(t.family);
        } catch {
          /* RFC 7009: unknown tokens succeed. */
        }
        return json({});
      }
      if (request.method === "GET" && path === "/oauth/authorize") {
        this.limit("authorize", 30);
        const q = url.searchParams;
        this.unique(q);
        const client = this.store.client(q.get("client_id") ?? "");
        const redirect = q.get("redirect_uri") ?? "";
        if (client.kind !== "oauth" || !client.redirects.includes(redirect))
          throw new OAuthFailure("invalid_request");
        if (
          q.get("response_type") !== "code" ||
          q.get("code_challenge_method") !== "S256" ||
          !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? "")
        )
          throw new OAuthFailure("invalid_request");
        if (q.get("resource") !== this.config.resource)
          throw new OAuthFailure("invalid_target");
        const scopes = this.scopes(
          q.get("scope") ??
            `context:read context:write ${this.config.areas.join(" ")}`,
        );
        const session: BrowserSession = {
          csrf: secret(),
          password: false,
          authenticated: false,
          pending: {
            clientId: client.id,
            redirect,
            challenge: q.get("code_challenge") ?? "",
            state: q.get("state") ?? "",
            scopes,
          },
        };
        const value = this.store.newSession(session);
        return this.loginPage(session, this.cookie(value));
      }
      if (request.method === "POST" && path === "/auth/login") {
        this.limit("login", 10);
        const form = await this.form(request);
        const { value, session } = this.browser(request, form.get("csrf"));
        if (!(await this.store.checkPassword(form.get("password") ?? "")))
          throw new OAuthFailure("invalid_credentials", 401);
        const next = this.store.transaction(() => {
          this.store.session(value);
          this.store.deleteSession(value);
          session.password = true;
          session.csrf = secret();
          return this.store.newSession(session);
        });
        return this.passkeyPage(session, this.cookie(next));
      }
      if (request.method === "POST" && path === "/oauth/consent") {
        const form = await this.form(request, true);
        const { value, session } = this.browser(request, form.get("csrf"));
        if (!session.authenticated || !session.pending)
          throw new OAuthFailure("access_denied", 403);
        const pending = session.pending,
          client = this.store.client(pending.clientId);
        const location = new URL(pending.redirect);
        location.searchParams.set("state", pending.state);
        location.searchParams.set("iss", this.config.issuer);
        if (form.get("decision") !== "allow") {
          this.store.deleteSession(value);
          location.searchParams.set("error", "access_denied");
        } else {
          const grants: Grants = { read: [], write: [], process: [] };
          for (const op of ["read", "write", "process"] as const) {
            grants[op] = form.getAll(op);
            if (
              grants[op].some(
                (a) =>
                  !pending.scopes.includes(a) ||
                  !pending.scopes.includes(`context:${op}`),
              )
            )
              throw new OAuthFailure("invalid_scope");
          }
          const defaultWrite = form.get("default_write") || null;
          this.store.validateGrants(grants, defaultWrite);
          const offline =
            form.get("offline") === "yes" &&
            pending.scopes.includes("offline_access") &&
            client.refresh;
          const scopes = [
            ...grantScopes(grants),
            ...(offline ? ["offline_access"] : []),
          ];
          const familyExpires =
            this.store.time() +
            (offline ? this.config.offlineSeconds : this.config.refreshSeconds);
          const issued = this.store.transaction(() => {
            this.store.session(value);
            const client = this.store.client(pending.clientId);
            // Registry is the union of owner-approved rights; each credential retains its narrower consent.
            for (const op of ["read", "write", "process"] as const)
              client.grants[op] = [
                ...new Set([...client.grants[op], ...grants[op]]),
              ];
            client.defaultWrite = defaultWrite ?? client.defaultWrite;
            this.store.saveClient(client);
            const issued = this.store.issue({
              kind: "code",
              clientId: client.id,
              resource: this.config.resource,
              grants,
              defaultWrite,
              scopes,
              expires: this.store.time() + 60,
              family: secret(),
              familyExpires,
              redirect: pending.redirect,
              challenge: pending.challenge,
            });
            this.store.deleteSession(value);
            return issued;
          });
          location.searchParams.set("code", issued.token);
        }
        return new Response(null, {
          status: 303,
          headers: {
            location: location.href,
            "cache-control": "no-store",
            "set-cookie": this.cookie("", 0),
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (path.startsWith("/auth/passkey")) return await this.passkey(request);
      return json({ error: "not_found" }, 404);
    } catch (error) {
      const code =
        error instanceof OAuthFailure ? error.code : "invalid_request";
      const response = json(
        { error: code },
        error instanceof OAuthFailure ? error.status : 400,
      );
      if (response.status === 429) response.headers.set("retry-after", "60");
      return response;
    }
  }
  private unique(params: URLSearchParams, consent = false) {
    for (const key of new Set(params.keys()))
      if (
        params.getAll(key).length > 1 &&
        !(consent && ["read", "write", "process"].includes(key))
      )
        throw new OAuthFailure("invalid_request");
  }
  private async form(request: Request, consent = false) {
    if (
      !request.headers
        .get("content-type")
        ?.startsWith("application/x-www-form-urlencoded")
    )
      throw new OAuthFailure("invalid_request");
    const form = new URLSearchParams(await request.text());
    this.unique(form, consent);
    return form;
  }
  private scopes(value: string) {
    const scopes = [...new Set(value.split(" ").filter(Boolean))];
    if (
      scopes.some(
        (s) =>
          ![
            ...operationScopes,
            ...this.config.areas,
            "offline_access",
          ].includes(s),
      )
    )
      throw new OAuthFailure("invalid_scope");
    return scopes;
  }
  private exchange(form: URLSearchParams) {
    if (form.get("resource") !== this.config.resource)
      throw new OAuthFailure("invalid_target");
    const grant = form.get("grant_type");
    if (grant !== "authorization_code" && grant !== "refresh_token")
      throw new OAuthFailure("unsupported_grant_type");
    let token: TokenRecord;
    try {
      token = this.store.token(
        form.get(grant === "authorization_code" ? "code" : "refresh_token") ??
          "",
      );
    } catch {
      throw new OAuthFailure("invalid_grant");
    }
    if (
      token.clientId !== form.get("client_id") ||
      token.kind !== (grant === "authorization_code" ? "code" : "refresh") ||
      token.resource !== this.config.resource
    )
      throw new OAuthFailure("invalid_grant");
    if (
      grant === "authorization_code" &&
      (token.redirect !== form.get("redirect_uri") ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(form.get("code_verifier") ?? "") ||
        !equal(token.challenge ?? "", digest(form.get("code_verifier") ?? "")))
    )
      throw new OAuthFailure("invalid_grant");
    let scopes = token.scopes;
    if (form.has("scope")) {
      scopes = this.scopes(form.get("scope") ?? "");
      if (scopes.some((s) => !token.scopes.includes(s)))
        throw new OAuthFailure("invalid_scope");
    }
    // Commit revocation on replay, including all descendants; never roll it back with the error.
    const output = this.store.transaction(() => {
      const client = this.store.client(token.clientId);
      token = this.store.token(
        form.get(grant === "authorization_code" ? "code" : "refresh_token") ??
          "",
      );
      if (token.used) {
        this.store.revokeFamily(token.family);
        return null;
      }
      if (
        token.revoked ||
        token.expires <= this.store.time() ||
        token.familyExpires <= this.store.time()
      )
        return null;
      token.used = true;
      this.store.saveToken(token);
      const grants: Grants = { read: [], write: [], process: [] };
      for (const op of ["read", "write", "process"] as const)
        grants[op] = token.grants[op].filter(
          (a) =>
            scopes.includes(a) &&
            scopes.includes(`context:${op}`) &&
            client.grants[op].includes(a) &&
            this.config.areas.includes(a),
        );
      const common = {
        clientId: client.id,
        resource: token.resource,
        grants,
        defaultWrite:
          token.defaultWrite && grants.write.includes(token.defaultWrite)
            ? token.defaultWrite
            : null,
        scopes,
        family: token.family,
        familyExpires: token.familyExpires,
      };
      const access = this.store.issue({
        ...common,
        kind: "access",
        expires: this.store.time() + 300,
      });
      const refresh = client.refresh
        ? this.store.issue({
            ...common,
            kind: "refresh",
            expires: Math.min(
              this.store.time() +
                (scopes.includes("offline_access")
                  ? this.config.offlineSeconds
                  : this.config.refreshSeconds),
              token.familyExpires,
            ),
          })
        : undefined;
      return {
        access_token: access.token,
        token_type: "Bearer",
        expires_in: 300,
        scope: scopes.join(" "),
        ...(refresh ? { refresh_token: refresh.token } : {}),
      };
    });
    if (!output) throw new OAuthFailure("invalid_grant");
    return json(output);
  }
  cookie(value: string, maxAge = 600) {
    return `__Host-context=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  }
  browser(request: Request, csrf: string | null) {
    if (request.headers.get("origin") !== this.config.issuer)
      throw new OAuthFailure("access_denied", 403);
    const value =
      request.headers
        .get("cookie")
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("__Host-context="))
        ?.slice("__Host-context=".length) ?? "";
    const session = this.store.session(value);
    if (!csrf || !equal(csrf, session.csrf))
      throw new OAuthFailure("access_denied", 403);
    return { value, session };
  }
  loginPage(session: BrowserSession, cookie?: string) {
    return page(
      `<h2>Owner login</h2><form method="post" action="/auth/login">${csrfInput(session)}<label>Password <input type="password" name="password" autocomplete="current-password" required maxlength="1024"></label><button>Continue</button></form>`,
      cookie,
    );
  }
  passkeyPage(session: BrowserSession, cookie?: string) {
    return page(
      `<h2>${this.store.passkeys().length ? "Verify your passkey" : "Register your first passkey"}</h2><p>Password accepted. Use your device to continue.</p><input type="hidden" id="csrf" value="${session.csrf}"><button id="passkey">Continue with passkey</button><p id="status" role="status"></p><script src="/auth/passkey.js" defer></script>`,
      cookie,
    );
  }
  consentPage(session: BrowserSession) {
    if (!session.pending) throw new OAuthFailure("invalid_request");
    const p = session.pending,
      client = this.store.client(p.clientId);
    const choices = (["read", "write", "process"] as const)
      .flatMap((op) =>
        p.scopes.includes(`context:${op}`)
          ? this.config.areas
              .filter((a) => p.scopes.includes(a))
              .map(
                (a) =>
                  `<label><input type="checkbox" name="${op}" value="${escapeHtml(a)}" checked>${op}: ${escapeHtml(a)}</label><br>`,
              )
          : [],
      )
      .join("");
    const writable = p.scopes.includes("context:write")
      ? this.config.areas.filter((a) => p.scopes.includes(a))
      : [];
    return page(
      `<h2>Authorize ${escapeHtml(client.name)}</h2><p>Client names are self-declared. Check the callback before granting access:</p><p>${escapeHtml(p.redirect)}</p><form method="post" action="/oauth/consent">${csrfInput(session)}${choices}<label>Default write area <select name="default_write"><option value="">None (read only)</option>${writable.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("")}</select></label>${p.scopes.includes("offline_access") && client.refresh ? '<p><label><input type="checkbox" name="offline" value="yes">Allow bounded offline access</label></p>' : ""}<button name="decision" value="allow">Allow selected rights</button><button name="decision" value="deny">Deny</button></form>`,
    );
  }
  private async passkey(request: Request): Promise<Response> {
    const { handlePasskey } = await import("./passkeys.js");
    this.limit("passkey", 30);
    return handlePasskey(this, request);
  }
}
