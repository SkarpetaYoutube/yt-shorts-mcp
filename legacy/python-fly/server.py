"""Zdalny serwer MCP (Streamable HTTP) łączący oba zestawy narzędzi:

  - youtube_mcp.py   -> statystyki z YouTube Data API v3
  - supadata_mcp.py  -> transkrypcje z Supadata

Jeden adres (https://TWOJA-DOMENA/mcp) = jeden konektor w Claude.ai z narzędziami z obu modułów.

Zabezpieczenia:
  - logowanie OAuth przez GitHub (bez żądania uprawnień do konta: tylko publiczny profil),
  - lista dozwolonych użytkowników (login lub numeryczne ID GitHub) egzekwowana przy wydawaniu tokenu
    ORAZ przy każdym żądaniu,
  - przekierowania OAuth ograniczone do adresów zwrotnych Claude,
  - ograniczanie liczby żądań na IP, brak logów dostępu (w adresach callbacku są kody autoryzacji),
  - wszystkie sekrety wyłącznie ze zmiennych środowiskowych.

Uruchomienie lokalne:  python server.py   (patrz .env.example)
"""
from __future__ import annotations

import collections
import json
import logging
import os
import threading
import time
from urllib.parse import urlparse

import httpx
from fastmcp import FastMCP
from fastmcp.server.auth import AuthContext
from fastmcp.server.auth.providers.github import GitHubProvider
from fastmcp.server.middleware.authorization import AuthMiddleware
from mcp.server.auth.provider import TokenError
from starlette.requests import Request
from starlette.responses import PlainTextResponse

import collect
import supadata_mcp
import youtube_mcp
from common import prune_cache, require_env

log = logging.getLogger("youtube-tools")

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
DEFAULT_REDIRECT_URIS = [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
]

ACCESS_TOKEN_TTL_SECONDS = 90 * 24 * 3600

INSTRUCTIONS = (
    "Narzędzia do analizy YouTube Shorts. Statystyki: list_channel_videos (N shortsów kanału), "
    "get_videos, search_videos (mała dzienna pula wywołań — tylko gdy trzeba szukać po temacie). "
    "Transkrypcje: get_transcript i get_transcripts_batch (paczki do 25 filmów; domyślnie tylko "
    "istniejące napisy, mode=auto generuje je przez AI za dodatkowe kredyty). Hook = pierwsze sekundy filmu. "
    "Do zbierania N Shortsów kanału z PEŁNYMI transkrypcjami i eksportem CSV/JSON: start_collection → "
    "continue_collection (aż complete=true) → export_collection lub read_collection."
)


# ------------------------------------------------------------------ lista dozwolonych

def allowed_identities() -> set[str]:
    """Loginy GitHub (bez względu na wielkość liter) lub numeryczne ID GitHub, po przecinku."""
    raw = require_env("ALLOWED_GITHUB_USERS")
    ids = {x.strip().lower() for x in raw.split(",") if x.strip()}
    if not ids:
        raise RuntimeError("ALLOWED_GITHUB_USERS jest puste — nikt nie miałby dostępu.")
    return ids


def identity_allowed(allowed: set[str], login: str | None, user_id: str | int | None) -> bool:
    return bool(
        (login and login.lower() in allowed) or (user_id is not None and str(user_id) in allowed)
    )


def make_user_check(allowed: set[str]):
    """Druga linia obrony: sprawdzenie na poziomie narzędzi MCP."""

    def only_allowed_users(ctx: AuthContext) -> bool:
        token = ctx.token
        if token is None:
            return False
        claims = token.claims or {}
        return identity_allowed(allowed, claims.get("login"), claims.get("sub"))

    return only_allowed_users


async def fetch_github_user(access_token: str) -> dict | None:
    """Pobiera profil właściciela tokenu GitHub (wydzielone, żeby dało się podmienić w testach)."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            "https://api.github.com/user",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "youtube-tools-mcp",
            },
        )
    return resp.json() if resp.status_code == 200 else None


class RestrictedGitHubProvider(GitHubProvider):
    """GitHubProvider, który wydaje i honoruje tokeny wyłącznie dla dozwolonych użytkowników."""

    def __init__(self, *, allowed: set[str], **kwargs):
        super().__init__(**kwargs)
        self._allowed = allowed

    async def _extract_upstream_claims(self, idp_tokens: dict) -> dict | None:
        # Wywoływane przy wymianie kodu na token i przy odświeżaniu — PRZED wydaniem tokenu przez serwer.
        user = await fetch_github_user(idp_tokens.get("access_token", ""))
        if not user or not identity_allowed(self._allowed, user.get("login"), user.get("id")):
            log.warning("Odrzucono logowanie: użytkownik spoza listy dozwolonych.")
            raise TokenError("unauthorized_client", "Użytkownik nie ma dostępu do tego serwera.")
        return {"login": user.get("login"), "sub": str(user.get("id"))}

    async def load_access_token(self, token: str):
        access = await super().load_access_token(token)
        if access is None:
            return None
        claims = access.claims or {}
        if not identity_allowed(self._allowed, claims.get("login"), claims.get("sub")):
            return None  # np. użytkownika usunięto z listy po wydaniu tokenu
        return access


# ------------------------------------------------------------------- ograniczanie tempa

class RateLimitMiddleware:
    """Proste ograniczenie liczby żądań na adres IP (okno przesuwne, w pamięci procesu)."""

    def __init__(self, app, rules: list[tuple[tuple[str, ...], int, float]]):
        self.app = app
        self.rules = rules  # (prefiksy ścieżek, limit, okno w sekundach)
        self._hits: dict[tuple[int, str], collections.deque] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _client_ip(scope) -> str:
        for name, value in scope.get("headers", []):
            if name == b"fly-client-ip":  # ustawiane przez proxy Fly.io
                return value.decode("latin-1")
        client = scope.get("client")
        return client[0] if client else "unknown"

    def _allow(self, idx: int, ip: str, limit: int, window: float) -> bool:
        now = time.monotonic()
        with self._lock:
            if len(self._hits) > 5000:  # zabezpieczenie przed rozrostem pamięci
                self._hits.clear()
            q = self._hits.setdefault((idx, ip), collections.deque())
            while q and now - q[0] > window:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            return True

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            for idx, (prefixes, limit, window) in enumerate(self.rules):
                if path.startswith(prefixes) and not self._allow(idx, self._client_ip(scope), limit, window):
                    body = json.dumps({"error": "rate_limited", "message": "Zbyt wiele żądań. Spróbuj za chwilę."}).encode()
                    await send({"type": "http.response.start", "status": 429, "headers": [
                        (b"content-type", b"application/json"), (b"retry-after", str(int(window)).encode()),
                        (b"content-length", str(len(body)).encode())]})
                    await send({"type": "http.response.body", "body": body})
                    return
        await self.app(scope, receive, send)


RATE_RULES = [
    (("/register", "/authorize", "/token", "/auth/", "/.well-known/"), 60, 60.0),  # punkty OAuth
    (("/mcp",), 600, 60.0),  # wywołania narzędzi
    (("/exports/",), 30, 60.0),  # pobieranie plików eksportu (podpisane linki)
]


# ------------------------------------------------------------------------- budowa

def _github_provider() -> RestrictedGitHubProvider:
    base_url = require_env("PUBLIC_BASE_URL").rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme != "https" and parsed.hostname not in LOCAL_HOSTS:
        raise RuntimeError("PUBLIC_BASE_URL musi zaczynać się od https:// (poza testami lokalnymi).")
    signing_key = require_env("JWT_SIGNING_KEY")
    if len(signing_key) < 32:
        raise RuntimeError("JWT_SIGNING_KEY musi mieć co najmniej 32 znaki (patrz .env.example).")
    redirects = [u.strip() for u in os.getenv("ALLOWED_REDIRECT_URIS", "").split(",") if u.strip()] \
        or DEFAULT_REDIRECT_URIS
    return RestrictedGitHubProvider(
        allowed=allowed_identities(),
        client_id=require_env("GITHUB_CLIENT_ID"),
        client_secret=require_env("GITHUB_CLIENT_SECRET"),
        base_url=base_url,
        jwt_signing_key=signing_key,  # stały klucz: sesje i rejestracje klientów przeżywają restart
        required_scopes=[],  # bez uprawnień GitHub: wystarcza publiczny profil (domyślne "user" daje zapis do profilu)
        allowed_client_redirect_uris=redirects,  # domyślnie dozwolone jest KAŻDE przekierowanie — zawężamy do Claude
        cache_ttl_seconds=300,  # mniej zapytań do GitHuba; unieważnienie dostępu po najwyżej 5 min
        # Tokeny GitHub OAuth App nie wygasają i nie ma do nich refresh tokenu, więc bez tego token serwera
        # żyłby rok. Skracamy do 90 dni: po tym czasie Claude poprosi o ponowne połączenie konektora.
        fastmcp_access_token_expiry_seconds=ACCESS_TOKEN_TTL_SECONDS,
    )


def build_server(secure: bool = True, auth_provider=None) -> FastMCP:
    """secure=False i auth_provider służą wyłącznie do testów offline."""
    kwargs: dict = {}
    if secure:
        kwargs["auth"] = auth_provider or _github_provider()
        kwargs["middleware"] = [AuthMiddleware(auth=make_user_check(allowed_identities()))]

    # mask_error_details: nieprzewidziane wyjątki nie ujawniają szczegółów; nasze komunikaty (ToolError) przechodzą.
    server = FastMCP("youtube-tools", instructions=INSTRUCTIONS, mask_error_details=True, **kwargs)
    server.mount(youtube_mcp.mcp)
    server.mount(supadata_mcp.mcp)
    server.mount(collect.mcp)
    collect.register_routes(server)

    @server.custom_route("/health", methods=["GET"])
    async def health(_: Request) -> PlainTextResponse:  # bez uwierzytelniania, tylko dla sondy hostingu
        return PlainTextResponse("ok")

    return server


def build_app(secure: bool = True, auth_provider=None):
    server = build_server(secure=secure, auth_provider=auth_provider)
    app = server.http_app(path="/mcp", stateless_http=True)
    return RateLimitMiddleware(app, RATE_RULES)


def configure_logging() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    for noisy in ("httpx", "httpx2", "httpcore", "hpack"):
        logging.getLogger(noisy).setLevel(logging.WARNING)  # logi INFO httpx zawierałyby adresy URL zapytań


def main() -> None:
    import uvicorn

    configure_logging()
    removed = prune_cache()
    jobs = collect.prune_jobs()
    log.info("Start serwera. Usunięto %d starych plików cache i %d starych zadań zbierania.", removed, jobs)
    uvicorn.run(
        build_app(),
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8080")),
        access_log=False,  # adresy /auth/callback zawierają kody autoryzacji — nie logujemy ich
        proxy_headers=True,
        forwarded_allow_ips="*",  # za proxy Fly.io: poprawny schemat i adres klienta
    )


if __name__ == "__main__":
    main()
