import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize, handleCallback } from "./auth";
import { handleMcp, signExport } from "./mcp";
import { Store } from "./store";
import { hmacHex, identityAllowed, json, safeEqual } from "./util";
import type { Env, Props } from "./types";
import { SERVER_VERSION } from "./constants";

export { Store };

// ---- ograniczenie tempa (w pamięci izolatu; best-effort — twarde limity kosztów siedzą w Durable Object)
const hits = new Map<string, { n: number; reset: number }>();
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    if (hits.size > 500) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    hits.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  return ++h.n > max;
}
export const _resetRateLimits = () => hits.clear();

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: Props }): Promise<Response> {
    const props = (ctx as any).props as Props | undefined;
    // lista dozwolonych sprawdzana przy KAŻDYM żądaniu: usunięcie z listy odcina dostęp od razu
    if (!props || !identityAllowed(env.ALLOWED_GITHUB_USERS, props.login, props.id)) return json({ error: "forbidden" }, 403);
    if (rateLimited(`mcp:${props.id}`, 120, 60_000)) return json({ error: "rate_limited" }, 429, { "retry-after": "30" });
    return handleMcp(request, env, new URL(request.url).origin, props);
  },
};

async function serveExport(request: Request, env: Env, url: URL): Promise<Response> {
  const m = /^\/exports\/([csv]-[a-f0-9]{24})\/(csv|json|status|manifest|md|md-\d{1,3})$/.exec(url.pathname);
  if (!m || request.method !== "GET") return json({ error: "not_found" }, 404);
  const [, id, fmt] = m;
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  const good = await hmacHex(env.SIGNING_KEY, `${id}|${fmt}|${url.searchParams.get("exp")}`);
  if (!Number.isFinite(exp) || !safeEqual(sig, good)) return json({ error: "invalid_link" }, 403);
  if (exp < Date.now() / 1000) return json({ error: "link_expired", hint: "Wywołaj export_collection ponownie, aby dostać nowy link." }, 410);
  if (rateLimited(`dl:${id}`, 60, 60_000)) return json({ error: "rate_limited" }, 429);
  const stub: any = env.STORE.get(env.STORE.idFromName("main"));
  if (fmt === "manifest") {
    // lista wszystkich plików zestawu z nowymi podpisanymi linkami (ważnymi tyle, ile zostało ważności manifestu)
    const info: { phase: string; partial: boolean; files: any; set_id: string } | null = await stub.exportInfo(id);
    if (!info || info.phase !== "ready" || !info.files) return json({ error: "not_ready" }, 404);
    const ttl = Math.max(60, Math.floor(exp - Date.now() / 1000));
    const files = [];
    for (const [f, meta] of Object.entries(info.files as Record<string, { records: number; bytes: number; sha256: string }>)) {
      const ext = f === "csv" ? "csv" : f === "json" ? "json" : "md";
      files.push({ name: `${info.set_id}_${f}.${ext}`, format: f, url: await signExport(env, url.origin, info.set_id, f, ttl), ...meta });
    }
    files.push({ name: `${info.set_id}_status.json`, format: "status", url: await signExport(env, url.origin, info.set_id, "status", ttl), records: null, bytes: null, sha256: null });
    return json({ set_id: info.set_id, partial_export: info.partial, generated_at: new Date().toISOString(), files });
  }
  const chunks: string[] | null = await stub.exportChunks(id, fmt);
  if (!chunks) return json({ error: "not_ready" }, 404);
  const type = fmt === "csv" ? "text/csv; charset=utf-8" : fmt.startsWith("md") ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8";
  const ext = fmt === "status" ? "status.json" : fmt === "md" ? "md" : fmt.startsWith("md-") ? `${fmt}.md` : fmt;
  return new Response(chunks.join(""), {
    headers: {
      "content-type": type,
      "content-disposition": `attachment; filename="shorts-${id}.${ext}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, version: SERVER_VERSION });
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname === "/callback") return handleCallback(request, env);
    if (url.pathname.startsWith("/exports/")) return serveExport(request, env, url);
    return json({ error: "not_found" }, 404);
  },
};

// resource w metadanych musi równać się adresowi MCP, a ten zależy od domeny — provider tworzony leniwie per origin.
const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: apiHandler as any,
      defaultHandler: defaultHandler as any,
      authorizeEndpoint: `${origin}/authorize`,
      tokenEndpoint: `${origin}/token`,
      clientRegistrationEndpoint: `${origin}/register`,
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["mcp"],
      accessTokenTTL: 3600,
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp"], bearer_methods_supported: ["header"], resource_name: "YouTube Shorts MCP" },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/token" || url.pathname === "/register") {
      if (rateLimited(`oauth:${request.headers.get("cf-connecting-ip") ?? "x"}`, 60, 60_000)) return json({ error: "rate_limited" }, 429);
    }
    return providerFor(url.origin).fetch(request, env, ctx);
  },
};
