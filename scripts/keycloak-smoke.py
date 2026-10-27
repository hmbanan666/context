"""Isolated synthetic Keycloak authorization-code/PKCE smoke test. Requires Docker."""
import base64
import hashlib
import html.parser
import http.cookiejar
import http.client
import json
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class LoginForm(html.parser.HTMLParser):
    action = None

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "form" and values.get("id") == "kc-form-login":
            self.action = values.get("action")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    container = "context-oauth-smoke-" + uuid.uuid4().hex[:10]
    resource = "https://context.kosarev.space/mcp"
    realm = json.loads(Path("deploy/keycloak/context-realm.json").read_text())
    realm["sslRequired"] = "none"
    realm["users"] = [{"id": "00000000-0000-4000-8000-000000000001", "username": "synthetic-owner", "enabled": True,
                       "firstName": "Synthetic", "lastName": "Owner", "email": "synthetic@example.invalid", "emailVerified": True,
                       "credentials": [{"type": "password", "value": "synthetic-local-only", "temporary": False}]}]
    for client in realm["clients"]:
        if client["clientId"] == "context-codex":
            client["enabled"] = True
    with tempfile.TemporaryDirectory(prefix="context-keycloak-") as directory:
        fixture = Path(directory) / "context-realm.json"
        fixture.write_text(json.dumps(realm))
        try:
            subprocess.run(["docker", "run", "--detach", "--name", container,
                            "--publish", "127.0.0.1::8080", "--mount",
                            f"type=bind,src={fixture},dst=/opt/keycloak/data/import/context-realm.json,readonly",
                            "quay.io/keycloak/keycloak:26.8.1", "start-dev", "--import-realm",
                            "--features=resource-indicators", "--http-relative-path=/auth"],
                           check=True, capture_output=True)
            mapping = subprocess.check_output(["docker", "port", container, "8080"], text=True).strip()
            issuer = f"http://{mapping}/auth/realms/context"
            discovery = issuer + "/.well-known/openid-configuration"
            for attempt in range(60):
                try:
                    with urllib.request.urlopen(discovery, timeout=2) as response:
                        metadata = json.load(response)
                    break
                except (urllib.error.URLError, TimeoutError, http.client.HTTPException, ConnectionError):
                    time.sleep(0.5)
            else:
                raise RuntimeError("Keycloak startup timed out")
            assert metadata["issuer"] == issuer
            assert "S256" in metadata["code_challenge_methods_supported"]
            assert metadata["authorization_response_iss_parameter_supported"] is True
            print("Keycloak discovery and PKCE S256: passed", flush=True)

            def authorize(verifier):
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
                params = {"client_id": "context-codex", "response_type": "code",
                          "redirect_uri": "http://127.0.0.1:8765/callback", "resource": resource,
                          "scope": "context:read context:write synthetic:hosted-pilot", "state": "synthetic-state",
                          "code_challenge": challenge, "code_challenge_method": "S256"}
                cookies = http.cookiejar.CookieJar()
                opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies), NoRedirect())
                with opener.open(metadata["authorization_endpoint"] + "?" + urllib.parse.urlencode(params)) as response:
                    form = LoginForm()
                    form.feed(response.read().decode())
                assert form.action
                assert urllib.parse.urlsplit(form.action).netloc == urllib.parse.urlsplit(issuer).netloc
                request = urllib.request.Request(form.action, data=urllib.parse.urlencode({
                    "username": "synthetic-owner", "password": "synthetic-local-only", "credentialId": ""
                }).encode(), headers={"Cookie": "; ".join(f"{cookie.name}={cookie.value}" for cookie in cookies)})
                try:
                    opener.open(request)
                    raise AssertionError("Expected authorization redirect")
                except urllib.error.HTTPError as response:
                    assert response.code == 302, response.code
                    location = response.headers["Location"]
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)
                assert query["state"] == ["synthetic-state"]
                assert query["iss"] == [issuer]
                return query["code"][0]

            def exchange(params):
                request = urllib.request.Request(metadata["token_endpoint"], data=urllib.parse.urlencode(params).encode())
                with urllib.request.urlopen(request) as response:
                    return json.load(response)

            verifier = "synthetic-pkce-verifier-for-local-tests-only-0001"
            code = authorize(verifier)
            params = {"grant_type": "authorization_code", "client_id": "context-codex", "code": code,
                      "redirect_uri": "http://127.0.0.1:8765/callback", "resource": resource, "code_verifier": "wrong-verifier"}
            try:
                exchange(params)
                raise AssertionError("Wrong verifier was accepted")
            except urllib.error.HTTPError as error:
                assert error.code == 400
            code = authorize(verifier)
            params.update(code=code, code_verifier=verifier)
            tokens = exchange(params)
            payload = json.loads(base64.urlsafe_b64decode(tokens["access_token"].split(".")[1] + "=="))
            assert resource in ([payload["aud"]] if isinstance(payload["aud"], str) else payload["aud"])
            assert payload["sub"] == "00000000-0000-4000-8000-000000000001"
            print("Keycloak code exchange, verifier rejection and resource audience: passed", flush=True)
            refreshed = exchange({"grant_type": "refresh_token", "client_id": "context-codex",
                                  "refresh_token": tokens["refresh_token"], "resource": resource})
            assert refreshed["refresh_token"] != tokens["refresh_token"]
            try:
                exchange({"grant_type": "refresh_token", "client_id": "context-codex",
                          "refresh_token": tokens["refresh_token"], "resource": resource})
                raise AssertionError("Refresh token reuse was accepted")
            except urllib.error.HTTPError as error:
                assert error.code == 400
            print("Keycloak refresh rotation and replay rejection: passed", flush=True)
            subprocess.run(["node", "dist/scripts/provider-smoke-client.js"], check=True,
                           input=json.dumps({"issuer": issuer, "accessToken": tokens["access_token"]}), text=True)
        except Exception:
            logs = subprocess.run(["docker", "logs", "--tail", "15", container], capture_output=True, text=True)
            print(logs.stdout[-2500:] + logs.stderr[-2500:])
            raise
        finally:
            subprocess.run(["docker", "rm", "--force", container], capture_output=True)


if __name__ == "__main__":
    main()
