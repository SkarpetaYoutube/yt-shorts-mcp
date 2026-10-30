// Logowanie GitHub dla serwera OAuth (biblioteka workers-oauth-provider robi całą resztę protokołu).
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./types";
import { escapeHtml, identityAllowed } from "./util";

const SEC = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const page = (title: string, body: string, status = 200, extra?: Headers) => {
  const h = new Headers(extra);
  for (const [k, v] of Object.entries(SEC)) h.set(k, v);
  h.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com https://claude.ai https://claude.com; frame-ancestors 'none'; base-uri 'none'");
  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
      `<style>body{font:16px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}button{font:inherit;padding:.6rem 1.2rem;margin-right:.5rem}code{background:#eee;padding:0 .3rem}</style>${body}`,
    { status, headers: h },
  );
};

function redirectOk(env: Env, uri: string): boolean {
  // Domyślnie wyłącznie oficjalny callback Claude.ai; lista może być rozszerzona zmienną ALLOWED_REDIRECT_URIS.
  const allowed = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback", ...(env.ALLOWED_REDIRECT_URIS ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  return allowed.includes(uri);
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  if (request.method === "GET") {
    let ar: AuthRequest;
    try {
      ar = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch {
      return page("Błąd", "<h1>Nieprawidłowe żądanie autoryzacji</h1>", 400);
    }
    if (!redirectOk(env, ar.redirectUri)) return page("Odmowa", "<h1>Nieautoryzowany adres zwrotny</h1><p>Ten serwer łączy się tylko z Claude.</p>", 400);
    const d = await env.OAUTH_PROVIDER.describeConsent(ar);
    const tx = await env.OAUTH_PROVIDER.beginConsent(ar);
    return page(
      "Zezwól na dostęp",
      `<h1>Zezwolić na dostęp?</h1><p><b>${escapeHtml(d.clientName)}</b>${d.clientDomain ? ` (${escapeHtml(d.clientDomain)})` : ""} chce użyć Twojego serwera YouTube MCP.</p>` +
        `<p>Dane wrócą do: <code>${escapeHtml(d.redirectHost)}</code></p>` +
        `<form method=post action="${escapeHtml(origin)}/authorize"><input type=hidden name=handle value="${escapeHtml(tx.handle)}">` +
        `<button name=action value=allow>Zaloguj przez GitHub i zezwól</button><button name=action value=deny>Odrzuć</button></form>`,
      200,
      tx.headers,
    );
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const form = await request.clone().formData();
  const handle = String(form.get("handle") ?? "");
  try {
    if (form.get("action") === "deny") {
      const d = await env.OAUTH_PROVIDER.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: d.headers });
    }
    const ok = await env.OAUTH_PROVIDER.approveConsent(request, handle);
    if (!redirectOk(env, ok.request.redirectUri)) return page("Odmowa", "<h1>Nieautoryzowany adres zwrotny</h1>", 400);
    const up = await env.OAUTH_PROVIDER.beginUpstream(ok.request, { headers: ok.headers });
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    gh.searchParams.set("redirect_uri", `${origin}/callback`);
    gh.searchParams.set("scope", "read:user");
    gh.searchParams.set("state", up.state);
    gh.searchParams.set("allow_signup", "false");
    const h = new Headers(up.headers);
    h.set("location", gh.toString());
    h.set("cache-control", "no-store");
    return new Response(null, { status: 302, headers: h });
  } catch (e) {
    console.error("authorize POST failed:", (e as any)?.name, (e as any)?.code, (e as any)?.message);
    return page("Błąd", "<h1>Żądanie wygasło lub jest nieprawidłowe</h1><p>Wróć do Claude i połącz ponownie.</p>", 400);
  }
}

export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return page("Błąd", "<h1>Brak kodu autoryzacji</h1>", 400);
  let resumed;
  try {
    resumed = await env.OAUTH_PROVIDER.finishUpstream(request);
  } catch {
    return page("Błąd", "<h1>Sesja logowania wygasła lub jest nieprawidłowa</h1>", 400);
  }
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "yt-shorts-mcp" },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${url.origin}/callback` }),
    });
    const tok: any = await tokenRes.json().catch(() => ({}));
    if (!tok.access_token) { console.error("github token exchange failed:", tok?.error, tok?.error_description); return page("Błąd", "<h1>GitHub odrzucił logowanie</h1>", 400, resumed.headers); }
    const userRes = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": "yt-shorts-mcp", accept: "application/vnd.github+json" } });
    const user: any = await userRes.json().catch(() => ({}));
    if (!user?.login || user?.id == null) return page("Błąd", "<h1>Nie udało się odczytać konta GitHub</h1>", 400, resumed.headers);
    if (!identityAllowed(env.ALLOWED_GITHUB_USERS, String(user.login), String(user.id))) {
      return page("Brak dostępu", "<h1>To konto nie ma dostępu</h1><p>Konto GitHub nie znajduje się na liście dozwolonych.</p>", 403, resumed.headers);
    }
    const props: Props = { login: String(user.login), id: String(user.id) };
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: resumed.request,
      userId: `gh-${user.id}`,
      metadata: { login: props.login },
      scope: resumed.request.scope,
      props,
    });
    const h = new Headers(resumed.headers);
    h.set("location", redirectTo);
    h.set("cache-control", "no-store");
    return new Response(null, { status: 302, headers: h });
  } catch (e) {
    console.error("callback failed:", (e as any)?.name, (e as any)?.message);
    return page("Błąd", "<h1>Logowanie nie powiodło się</h1>", 500, resumed.headers);
  }
}
