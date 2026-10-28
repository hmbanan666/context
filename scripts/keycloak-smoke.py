"""Isolated synthetic Keycloak authorization-code/PKCE smoke test. Requires Docker."""
import base64
import copy
import concurrent.futures
import hashlib
import html.parser
import http.cookiejar
import http.client
import json
from pathlib import Path
import subprocess
import tempfile
import threading
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
                       "realmRoles": ["offline_access"],
                       "credentials": [{"type": "password", "value": "synthetic-local-only", "temporary": False}]}]
    for client in realm["clients"]:
        if client["clientId"] in ["context-codex", "context-chatgpt"]:
            client["enabled"] = True
        if client["clientId"] == "context-chatgpt":
            client["secret"] = "synthetic-local-only-client-secret"
            client["redirectUris"] = ["http://127.0.0.1:8765/callback"]
    with tempfile.TemporaryDirectory(prefix="context-keycloak-") as directory:
        # Synthetic fixtures must be readable by container UID 1000, not just the CI runner UID.
        Path(directory).chmod(0o755)
        fixture = Path(directory) / "context-realm.json"
        fixture.write_text(json.dumps(realm))
        fixture.chmod(0o644)
        # Only disposable test realms use short lifetimes; provider time is not mocked.
        profiles = {
            "expiry": (2, {"accessTokenLifespan": 5, "ssoSessionIdleTimeout": 3, "ssoSessionMaxLifespan": 8}, 30, 60),
            "idle": (3, {"accessTokenLifespan": 5}, 4, 60),
            "maximum": (4, {"accessTokenLifespan": 5, "offlineSessionIdleTimeout": 60,
                            "offlineSessionMaxLifespanEnabled": False, "offlineSessionMaxLifespan": 12}, 60, 6),
        }
        for name, (owner_number, settings, idle, maximum) in profiles.items():
            test_realm = copy.deepcopy(realm)
            test_realm.update(settings, realm="context-" + name)
            test_realm["users"][0]["id"] = f"00000000-0000-4000-8000-{owner_number:012d}"
            for client in test_realm["clients"]:
                if client["clientId"] == "context-chatgpt":
                    client["attributes"].update({"client.offline.session.idle.timeout": str(idle),
                                                 "client.offline.session.max.lifespan": str(maximum)})
            test_fixture = Path(directory) / f"context-{name}-realm.json"
            test_fixture.write_text(json.dumps(test_realm))
            test_fixture.chmod(0o644)
        try:
            subprocess.run(["docker", "run", "--detach", "--name", container,
                            "--publish", "127.0.0.1::8080", "--mount",
                            f"type=bind,src={directory},dst=/opt/keycloak/data/import,readonly",
                            "quay.io/keycloak/keycloak:26.8.1", "start-dev", "--import-realm",
                            "--features=resource-indicators", "--http-relative-path=/auth"],
                           check=True, capture_output=True)
            mapping = subprocess.check_output(["docker", "port", container, "8080"], text=True).strip()
            issuer = f"http://{mapping}/auth/realms/context"
            discovery = issuer + "/.well-known/openid-configuration"
            for attempt in range(120):
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
            assert "client_secret_basic" in metadata["token_endpoint_auth_methods_supported"]
            assert metadata["authorization_response_iss_parameter_supported"] is True
            print("Keycloak discovery and PKCE S256: passed", flush=True)

            full_scope = "context:read context:write context:process synthetic:hosted-pilot synthetic:project-a synthetic:project-b private:personal"

            def authorize(verifier, client_id="context-codex", scope=full_scope, provider=None):
                provider = metadata if provider is None else provider
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
                params = {"client_id": client_id, "response_type": "code",
                          "redirect_uri": "http://127.0.0.1:8765/callback", "resource": resource,
                          "scope": scope, "state": "synthetic-state",
                          "code_challenge": challenge, "code_challenge_method": "S256"}
                cookies = http.cookiejar.CookieJar()
                opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies), NoRedirect())
                with opener.open(provider["authorization_endpoint"] + "?" + urllib.parse.urlencode(params), timeout=10) as response:
                    form = LoginForm()
                    form.feed(response.read().decode())
                assert form.action
                assert urllib.parse.urlsplit(form.action).netloc == urllib.parse.urlsplit(provider["issuer"]).netloc
                request = urllib.request.Request(form.action, data=urllib.parse.urlencode({
                    "username": "synthetic-owner", "password": "synthetic-local-only", "credentialId": ""
                }).encode(), headers={"Cookie": "; ".join(f"{cookie.name}={cookie.value}" for cookie in cookies)})
                try:
                    opener.open(request, timeout=10)
                    raise AssertionError("Expected authorization redirect")
                except urllib.error.HTTPError as response:
                    assert response.code == 302, response.code
                    location = response.headers["Location"]
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)
                assert query["state"] == ["synthetic-state"]
                assert query["iss"] == [provider["issuer"]]
                return query["code"][0]

            def exchange(params, secret=None, provider=None):
                provider = metadata if provider is None else provider
                request = urllib.request.Request(provider["token_endpoint"], data=urllib.parse.urlencode(params).encode())
                if secret:
                    credential = base64.b64encode(f"{params['client_id']}:{secret}".encode()).decode()
                    request.add_header("Authorization", "Basic " + credential)
                with urllib.request.urlopen(request, timeout=10) as response:
                    return json.load(response)

            def claims(token):
                return json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))

            def provider_for(profile):
                url = issuer.rsplit("/", 1)[0] + "/context-" + profile + "/.well-known/openid-configuration"
                with urllib.request.urlopen(url, timeout=10) as response:
                    return json.load(response)

            def grant(client_id, scope, provider=None):
                code = authorize(verifier, client_id, scope, provider)
                return exchange({"grant_type": "authorization_code", "client_id": client_id, "code": code,
                                 "redirect_uri": "http://127.0.0.1:8765/callback", "resource": resource,
                                 "code_verifier": verifier},
                                "synthetic-local-only-client-secret" if client_id == "context-chatgpt" else None, provider)

            def renew(client_id, token_set, provider=None, scope=None):
                params = {"grant_type": "refresh_token", "client_id": client_id,
                          "refresh_token": token_set["refresh_token"], "resource": resource}
                if scope is not None:
                    params["scope"] = scope
                return exchange(params, "synthetic-local-only-client-secret" if client_id == "context-chatgpt" else None, provider)

            def rejected(operation):
                try:
                    operation()
                except urllib.error.HTTPError as error:
                    assert error.code in [400, 401], "Unexpected OAuth HTTP failure"
                    failure = json.load(error)
                    assert failure.get("error") in ["invalid_grant", "invalid_token"], "Unexpected OAuth error class"
                    return
                raise AssertionError("An invalidated refresh grant was accepted")

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
            assert set(full_scope.split()).issubset(set(payload["scope"].split()))
            print("Keycloak code exchange, verifier rejection and resource audience: passed", flush=True)
            # Codex 0.164.0/rmcp appends this advertised scope during refresh,
            # even when the original authorization requested only online scopes.
            assert "offline_access" in metadata["scopes_supported"]
            original_refresh = json.loads(base64.urlsafe_b64decode(tokens["refresh_token"].split(".")[1] + "=="))
            assert original_refresh["typ"] == "Refresh"
            refresh_scopes = tokens["scope"] + " offline_access"
            try:
                refreshed = exchange({"grant_type": "refresh_token", "client_id": "context-codex",
                                      "refresh_token": tokens["refresh_token"], "resource": resource,
                                      "scope": refresh_scopes})
            except urllib.error.HTTPError as error:
                failure = json.load(error)
                raise AssertionError("Codex-compatible refresh rejected: " + failure.get("error", "unknown")) from None
            assert refreshed["refresh_token"] != tokens["refresh_token"]
            rotated_refresh = json.loads(base64.urlsafe_b64decode(refreshed["refresh_token"].split(".")[1] + "=="))
            rotated_access = json.loads(base64.urlsafe_b64decode(refreshed["access_token"].split(".")[1] + "=="))
            assert rotated_refresh["typ"] == "Refresh"
            assert set(refreshed["scope"].split()) == set(tokens["scope"].split())
            assert "offline_access" not in rotated_access["scope"].split()
            assert rotated_access["exp"] - rotated_access["iat"] <= 300
            try:
                exchange({"grant_type": "refresh_token", "client_id": "context-codex",
                          "refresh_token": tokens["refresh_token"], "resource": resource})
                raise AssertionError("Refresh token reuse was accepted")
            except urllib.error.HTTPError as error:
                assert error.code == 400
            print("Codex-compatible refresh, unchanged online grant/lifetime, rotation and replay rejection: passed", flush=True)
            chatgpt_code = authorize(verifier, "context-chatgpt")
            confidential = exchange({"grant_type": "authorization_code", "client_id": "context-chatgpt", "code": chatgpt_code,
                                     "redirect_uri": "http://127.0.0.1:8765/callback", "resource": resource, "code_verifier": verifier},
                                    "synthetic-local-only-client-secret")
            assert confidential["access_token"]
            assert claims(confidential["refresh_token"])["typ"] == "Refresh"
            print("Keycloak confidential client_secret_basic code exchange: passed", flush=True)
            try:
                offline = grant("context-chatgpt", full_scope + " offline_access")
            except urllib.error.HTTPError:
                raise AssertionError("ChatGPT explicit offline authorization was rejected") from None
            offline_claims = claims(offline["refresh_token"])
            assert offline_claims["typ"] == "Offline"
            assert "offline_access" in offline["scope"].split()
            assert 604799 <= offline_claims["exp"] - offline_claims["iat"] <= 604800
            chatgpt_config = next(client for client in realm["clients"] if client["clientId"] == "context-chatgpt")
            # Long production limits are checked as policy, then exercised with accelerated copies.
            assert chatgpt_config["attributes"]["client.offline.session.max.lifespan"] == "2592000"
            assert not realm.get("offlineSessionMaxLifespanEnabled", False)
            print("ChatGPT explicitly requested offline grant with seven-day idle bound: passed", flush=True)
            expiry_provider = provider_for("expiry")
            online_expiry = grant("context-chatgpt", full_scope, expiry_provider)
            expiry_tokens = grant("context-chatgpt", full_scope + " offline_access", expiry_provider)
            expiry_access = claims(expiry_tokens["access_token"])
            time.sleep(max(0, expiry_access["iat"] + 9 - time.time()))
            assert expiry_access["exp"] <= time.time()
            rejected(lambda: renew("context-chatgpt", online_expiry, expiry_provider))
            expiry_refreshed = renew("context-chatgpt", expiry_tokens, expiry_provider)
            renewed_access = claims(expiry_refreshed["access_token"])
            audiences = [renewed_access["aud"]] if isinstance(renewed_access.get("aud"), str) else renewed_access.get("aud", [])
            assert resource in audiences, "ChatGPT offline refresh lost the exact resource audience"
            assert renewed_access["exp"] - renewed_access["iat"] <= 5
            assert set(expiry_refreshed["scope"].split()) == set(expiry_tokens["scope"].split())
            assert claims(expiry_refreshed["refresh_token"])["typ"] == "Offline"
            subprocess.run(["node", "dist/scripts/provider-smoke-client.js"], check=True,
                           input=json.dumps({"issuer": expiry_provider["issuer"], "accessToken": expiry_refreshed["access_token"],
                                             "ownerSubject": "00000000-0000-4000-8000-000000000002"}), text=True)
            print("ChatGPT offline refresh retains protected MCP access after online idle/max expiry: passed", flush=True)
            idle_provider = provider_for("idle")
            idle_grant = grant("context-chatgpt", full_scope + " offline_access", idle_provider)
            idle_end = claims(idle_grant["refresh_token"])["exp"]
            assert 0 < idle_end - claims(idle_grant["refresh_token"])["iat"] <= 4
            time.sleep(max(0, idle_end + 1 - time.time()))
            rejected(lambda: renew("context-chatgpt", idle_grant, idle_provider))
            print("ChatGPT offline idle expiration denies refresh: passed", flush=True)

            maximum_provider = provider_for("maximum")
            maximum_grant = grant("context-chatgpt", full_scope + " offline_access", maximum_provider)
            codex_offline = grant("context-codex", full_scope + " offline_access", maximum_provider)
            codex_online = grant("context-codex", full_scope, maximum_provider)
            initial = claims(maximum_grant["refresh_token"])
            assert 0 < initial["exp"] - initial["iat"] <= 6, "ChatGPT client max is not enforced"
            codex_maximum = claims(codex_offline["refresh_token"])
            assert 59 <= codex_maximum["exp"] - codex_maximum["iat"] <= 60, "Codex offline idle changed"
            time.sleep(max(0, initial["iat"] + 2 - time.time()))
            maximum_rotated = renew("context-chatgpt", maximum_grant, maximum_provider)
            assert claims(maximum_rotated["refresh_token"])["exp"] == initial["exp"], "Refresh extended absolute max"
            time.sleep(max(0, initial["exp"] + 1 - time.time()))
            rejected(lambda: renew("context-chatgpt", maximum_rotated, maximum_provider))
            codex_offline_rotated = renew("context-codex", codex_offline, maximum_provider)
            assert claims(codex_offline_rotated["refresh_token"])["exp"] > codex_maximum["exp"]
            codex_online_rotated = renew("context-codex", codex_online, maximum_provider, full_scope + " offline_access")
            assert claims(codex_online_rotated["refresh_token"])["typ"] == "Refresh"
            assert "offline_access" not in codex_online_rotated["scope"].split()
            subprocess.run(["node", "dist/scripts/provider-smoke-client.js"], check=True,
                           input=json.dumps({"issuer": maximum_provider["issuer"], "accessToken": codex_online_rotated["access_token"],
                                             "ownerSubject": "00000000-0000-4000-8000-000000000004"}), text=True)
            time.sleep(max(0, codex_maximum["iat"] + 13 - time.time()))
            assert claims(renew("context-codex", codex_offline_rotated, maximum_provider)["refresh_token"])["typ"] == "Offline"
            assert claims(renew("context-codex", codex_online_rotated, maximum_provider)["refresh_token"])["typ"] == "Refresh"
            print("ChatGPT client max with realm cap disabled; Codex offline policy and online refresh unchanged: passed", flush=True)

            first_rotation = renew("context-chatgpt", offline)
            second_rotation = renew("context-chatgpt", first_rotation, scope=offline["scope"])
            assert first_rotation["refresh_token"] != offline["refresh_token"]
            assert second_rotation["refresh_token"] != first_rotation["refresh_token"]
            assert set(second_rotation["scope"].split()) == set(offline["scope"].split())
            rejected(lambda: renew("context-chatgpt", offline))
            print("ChatGPT omitted/unchanged refresh scopes, rotation and stale replay rejection: passed", flush=True)

            concurrent_grant = grant("context-chatgpt", full_scope + " offline_access")
            barrier = threading.Barrier(2)
            def concurrent_refresh():
                barrier.wait(timeout=10)
                try:
                    renew("context-chatgpt", concurrent_grant)
                    return True
                except urllib.error.HTTPError as error:
                    assert error.code in [400, 401]
                    assert json.load(error).get("error") in ["invalid_grant", "invalid_token"]
                    return False
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                futures = [executor.submit(concurrent_refresh) for _ in range(2)]
                assert sum(future.result() for future in futures) == 1, "Same refresh token succeeded twice"
            print("Concurrent same-token refresh: one accepted, one rejected; client serialization still required: passed", flush=True)

            revocable = grant("context-chatgpt", full_scope + " offline_access")
            revoke = urllib.request.Request(metadata["revocation_endpoint"], data=urllib.parse.urlencode({
                "client_id": "context-chatgpt", "token": revocable["refresh_token"], "token_type_hint": "refresh_token"
            }).encode(), headers={"Authorization": "Basic " + base64.b64encode(
                b"context-chatgpt:synthetic-local-only-client-secret").decode()})
            with urllib.request.urlopen(revoke, timeout=10) as response:
                assert response.status == 200
            rejected(lambda: renew("context-chatgpt", revocable))
            print("ChatGPT explicit offline grant revocation denies refresh: passed", flush=True)
            reduced_tokens = {}
            for name, scope in [
                ("missingProjectToken", "context:read context:write context:process synthetic:hosted-pilot"),
                ("missingProcessToken", "context:read context:write synthetic:hosted-pilot synthetic:project-a synthetic:project-b"),
            ]:
                reduced_code = authorize(verifier, scope=scope)
                reduced_tokens[name] = exchange({
                    "grant_type": "authorization_code", "client_id": "context-codex", "code": reduced_code,
                    "redirect_uri": "http://127.0.0.1:8765/callback", "resource": resource, "code_verifier": verifier,
                })["access_token"]
            for access_token in [tokens["access_token"], confidential["access_token"]]:
                proof = {"issuer": issuer, "accessToken": access_token}
                if access_token == tokens["access_token"]:
                    proof.update(reduced_tokens)
                subprocess.run(["node", "dist/scripts/provider-smoke-client.js"], check=True,
                               input=json.dumps(proof), text=True)
        finally:
            subprocess.run(["docker", "rm", "--force", container], capture_output=True)


if __name__ == "__main__":
    main()
