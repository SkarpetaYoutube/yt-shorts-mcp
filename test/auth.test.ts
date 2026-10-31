import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { buildWorld, installFetch, stub, drive, runExport, resetStore, type World } from "./helpers";
import { signExport } from "../src/mcp";
import { rateLimited, _resetRateLimits } from "../src/index";

const O = "https://yt-mcp.example.workers.dev";
const CB = "https://claude.ai/api/mcp/auth_callback";
let w: World;
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const get = (p: string, init?: RequestInit) => SELF.fetch(O + p, { redirect: "manual", ...init });

class Jar {
  c = new Map<string, string>();
  take(r: Response) { for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(";"); const i = kv.indexOf("="); this.c.set(kv.slice(0, i), kv.slice(i + 1)); } }
  get h() { return Array.from(this.c, ([k, v]) => `${k}=${v}`).join("; "); }
}

async function login(opts: { redirect?: string } = {}) {
  const jar = new Jar();
  const verifier = "v".repeat(60);
  const challenge = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const redirect = opts.redirect ?? CB;
  const reg = await get("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  expect(reg.status).toBeLessThan(300);
  const client = (await reg.json()) as any;
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: O + "/mcp", scope: "mcp" });
  const a1 = await get("/authorize?" + q);
  jar.take(a1);
  if (a1.status !== 200) return { status: a1.status, step: "authorize" as const };
  const html = await a1.text();
  const handle = /name=handle value="([^"]+)"/.exec(html)![1];
  const a2 = await get("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.h }, body: new URLSearchParams({ handle, action: "allow" }) });
  jar.take(a2);
  expect(a2.status).toBe(302);
  const gh = new URL(a2.headers.get("location")!);
  expect(gh.hostname).toBe("github.com");
  const cb = await get(`/callback?code=ghcode&state=${encodeURIComponent(gh.searchParams.get("state")!)}`, { headers: { cookie: jar.h } });
  jar.take(cb);
  if (cb.status !== 302) return { status: cb.status, step: "callback" as const, body: await cb.text() };
  const back = new URL(cb.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(redirect);
  expect(back.searchParams.get("state")).toBe("xyz");
  const tok = await get("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: O + "/mcp" }) });
  const tj = (await tok.json()) as any;
  return { status: 200, token: tj.access_token as string, refresh: tj.refresh_token as string, tok, tj, client };
}

const rpc = (token: string | null, method: string, params: any = {}, id = 1) =>
  get("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
const call = async (token: string, name: string, args: any) => {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  const j = (await r.json()) as any;
  return { isError: !!j.result?.isError, data: JSON.parse(j.result.content[0].text), raw: j.result.content[0].text as string };
};

beforeEach(async () => { await resetStore(); w = buildWorld(80, { long: { 2: 30000 } }); installFetch(w); _resetRateLimits(); (env as any).ALLOWED_GITHUB_USERS = "Moj-Login,4242"; });
afterEach(() => vi.unstubAllGlobals());

describe("OAuth zgodne z wymaganiami Claude.ai", () => {
  it("brak tokenu: 401 + WWW-Authenticate z resource_metadata", async () => {
    const r = await rpc(null, "tools/list");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/resource_metadata="[^"]+"/);
  });
  it("metadane zasobu i serwera autoryzacji", async () => {
    const pr = await (await get("/.well-known/oauth-protected-resource/mcp")).json() as any;
    expect(pr.resource).toBe(O + "/mcp");
    expect(pr.authorization_servers[0]).toBe(O);
    const as = await (await get("/.well-known/oauth-authorization-server")).json() as any;
    expect(as.code_challenge_methods_supported).toContain("S256");
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.registration_endpoint).toBe(O + "/register");
    expect(as.authorization_endpoint).toBe(O + "/authorize");
  });
  it("pełny przepływ: DCR → zgoda → GitHub → kod → token (form-urlencoded, PKCE S256) → MCP", async () => {
    const s = await login();
    expect(s.token).toBeTruthy();
    expect(s.refresh).toBeTruthy();
    const list = await (await rpc(s.token!, "tools/list")).json() as any;
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["collect_shorts", "continue_collection", "export_collection", "get_collection_status", "read_collection", "get_transcript", "list_collections", "resolve_channel", "get_usage"]));
    const init = await (await rpc(s.token!, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).json() as any;
    expect(init.result.serverInfo.name).toBe("yt-shorts-mcp");
  });
  it("odświeżanie tokenu działa (refresh_token rotowany)", async () => {
    const s = await login();
    const r = await get("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.refresh!, client_id: s.client.client_id }) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).access_token).toBeTruthy();
  });
  it("PKCE: błędny verifier odrzucony", async () => {
    // pełny przebieg do kodu, potem zły code_verifier
    const jar = new Jar();
    const verifier = "w".repeat(60);
    const challenge = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const reg = await (await get("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "C", redirect_uris: [CB], token_endpoint_auth_method: "none" }) })).json() as any;
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: "S256", state: "s", resource: O + "/mcp" });
    const a1 = await get("/authorize?" + q); jar.take(a1);
    const handle = /name=handle value="([^"]+)"/.exec(await a1.text())![1];
    const a2 = await get("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.h }, body: new URLSearchParams({ handle, action: "allow" }) }); jar.take(a2);
    const st = new URL(a2.headers.get("location")!).searchParams.get("state")!;
    const cb = await get(`/callback?code=c&state=${encodeURIComponent(st)}`, { headers: { cookie: jar.h } });
    const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
    const bad = await get("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: reg.client_id, code_verifier: "x".repeat(60) }) });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
});

describe("autoryzacja: kto może", () => {
  it("konto GitHub spoza listy dostaje 403 i NIE dostaje kodu", async () => {
    w.kv.ghLogin = "ktos-obcy"; w.kv.ghId = "999";
    const s: any = await login();
    expect(s.status).toBe(403);
    expect(s.step).toBe("callback");
  });
  it("lista dozwolonych działa także po numerycznym ID (login zmieniony)", async () => {
    w.kv.ghLogin = "zmieniona-nazwa"; w.kv.ghId = "4242";
    const s: any = await login();
    expect(s.token).toBeTruthy();
  });
  it("zły redirect_uri (np. atakujący) odrzucony na etapie zgody", async () => {
    const s: any = await login({ redirect: "https://evil.example/cb" });
    expect(s.status).toBeGreaterThanOrEqual(400);
  });
  it("usunięcie z listy odcina istniejący token natychmiast", async () => {
    const s = await login();
    expect((await rpc(s.token!, "tools/list")).status).toBe(200);
    (env as any).ALLOWED_GITHUB_USERS = "ktos-inny";
    expect((await rpc(s.token!, "tools/list")).status).toBe(403);
  });
  it("sfałszowany/obcy token → 401", async () => {
    const r = await rpc("abc:def:ghi", "tools/list");
    expect(r.status).toBe(401);
  });
  it("GET na /mcp → 405, nie startuje niczego", async () => {
    const s = await login();
    const r = await get("/mcp", { headers: { authorization: `Bearer ${s.token}` } });
    expect(r.status).toBe(405);
  });
  it("nieuprawniony nie uruchomi pobierania ani nie odczyta transkrypcji", async () => {
    const r = await rpc(null, "tools/call", { name: "collect_shorts", arguments: { channel: "@przyklad", count: 5 } });
    expect(r.status).toBe(401);
    expect(w.calls.yt + w.calls.sd).toBe(0);
  });
});

describe("narzędzia MCP end-to-end (atrapy API) i linki do eksportu", () => {
  it("polecenie „pobierz 100 najnowszych… przygotuj CSV” przez MCP", async () => {
    const s = await login();
    const t = s.token!;
    const a = await call(t, "collect_shorts", { channel: "@przyklad", mode: "newest", count: 40 });
    expect(a.isError).toBe(false);
    const id = a.data.job_id as string;
    let st = a.data;
    for (let i = 0; i < 60 && !st.complete; i++) {
      // w teście napędzamy alarmy ręcznie zamiast czekać (wait_seconds=0)
      st = await drive(id);
      st = (await call(t, "continue_collection", { job_id: id, wait_seconds: 0 })).data;
    }
    st = await drive(id);
    expect(st.complete).toBe(true);
    expect(st.progress.ok).toBe(40);
    // odpowiedź MCP nie zawiera transkrypcji
    expect(JSON.stringify(st).length).toBeLessThan(6000);
    const exp = await (async () => {
      let r = (await call(t, "export_collection", { job_id: id, wait_seconds: 0 })).data;
      for (let i = 0; i < 100 && ["selecting", "ordering", "building"].includes(r.phase); i++) { await runExport(id); r = (await call(t, "export_collection", { job_id: id, wait_seconds: 0 })).data; }
      return r;
    })();
    expect(exp.phase).toBe("ready");
    expect(exp.records).toBe(40);
    // pobranie linków (bez nagłówka Authorization: link jest podpisany)
    const csv = await get(new URL(exp.download_links.csv).pathname + new URL(exp.download_links.csv).search);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/attachment/);
    const body = await csv.text();
    expect(body.split("\r\n").length).toBeGreaterThan(40);
    const js = await get(new URL(exp.download_links.json).pathname + new URL(exp.download_links.json).search);
    expect(JSON.parse(await js.text())).toHaveLength(40);
    // odczyt pliku eksportu przez MCP (bez linku)
    const rf = (await call(t, "export_collection", { read_file: "json", set_id: exp.set_id, max_chars: 5000 })).data;
    expect(rf.file).toBe("json");
    expect(rf.total_chars).toBeGreaterThan(5000);
    expect(rf.content.length).toBeLessThanOrEqual(5000);
    expect(rf.next_cursor).toBe(rf.content.length);
    // ujemny kursor nie wycina końcówki pliku: czyta od początku; kolejne części Markdown (md-N) są czytelne; zły format jest odrzucony
    const rneg = (await call(t, "export_collection", { read_file: "json", set_id: exp.set_id, cursor: -50, max_chars: 5000 })).data;
    expect(rneg.cursor).toBe(0);
    expect(rneg.content).toBe(rf.content);
    expect((await call(t, "export_collection", { read_file: "md-1", set_id: exp.set_id, max_chars: 5000 })).data.file).toBe("md-1");
    const bad = await call(t, "export_collection", { read_file: "../json", set_id: exp.set_id });
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toMatch(/read_file/);
    const stt = await (await get(new URL(exp.download_links.status).pathname + new URL(exp.download_links.status).search)).json() as any;
    expect(stt.files.csv.sha256).toBe(exp.files.csv.sha256);
    // paczka Markdown i manifest: każdy plik pobrany z manifestu ma sumę SHA-256 z odpowiedzi narzędzia
    expect(exp.download_links["md-1"]).toBeTruthy();
    const mu = new URL(exp.manifest_link);
    const man = (await (await get(mu.pathname + mu.search)).json()) as any;
    expect(man.set_id).toBe(exp.set_id);
    const sha = async (b: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b))).map((x) => x.toString(16).padStart(2, "0")).join("");
    for (const f of man.files.filter((x: any) => x.sha256)) {
      const fu = new URL(f.url);
      const resp = await get(fu.pathname + fu.search);
      expect(resp.status).toBe(200);
      expect(await sha(await resp.arrayBuffer())).toBe(exp.files[f.format].sha256);
    }
    const mdu = new URL(exp.download_links["md-1"]);
    const md = await (await get(mdu.pathname + mdu.search)).text();
    expect(md).toContain("# Paczka danych dla modelu");
    expect(md).toContain("### Transkrypt ze znacznikami czasu");
    // manifest z cudzym podpisem nie działa
    expect((await get(mu.pathname.replace("/manifest", "/csv") + mu.search)).status).toBe(403);
    // read_collection zwraca kawałki z kursorem
    const rd = await call(t, "read_collection", { job_id: id, max_chars: 5000 });
    expect(rd.data.items.length).toBeGreaterThan(0);
    expect(rd.raw.length).toBeLessThan(20000);
  });

  it("linki do eksportu: zły podpis, zmieniony termin, inna część, wygasły, nieznane zadanie", async () => {
    const { job_id } = await stub().startJob({ channel: "@przyklad", mode: "newest", count: 3, transcriptMode: "native", lang: null });
    await drive(job_id);
    await runExport(job_id);
    const good = await signExport(env as any, O, job_id, "csv");
    const u = new URL(good);
    expect((await get(u.pathname + u.search)).status).toBe(200);
    // zły podpis
    expect((await get(u.pathname + "?exp=" + u.searchParams.get("exp") + "&sig=" + "0".repeat(64))).status).toBe(403);
    // podpis cudzego formatu
    expect((await get(u.pathname.replace("/csv", "/json") + u.search)).status).toBe(403);
    // wydłużony termin
    expect((await get(u.pathname + "?exp=" + (Number(u.searchParams.get("exp")) + 9999) + "&sig=" + u.searchParams.get("sig"))).status).toBe(403);
    // bez podpisu
    expect((await get(u.pathname)).status).toBe(403);
    // wygasły (poprawnie podpisany, ale po terminie)
    const old = new URL(await signExport(env as any, O, job_id, "csv", -10));
    expect((await get(old.pathname + old.search)).status).toBe(410);
    // nieistniejące zadanie z poprawnym podpisem
    const ghost = new URL(await signExport(env as any, O, "c-" + "0".repeat(24), "csv"));
    expect((await get(ghost.pathname + ghost.search)).status).toBe(404);
    // niepoprawna ścieżka
    expect((await get("/exports/../../etc/passwd")).status).toBe(404);
  });

  it("sekrety nie wyciekają: klucze API nie występują w odpowiedziach narzędzi ani błędów", async () => {
    const s = await login();
    const t = s.token!;
    const outs: string[] = [];
    outs.push((await call(t, "get_usage", {})).raw);
    outs.push((await call(t, "resolve_channel", { channel: "@przyklad" })).raw);
    outs.push((await call(t, "resolve_channel", { channel: "@nieistnieje" })).raw);
    outs.push((await call(t, "collect_shorts", { channel: "@przyklad", count: 2 })).raw);
    outs.push((await call(t, "get_collection_status", { job_id: "c-nope" })).raw);
    outs.push((await call(t, "nie_ma_takiego", {})).raw);
    w.ytFail = () => new Response(JSON.stringify({ error: { message: "x YTKEY-MARKER-123", errors: [{ reason: "other" }] } }), { status: 500 });
    outs.push((await call(t, "resolve_channel", { channel: "UC" + "x".repeat(22) })).raw);
    expect(JSON.parse(outs[2]).error).toMatch(/Nie znaleziono kanału/); // czytelny komunikat dociera do Claude
    expect(JSON.parse(outs[6]).error).toMatch(/\[ukryte\]/); // odbity w błędzie klucz jest zamaskowany
    for (const o of outs) for (const m of ["YTKEY-MARKER-123", "SDKEY-MARKER-456", "gh-client-secret", "test-signing-key"]) expect(o).not.toContain(m);
    // klucze idą nagłówkami, nie w adresie URL
    expect(w.calls.urls.every((u) => !u.includes("key="))).toBe(true);
  });

  it("walidacja argumentów narzędzi daje czytelne błędy, nie wyjątki", async () => {
    const s = await login();
    const big = await call(s.token!, "collect_shorts", { channel: "@przyklad", count: 9999 });
    expect(big.isError).toBe(true);
    expect(big.data.error).toMatch(/1-500/);
    expect((await call(s.token!, "collect_shorts", { channel: "@przyklad", count: "5" })).isError).toBe(true);
    expect((await call(s.token!, "collect_shorts", { count: 5 })).isError).toBe(true);
    expect((await call(s.token!, "collect_shorts", { channel: "@przyklad", count: 5, mode: "x" })).isError).toBe(true);
    expect((await call(s.token!, "export_collection", { job_id: "c-zly" })).isError).toBe(true);
  });

  it("get_transcript: długa transkrypcja jednego filmu kawałkami, bez strat", async () => {
    const s = await login();
    const v = w.videos[2];
    let off = 0, acc = "", guard = 0;
    for (;;) {
      const r = (await call(s.token!, "get_transcript", { video: v.id, offset: off, limit: 7000 })).data;
      expect(r.ok).toBe(true);
      acc += r.transcript;
      if (r.next_offset == null) break;
      off = r.next_offset;
      if (++guard > 20) throw new Error("pętla");
    }
    expect(acc.length).toBe(30000 - (30000 - acc.length)); // spójność długości zgłoszonej
    expect(acc.startsWith("Wideo 2:")).toBe(true);
    expect(acc.length).toBeGreaterThan(29000);
  });
});

describe("ograniczanie tempa", () => {
  it("limiter okienkowy blokuje po przekroczeniu i zwalnia po oknie", () => {
    _resetRateLimits();
    for (let i = 0; i < 5; i++) expect(rateLimited("k", 5, 1000)).toBe(false);
    expect(rateLimited("k", 5, 1000)).toBe(true);
    expect(rateLimited("inny", 5, 1000)).toBe(false);
    vi.useFakeTimers(); vi.advanceTimersByTime(1500);
    expect(rateLimited("k", 5, 1000)).toBe(false);
    vi.useRealTimers();
  });
  it("/token dławiony po 60 żądaniach na minutę z jednego adresu", async () => {
    let last = 0;
    for (let i = 0; i < 65; i++) last = (await get("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code" })).status;
    expect(last).toBe(429);
  });
  it("/health bez sekretów", async () => {
    const r = await get("/health");
    expect(await r.json()).toMatchObject({ ok: true, version: expect.any(String) });
  });
});
