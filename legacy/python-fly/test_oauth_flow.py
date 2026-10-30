"""Test pełnego przepływu OAuth (jak robi to Claude.ai) z ATRAPĄ GitHuba.

Co jest prawdziwe: nasz serwer, FastMCP, jego endpointy OAuth, szyfrowany magazyn sesji na dysku, middleware.
Co jest atrapą: GitHub (wymiana kodu na token i /user) oraz same API YouTube/Supadata.
Czego to NIE sprawdza: prawdziwego GitHuba, Fly.io i samego Claude.ai (patrz AUDYT.md).

Uruchom:  python test_oauth_flow.py
"""
import base64
import hashlib
import json
import os
import re
import secrets
import tempfile
import urllib.parse as up

os.environ["MCP_CACHE_DIR"] = tempfile.mkdtemp()
FASTMCP_HOME = tempfile.mkdtemp()  # wspólny między "restartami" serwera
os.environ["FASTMCP_HOME"] = FASTMCP_HOME
BASE = "https://example-app.fly.dev"
os.environ.update({
    "PUBLIC_BASE_URL": BASE, "GITHUB_CLIENT_ID": "gh-client", "GITHUB_CLIENT_SECRET": "gh-secret-FAKE",
    "JWT_SIGNING_KEY": "k" * 48, "ALLOWED_GITHUB_USERS": "Moj-Login",
    "YOUTUBE_API_KEY": "fake-yt", "SUPADATA_API_KEY": "fake-sd",
})

import httpx2
from fastmcp.server.auth.oauth_proxy.upstream import AsyncOAuth2Client
from starlette.testclient import TestClient

import server as srv

CB = "https://claude.ai/api/mcp/auth_callback"
USERS = {  # token GitHuba -> profil
    "gho_code-moj": {"id": 4242, "login": "Moj-Login"},
    "gho_code-obcy": {"id": 7, "login": "obcy"},
}
UPSTREAM_AUTH_URLS: list[str] = []


def gh_token_handler(request: httpx2.Request) -> httpx2.Response:
    form = dict(up.parse_qsl(request.content.decode()))
    return httpx2.Response(200, json={"access_token": "gho_" + form["code"], "token_type": "bearer", "scope": ""})


def gh_api_handler(request: httpx2.Request) -> httpx2.Response:
    token = request.headers["authorization"].split()[-1]
    user = USERS.get(token)
    if not user:
        return httpx2.Response(401, json={"message": "Bad credentials"})
    if request.url.path == "/user":
        return httpx2.Response(200, json=user)
    return httpx2.Response(200, json=[], headers={"x-oauth-scopes": ""})


async def fake_fetch_github_user(access_token: str):
    return USERS.get(access_token)


srv.fetch_github_user = fake_fetch_github_user


def make_app(allowed: str = "Moj-Login"):
    """Buduje serwer od zera (jak po restarcie): ta sama konfiguracja i te same pliki sesji na dysku."""
    os.environ["ALLOWED_GITHUB_USERS"] = allowed
    prov = srv._github_provider()
    original = prov._create_upstream_oauth_client

    def patched() -> AsyncOAuth2Client:
        client = original()
        client._client = httpx2.AsyncClient(transport=httpx2.MockTransport(gh_token_handler))
        return client

    prov._create_upstream_oauth_client = patched
    prov._token_validator._http_client = httpx2.AsyncClient(transport=httpx2.MockTransport(gh_api_handler))
    return srv.build_app(auth_provider=prov)


def client(app):
    return TestClient(app, base_url=BASE, follow_redirects=False)


def pkce():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


def register(c, redirect=CB):
    return c.post("/register", json={
        "redirect_uris": [redirect], "client_name": "Claude", "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"], "token_endpoint_auth_method": "none"})


def start_authorize(c, cid, challenge, state="st-123", redirect=CB):
    return c.get("/authorize", params=dict(
        response_type="code", client_id=cid, redirect_uri=redirect, state=state, code_challenge=challenge,
        code_challenge_method="S256", resource=f"{BASE}/mcp"))


def consent_fields(c, location):
    html = c.get(location).text
    return {
        "txn_id": re.search(r'name="txn_id" value="([^"]+)"', html).group(1),
        "csrf_token": re.search(r'name="csrf_token" value="([^"]+)"', html).group(1),
    }


def run_flow(c, code_for_github: str, cid: str | None = None, action: str = "approve"):
    """Przechodzi: rejestracja -> authorize -> zgoda -> GitHub -> callback. Zwraca (cid, verifier, redirect_do_Claude)."""
    cid = cid or register(c).json()["client_id"]
    verifier, challenge = pkce()
    r = start_authorize(c, cid, challenge)
    assert r.status_code == 302, r.text
    consent_url = r.headers["location"]
    fields = consent_fields(c, consent_url)
    r = c.post(consent_url, data={**fields, "submit": "true", "action": action})
    assert r.status_code in (302, 303), (r.status_code, r.text[:300])
    loc = r.headers["location"]
    if action == "deny":
        return cid, verifier, loc
    UPSTREAM_AUTH_URLS.append(loc)
    assert loc.startswith("https://github.com/login/oauth/authorize"), loc
    state = dict(up.parse_qsl(up.urlparse(loc).query))["state"]
    r = c.get("/auth/callback", params={"code": code_for_github, "state": state})
    assert r.status_code in (302, 303), (r.status_code, r.text[:300])
    return cid, verifier, r.headers["location"]


def exchange(c, cid, verifier, redirect_location):
    q = dict(up.parse_qsl(up.urlparse(redirect_location).query))
    return c.post("/token", data={"grant_type": "authorization_code", "code": q["code"], "redirect_uri": CB,
                                  "client_id": cid, "code_verifier": verifier})


def rpc(c, token, method, params=None):
    r = c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
               headers={"authorization": f"Bearer {token}", "accept": "application/json, text/event-stream"})
    body = r.text
    if "data:" in body:
        body = "".join(line[5:].strip() for line in body.splitlines() if line.startswith("data:"))
    return r.status_code, (json.loads(body) if body else {})


# ------------------------------------------------------------------------------ testy

def test_discovery_matches_claude_requirements():
    with client(make_app()) as c:
        r = c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                   headers={"accept": "application/json, text/event-stream"})
        assert r.status_code == 401 and "resource_metadata" in r.headers["www-authenticate"]
        meta_url = re.search(r'resource_metadata="([^"]+)"', r.headers["www-authenticate"]).group(1)
        prm = c.get(urp(meta_url)).json()
        assert prm["resource"] == f"{BASE}/mcp"  # musi być identyczne z adresem wpisanym w Claude
        asm = c.get("/.well-known/oauth-authorization-server").json()
        assert prm["authorization_servers"][0] == asm["issuer"]
        assert asm["registration_endpoint"] and "S256" in asm["code_challenge_methods_supported"]
        assert asm["client_id_metadata_document_supported"] is True and "none" in asm["token_endpoint_auth_methods_supported"]
        assert not asm.get("scopes_supported")
        r = c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                   headers={"authorization": "Bearer zly", "accept": "application/json, text/event-stream"})
        assert r.status_code == 401
    print("OK  discovery: 401 + resource_metadata, PRM==adres MCP, DCR, CIMD, PKCE S256 (wymagania Claude)")


def urp(url):
    return up.urlparse(url).path


def test_redirect_uri_restricted_to_claude():
    with client(make_app()) as c:
        assert register(c).status_code == 201
        assert register(c, "https://claude.com/api/mcp/auth_callback").status_code == 201
        for bad in ("https://evil.example/cb", "http://localhost:9999/cb", "https://claude.ai.evil.example/api/mcp/auth_callback"):
            r = register(c, bad)
            assert r.status_code == 400, (bad, r.status_code)
        cid = register(c).json()["client_id"]
        _, challenge = pkce()
        r = start_authorize(c, cid, challenge, redirect="https://evil.example/cb")
        assert r.status_code >= 400 or "evil.example" not in r.headers.get("location", ""), r.headers
    print("OK  rejestracja i /authorize odrzucają obce adresy przekierowań (tylko claude.ai / claude.com)")


def test_full_flow_allowed_user_and_security_properties():
    with client(make_app()) as c:
        cid, verifier, loc = run_flow(c, "code-moj")
        # przekierowanie do GitHuba: bez żądanych uprawnień, poprawny callback, stan CSRF
        q = dict(up.parse_qsl(up.urlparse(UPSTREAM_AUTH_URLS[-1]).query))
        assert "scope" not in q and q["redirect_uri"] == f"{BASE}/auth/callback" and q["client_id"] == "gh-client", q
        # powrót do Claude z zachowanym 'state' i kodem
        back = dict(up.parse_qsl(up.urlparse(loc).query))
        assert loc.startswith(CB) and back["state"] == "st-123" and "code" in back
        # PKCE: zły verifier odrzucony, kod jednorazowy
        bad = c.post("/token", data={"grant_type": "authorization_code", "code": back["code"], "redirect_uri": CB,
                                     "client_id": cid, "code_verifier": secrets.token_urlsafe(48)})
        assert bad.status_code in (400, 401) and bad.json()["error"] == "invalid_grant", bad.text
        cid2, verifier2, loc2 = run_flow(c, "code-moj")
        ok = exchange(c, cid2, verifier2, loc2)
        assert ok.status_code == 200 and ok.json()["access_token"], ok.text
        assert ok.json()["expires_in"] <= 90 * 24 * 3600, ok.json()  # token serwera nie żyje dłużej niż 90 dni
        replay = exchange(c, cid2, verifier2, loc2)
        assert replay.status_code in (400, 401), "kod autoryzacji nie może działać drugi raz"
        token = ok.json()["access_token"]
        # wywołanie narzędzi
        st, res = rpc(c, token, "tools/list")
        names = {t["name"] for t in res["result"]["tools"]}
        assert st == 200 and {"list_channel_videos", "get_transcript", "get_transcripts_batch", "start_collection",
                              "continue_collection", "export_collection", "read_collection"} <= names
        st, res = rpc(c, token, "tools/call", {"name": "get_usage", "arguments": {}})
        assert "error" not in res and not res["result"].get("isError"), res
        # token JWT nie zawiera tokenu GitHuba ani sekretów
        payload = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
        assert "gho_" not in json.dumps(payload) and "gh-secret" not in json.dumps(payload)
    print("OK  pełny przepływ (authorize→zgoda→GitHub→callback→token→narzędzia), PKCE, kod jednorazowy, brak scope")


def test_csrf_state_and_deny():
    with client(make_app()) as c:
        cid = register(c).json()["client_id"]
        _, challenge = pkce()
        consent_url = start_authorize(c, cid, challenge).headers["location"]
        fields = consent_fields(c, consent_url)
        r = c.post(consent_url, data={**fields, "csrf_token": "falszywy", "submit": "true", "action": "approve"})
        assert r.status_code >= 400 and "github.com" not in r.headers.get("location", ""), (r.status_code, r.headers)
        # zgoda bez ciasteczka sesji przeglądarki (inna przeglądarka/atakujący) też musi przepaść
        with client(make_app()) as other:
            r = other.post(consent_url, data={**fields, "submit": "true", "action": "approve"})
            assert r.status_code >= 400 and "github.com" not in r.headers.get("location", ""), (r.status_code, r.headers)
        # callback z nieznanym 'state'
        r = c.get("/auth/callback", params={"code": "code-moj", "state": "nieznany"})
        assert r.status_code >= 400 and CB not in r.headers.get("location", ""), (r.status_code, r.headers)
        # odmowa na ekranie zgody -> błąd do klienta, żadnego przejścia do GitHuba
        _, _, loc = run_flow(c, "code-moj", action="deny")
        assert "github.com" not in loc and "error=" in loc, loc
    print("OK  CSRF (zły token, brak ciasteczka), nieznany state w callbacku, odmowa zgody")


def test_foreign_github_user_gets_nothing():
    with client(make_app()) as c:
        cid, verifier, loc = run_flow(c, "code-obcy")
        r = exchange(c, cid, verifier, loc)
        assert r.status_code >= 400 and "access_token" not in r.text, r.text
    print("OK  użytkownik GitHub spoza listy: odmowa już przy wydawaniu tokenu")


def test_access_removed_from_list_and_restart_persistence():
    app1 = make_app("Moj-Login")
    with client(app1) as c:
        cid, verifier, loc = run_flow(c, "code-moj")
        tokens = exchange(c, cid, verifier, loc).json()
    # "restart": nowa instancja, te same pliki sesji i ten sam JWT_SIGNING_KEY
    with client(make_app("Moj-Login")) as c:
        st, res = rpc(c, tokens["access_token"], "tools/list")
        assert st == 200 and res["result"]["tools"], "token powinien przetrwać restart (sesje są na dysku)"
    # lista zawężona do numerycznego ID innego konta -> dotychczasowy token przestaje działać natychmiast
    with client(make_app("999")) as c:
        st, _ = rpc(c, tokens["access_token"], "tools/list")
        assert st == 401, st
    # lista po numerycznym ID właściciela (odporna na zmianę nazwy konta) -> działa
    with client(make_app("4242")) as c:
        st, res = rpc(c, tokens["access_token"], "tools/list")
        assert st == 200 and res["result"]["tools"]
    print("OK  restart serwera nie psuje sesji (token ważny po restarcie), usunięcie z listy blokuje od razu, lista po ID działa")


def test_rate_limit_on_oauth_endpoints():
    with client(make_app()) as c:
        codes = [c.post("/token", data={"grant_type": "authorization_code", "code": "x", "client_id": "x"}).status_code
                 for _ in range(70)]
        assert 429 in codes and codes.index(429) >= 55, codes[:70]
        r = c.post("/token", data={"grant_type": "authorization_code", "code": "x"})
        assert r.status_code == 429 and r.headers.get("retry-after")
        assert c.get("/health").text == "ok"  # healthcheck nie jest ograniczany
    print("OK  ograniczanie żądań na punktach OAuth (429 + Retry-After), /health działa")


def test_collect_tools_and_exports_route_protected():
    jid = "c-" + "A" * 22
    with client(make_app()) as c:
        for name in ("start_collection", "continue_collection", "export_collection", "read_collection"):
            r = c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                     "params": {"name": name, "arguments": {}}},
                       headers={"accept": "application/json, text/event-stream"})
            assert r.status_code == 401, (name, r.status_code)  # bez tokenu żadne narzędzie nie działa
        r = c.get(f"/exports/{jid}/csv")
        assert r.status_code == 403 and "csv" not in r.text.lower()  # bez podpisu nic nie wycieka
        r = c.get(f"/exports/{jid}/csv?e=9999999999&s=" + "0" * 64)
        assert r.status_code == 403
    print("OK  narzędzia zbierania bez tokenu: 401; trasa /exports/ bez poprawnego podpisu: 403")


if __name__ == "__main__":
    for t in (test_discovery_matches_claude_requirements, test_redirect_uri_restricted_to_claude,
              test_full_flow_allowed_user_and_security_properties, test_csrf_state_and_deny,
              test_foreign_github_user_gets_nothing, test_access_removed_from_list_and_restart_persistence,
              test_rate_limit_on_oauth_endpoints, test_collect_tools_and_exports_route_protected):
        t()
    print("Wszystkie testy przepływu OAuth przeszły.")
