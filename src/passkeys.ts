import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { type AuthorizationServer, json, OAuthFailure } from "./oauth.js";

const browserScript = `document.getElementById('passkey').addEventListener('click', async () => {
 const status=document.getElementById('status');
 const csrf=document.getElementById('csrf').value;
 try {
  const optionsResponse=await fetch('/auth/passkey/options',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({csrf})});
  if(!optionsResponse.ok) throw new Error();
  const {ceremony,options}=await optionsResponse.json();
  const credential=ceremony==='register'
   ? await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON(options)})
   : await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON(options)});
  const result=await fetch('/auth/passkey/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({csrf,response:credential.toJSON()})});
  if(!result.ok) throw new Error();
  document.open();document.write(await result.text());document.close();
 } catch {status.textContent='Passkey failed or expired. Retry, or restart client authorization.';}
});`;
export async function handlePasskey(
  server: AuthorizationServer,
  request: Request,
) {
  const path = new URL(request.url).pathname;
  if (path === "/auth/passkey.js" && request.method === "GET")
    return new Response(browserScript, {
      headers: {
        "content-type": "text/javascript",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  if (
    request.method !== "POST" ||
    !request.headers.get("content-type")?.startsWith("application/json")
  )
    throw new OAuthFailure("invalid_request");
  const input = await request.json();
  const { value, session } = server.browser(
    request,
    typeof input.csrf === "string" ? input.csrf : null,
  );
  if (!session.password || session.authenticated)
    throw new OAuthFailure("access_denied", 403);
  const rpID = new URL(server.config.issuer).hostname,
    keys = server.store.passkeys();
  if (path === "/auth/passkey/options") {
    const ceremony = keys.length ? "authenticate" : "register";
    const options =
      ceremony === "register"
        ? await generateRegistrationOptions({
            rpName: "Context",
            rpID,
            userName: "owner",
            userID: new TextEncoder().encode("context-owner"),
            attestationType: "none",
            supportedAlgorithmIDs: [-7, -257],
            authenticatorSelection: {
              residentKey: "required",
              userVerification: "required",
            },
          })
        : await generateAuthenticationOptions({
            rpID,
            userVerification: "required",
            allowCredentials: keys.map((k) => ({ id: k.id })),
          });
    session.challenge = options.challenge;
    session.ceremony = ceremony;
    server.store.saveSession(value, session);
    return json({ ceremony, options });
  }
  if (
    path !== "/auth/passkey/verify" ||
    !session.challenge ||
    !session.ceremony
  )
    throw new OAuthFailure("invalid_request");
  const challenge = session.challenge,
    ceremony = session.ceremony;
  delete session.challenge;
  delete session.ceremony;
  server.store.saveSession(value, session);
  if (ceremony === "register") {
    const verified = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challenge,
      expectedOrigin: server.config.issuer,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!verified.verified || !verified.registrationInfo)
      throw new OAuthFailure("access_denied", 403);
    const credential = verified.registrationInfo.credential;
    server.store.transaction(() => {
      server.store.session(value);
      if (server.store.passkeys().length)
        throw new OAuthFailure("access_denied", 403);
      server.store.savePasskey({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
      });
    });
  } else {
    const key = keys.find((k) => k.id === input.response?.id);
    if (!key) throw new OAuthFailure("access_denied", 403);
    const verified = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: challenge,
      expectedOrigin: server.config.issuer,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: key.id,
        publicKey: Buffer.from(key.publicKey, "base64url"),
        counter: key.counter,
      },
    });
    if (!verified.verified) throw new OAuthFailure("access_denied", 403);
    server.store.transaction(() => {
      server.store.session(value);
      const current = server.store.passkeys().find((k) => k.id === key.id);
      if (!current || current.counter !== key.counter)
        throw new OAuthFailure("access_denied", 403);
      server.store.savePasskey({
        ...key,
        counter: verified.authenticationInfo.newCounter,
      });
    });
  }
  session.authenticated = true;
  server.store.saveSession(value, session);
  return server.consentPage(session);
}
