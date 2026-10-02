export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  R2: R2Bucket;
  YESNAI_BASE: string;
  // 出口节点池：逗号分隔多节点 URL；配置后按「账号 id % 节点数」为每账号固定一个出口节点（见 pool/README.md）
  YESNAI_BASES?: string;
  // 池节点鉴权密钥（wrangler secret put UPSTREAM_POOL_KEY）；仅发往池节点的请求携带
  UPSTREAM_POOL_KEY?: string;
  YESNAI_JWT: string;
  YESNAI_API_TOKEN?: string;
  APP_ORIGIN?: string;
  APP_ACCESS_KEY?: string;
  PROMPT_API_BASE?: string;
  PROMPT_API_KEY?: string;
  PROMPT_API_MODEL?: string;
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
// img2img / infill 的底图+蒙版 base64 会明显超过 2MB，25MB 仍远低于 Cloudflare 请求体上限
const MAX_JSON_BYTES = 25_000_000;
const DEFAULT_ZONE = "Asia/Shanghai";
const DEFAULT_WEEKDAY = ["09:05"];
const DEFAULT_WEEKEND = ["10:00"];
const RETRY_BACKOFF_MS = 30 * 60 * 1000;
const RETRY_MAX = 4;
const UPSTREAM_TIMEOUT_MS = 30_000;
const UPSTREAM_TIMEOUT_QUOTE_MS = 60_000;
const UPSTREAM_TIMEOUT_GENERATE_MS = 300_000;
const GENERATE_POOL_BUDGET_MS = 330_000;
const GALLERY_PAGE_MAX = 60;
const IMG_TYPES: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" };
const NAI_SAMPLER_ALIASES: Record<string, string> = { k_dpmpp_2m_sde: "k_dpmpp_sde" };
const NAI_SAMPLERS = new Set(["k_euler_ancestral", "k_euler", "k_dpm_2", "k_dpm_2_ancestral", "k_dpmpp_2s_ancestral", "k_dpmpp_2m", "k_dpmpp_sde"]);
const NAI_NOISE_SCHEDULES = new Set(["karras", "native", "exponential", "polyexponential"]);

function normalizeNaiBody(body: any) {
  if (!body || typeof body !== "object" || !body.parameters || typeof body.parameters !== "object" || Array.isArray(body.parameters)) return body;
  const parameters = { ...body.parameters };
  const samplerRaw = String(parameters.sampler || "k_euler_ancestral");
  const sampler = NAI_SAMPLER_ALIASES[samplerRaw] || samplerRaw;
  parameters.sampler = NAI_SAMPLERS.has(sampler) ? sampler : "k_euler_ancestral";
  const noise = String(parameters.noise_schedule || "karras");
  parameters.noise_schedule = NAI_NOISE_SCHEDULES.has(noise) ? noise : "karras";
  return { ...body, parameters };
}

class HttpError extends Error {
  requestId?: string;
  attempts?: number;
  constructor(public message: string, public status = 400, public code = "BAD_REQUEST") { super(message); }
}
function nowIso() { return new Date().toISOString(); }
function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  const h = new Headers(JSON_HEADERS);
  h.set("Cache-Control", "no-store");
  Object.entries(headers).forEach(([k, v]) => h.set(k, String(v)));
  return new Response(JSON.stringify(data), { status, headers: h });
}
function error(message: string, status = 400, code = "BAD_REQUEST") { return json({ error: { message, code } }, status); }
function originAllowed(request: Request, env: Env) {
  const origin = request.headers.get("Origin");
  return !origin || origin === (env.APP_ORIGIN || new URL(request.url).origin);
}
function requireOrigin(request: Request, env: Env) { if (!originAllowed(request, env)) throw new HttpError("跨站请求被拒绝", 403, "CSRF_ORIGIN_REJECTED"); }
async function readJson<T>(request: Request): Promise<T> {
  if (Number(request.headers.get("Content-Length") || 0) > MAX_JSON_BYTES) throw new HttpError("请求体过大", 413, "BODY_TOO_LARGE");
  try { return await request.json() as T; } catch { throw new HttpError("请求 JSON 无效", 400, "INVALID_JSON"); }
}
function validTimezone(tz: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
function upstreamPool(env: Env): string[] {
  const raw = String(env.YESNAI_BASES || env.YESNAI_BASE || "https://nai.rinko.ai");
  const list = raw.split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
  return list.length ? list : ["https://nai.rinko.ai"];
}
// sticky：账号 id 取模定节点，id 不变则出口不变；无账号上下文走首节点
function upstreamBase(env: Env, acc?: { id?: number | null } | null): string {
  const pool = upstreamPool(env);
  if (acc?.id == null) return pool[0];
  return pool[Number(acc.id) % pool.length];
}
// 仅直连默认 YESNAI_BASE 的请求不带池密钥，避免把密钥发给非自有节点
function poolKeyHeaders(env: Env, base: string): Record<string, string> {
  if (!env.UPSTREAM_POOL_KEY) return {};
  const direct = (env.YESNAI_BASE || "https://nai.rinko.ai").replace(/\/+$/, "");
  return base === direct ? {} : { "X-Pool-Key": env.UPSTREAM_POOL_KEY };
}
async function yesnaiFetch(env: Env, path: string, init: RequestInit = {}, timeoutMs = UPSTREAM_TIMEOUT_MS, acc: { id?: number | null } | null = null) {
  // Headers 实例没有可枚举的自有属性，对象展开会得到空对象导致 Authorization 丢失（网关 401 根因），先归一为普通对象
  const extra = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init.headers || {});
  const base = upstreamBase(env, acc);
  return fetch(base + path, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json", ...poolKeyHeaders(env, base), ...extra } });
}
async function upstreamJson(response: Response) {
  const text = await response.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { detail: text.slice(0, 300) }; }
  return { response, data };
}
function sanitizedMessage(data: any, fallback: string) { return String(data?.error?.message || data?.detail || data?.message || fallback).slice(0, 300); }
async function forward(response: Response) {
  // Preserve the upstream stream and safe representation headers; never buffer image bodies.
  const h = new Headers();
  for (const name of ["Content-Type", "Content-Length", "Content-Encoding", "ETag", "Last-Modified", "Accept-Ranges", "Content-Range", "Cache-Control"]) {
    const value = response.headers.get(name); if (value) h.set(name, value);
  }
  if (!h.has("Content-Type")) h.set("Content-Type", "application/octet-stream");
  h.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}
function gatewayForwardResponse(response: Response, requestId?: string) {
  // Gateway forwarding must reuse the original body stream, status and statusText.
  // Never forward cookies, authentication challenges, or hop-by-hop headers.
  const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
  const h = new Headers();
  for (const [name, value] of response.headers) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || lower === "www-authenticate" || hopByHop.has(lower)) continue;
    h.set(name, value);
  }
  if (!h.has("Content-Type")) h.set("Content-Type", "application/octet-stream");
  h.set("Cache-Control", "no-store");
  if (requestId) h.set("X-Gateway-Request-Id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}
function gatewayRequestHeaders(request: Request, token: string) {
  const h = new Headers();
  const blocked = new Set(["authorization", "host", "content-length", "connection", "transfer-encoding", "accept-encoding"]);
  request.headers.forEach((value, name) => { if (!blocked.has(name.toLowerCase())) h.set(name, value); });
  h.set("Authorization", `Bearer ${token}`);
  h.set("Content-Type", request.headers.get("Content-Type") || "application/json");
  return h;
}

/* ================= 凭据加密（AES-GCM，密钥由 APP_ACCESS_KEY 派生） ================= */
function toB64(u: Uint8Array) { let s = ""; for (const b of u) s += String.fromCharCode(b); return btoa(s); }
function fromB64(s: string) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
async function encKey(env: Env): Promise<CryptoKey | null> {
  if (!env.APP_ACCESS_KEY) return null;
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.APP_ACCESS_KEY + ":ynai-accounts"));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function seal(env: Env, plain: string): Promise<string> {
  if (!plain) return "";
  const key = await encKey(env);
  if (!key) throw new HttpError("Worker 未配置 APP_ACCESS_KEY，拒绝保存账号凭据", 503, "APP_ACCESS_KEY_REQUIRED");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  return `enc:v1:${toB64(iv)}:${toB64(ct)}`;
}
async function unseal(env: Env, stored: string): Promise<string> {
  if (!stored) return "";
  if (stored.startsWith("plain:")) throw new HttpError("检测到未加密账号凭据，请重新保存该账号", 500, "PLAINTEXT_CREDENTIALS_BLOCKED");
  if (!stored.startsWith("enc:v1:")) return stored;
  const key = await encKey(env);
  if (!key) throw new HttpError("账号凭据已加密但 Worker 未配置 APP_ACCESS_KEY，无法解密", 500, "SERVER_MISCONFIGURED");
  const [, , ivB64, ctB64] = stored.split(":");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64) }, key, fromB64(ctB64));
  return new TextDecoder().decode(pt);
}

/* ================= 账号（多账号整合中转） ================= */
interface AccountRow {
  id: number; label: string; username: string;
  jwt_enc: string; password_enc: string; api_token_enc: string;
  enabled: number; gems_last: number | null;
  last_attempt_slot: string | null; last_attempt_at: string | null; last_success_slot: string | null;
  status: string; last_message: string | null; retry_count: number;
  attempt_slots: string[]; success_slots: string[];             // 当天已尝试/已成功的槽集合（DB 存 JSON 字符串，读出归一为数组）
  weekday_times: string | null; weekend_times: string | null;   // NULL = 跟随全局时刻表
  created_at: string; updated_at: string;
}
function parseSlotList(v: unknown): string[] { try { const a = JSON.parse(String(v ?? "[]")); return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []; } catch { return []; } }
function normalizeAccount<T extends AccountRow>(row: T): T {
  return { ...row, attempt_slots: parseSlotList((row as any).attempt_slots), success_slots: parseSlotList((row as any).success_slots) };
}
function accountPublic(a: AccountRow) {
  return {
    id: a.id, label: a.label || a.username, username: a.username, enabled: a.enabled !== 0,
    has_jwt: Boolean(a.jwt_enc), has_password: Boolean(a.password_enc), has_api_token: Boolean(a.api_token_enc),
    gems_last: a.gems_last, status: a.status, last_message: a.last_message, updated_at: a.updated_at,
    weekday_times: a.weekday_times ? uniqueTimes(parseTimesArray(a.weekday_times), []) : null,
    weekend_times: a.weekend_times ? uniqueTimes(parseTimesArray(a.weekend_times), []) : null,
  };
}
async function listAccounts(env: Env): Promise<AccountRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM accounts ORDER BY id").all<AccountRow>();
  return (results || []).map(normalizeAccount);
}
// 首次运行：把 Worker Secret 里的单账号引导成 accounts 表的第一行，之后统一走表
async function ensureBootstrapped(env: Env) {
  const { results } = await env.DB.prepare("SELECT id FROM accounts LIMIT 1").all();
  if ((results || []).length) return;
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO accounts(label,username,jwt_enc,password_enc,api_token_enc,enabled,created_at,updated_at)
    VALUES(?,?,?,?,?,1,?,?)`)
    .bind("主账号（Secret）", "secret", env.YESNAI_JWT ? await seal(env, env.YESNAI_JWT) : "",
      "", env.YESNAI_API_TOKEN ? await seal(env, env.YESNAI_API_TOKEN) : "", now, now).run();
}
async function getAccount(env: Env, id: number): Promise<AccountRow | null> {
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first<AccountRow>();
  return row ? normalizeAccount(row) : null;
}
// 轮询候选序列：启用且有生图 Token 的账号按 id 稳定排序，D1 原子自增游标取模定起点，
// 从起点旋转后返回——首个即本次轮到的账号，其余作为失败转移顺序。
// 网页「自动」与外部网关 /v1/nai/generate-image 共用同一游标，多账号额度均匀分摊。
async function roundRobinPool(env: Env): Promise<AccountRow[]> {
  const all = (await listAccounts(env)).filter(a => a.enabled);
  const withTok = all.filter(a => a.api_token_enc).sort((x, y) => x.id - y.id);
  if (withTok.length <= 1) return withTok.length ? withTok : (all.length ? [all[0]] : []);
  let start = 0;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO runtime_kv(k,v) VALUES('rr_cursor','1') ON CONFLICT(k) DO UPDATE SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT) RETURNING v`
    ).first<any>();
    start = Math.max(0, (Number(row?.v) || 1) - 1) % withTok.length;
  } catch { /* runtime_kv 未迁移时退化为按 id 顺序，绝不让选号 500 */ }
  return [...withTok.slice(start), ...withTok.slice(0, start)];
}
async function resolveAccount(env: Env, request: Request): Promise<AccountRow> {
  await ensureBootstrapped(env);
  const raw = String(request.headers.get("X-Account-Id") || "").trim();
  if (raw === "auto") {
    const seq = await roundRobinPool(env);
    if (!seq.length) throw new HttpError("没有可用账号——请在设置里添加 YesNAI 账号", 500, "NO_ACCOUNT");
    return seq[0];
  }
  const headerId = Number(raw);
  const acc = headerId ? await getAccount(env, headerId) : null;
  if (acc) return acc;
  const all = await listAccounts(env);
  const active = all.find(a => a.enabled) || all[0];
  if (!active) throw new HttpError("没有可用账号——请在设置里添加 YesNAI 账号", 500, "NO_ACCOUNT");
  return active;
}
async function upstreamLogin(env: Env, username: string, password: string, acc: { id?: number | null } | null = null) {
  const resp = await yesnaiFetch(env, "/api/ynai/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) }, UPSTREAM_TIMEOUT_MS, acc);
  const { data } = await upstreamJson(resp);
  // 上游登录响应存在两种形状：{access_token} 或 {message,data:{access_token}}（线上实测为后者），读法两者兼容
  const jwt = data?.data?.access_token ?? data?.access_token;
  if (!resp.ok || !jwt) throw new HttpError(sanitizedMessage(data, `登录失败（HTTP ${resp.status}）`), resp.ok ? 400 : resp.status === 401 ? 401 : 502, "LOGIN_FAILED");
  return { jwt: String(jwt), uid: data?.data?.uid ?? data?.uid };
}
async function accountJwt(env: Env, acc: AccountRow): Promise<string> {
  const jwt = await unseal(env, acc.jwt_enc);
  if (jwt) return jwt;
  throw new HttpError(`账号「${accountPublic(acc).label}」没有可用 JWT——请重新登录或更新凭据`, 500, "ACCOUNT_NO_JWT");
}
// JWT 过期时若有托管密码则自动重登一次并落库，实现免维护签到
async function refreshJwt(env: Env, acc: AccountRow): Promise<string | null> {
  const password = await unseal(env, acc.password_enc);
  if (!password) return null;
  const { jwt } = await upstreamLogin(env, acc.username, password, acc);
  await env.DB.prepare("UPDATE accounts SET jwt_enc=?,updated_at=? WHERE id=?").bind(await seal(env, jwt), nowIso(), acc.id).run();
  return jwt;
}
async function updateAccount(env: Env, id: number, patch: Record<string, unknown>) {
  const sets: string[] = []; const vals: unknown[] = [];
  for (const k of ["label", "jwt_enc", "password_enc", "api_token_enc"]) if (patch[k] !== undefined) { sets.push(`${k}=?`); vals.push(patch[k]); }
  for (const k of ["enabled", "gems_last", "last_attempt_slot", "last_attempt_at", "last_success_slot", "status", "last_message", "retry_count", "weekday_times", "weekend_times", "attempt_slots", "success_slots"]) if (patch[k] !== undefined) { sets.push(`${k}=?`); vals.push(patch[k]); }
  if (!sets.length) return;
  sets.push("updated_at=?"); vals.push(nowIso()); vals.push(id);
  await env.DB.prepare(`UPDATE accounts SET ${sets.join(",")} WHERE id=?`).bind(...vals).run();
}
async function fetchBalance(env: Env, acc: AccountRow): Promise<number> {
  const resp = await yesnaiFetch(env, "/api/ynai/user/balance", { headers: { Authorization: `Bearer ${await accountJwt(env, acc)}` } }, UPSTREAM_TIMEOUT_MS, acc);
  const { data } = await upstreamJson(resp);
  const gems = Number(data?.data?.balance_gems);
  if (resp.ok && !Number.isNaN(gems)) { await updateAccount(env, acc.id, { gems_last: gems }); return gems; }
  throw new HttpError(sanitizedMessage(data, `余额查询失败（HTTP ${resp.status}）`), 502, "BALANCE_FAILED");
}
// 自动获取生图 Token：用账号自己的 JWT 调站点创建 API Key（等价于控制台手点「创建」）。
// 创建即返回完整 Key（ynai-...）；同名冲突时追加时间戳；JWT 过期自动重登一次。
async function provisionToken(env: Env, acc: AccountRow): Promise<string> {
  const createKey = async (jwt: string, name: string) => {
    const resp = await yesnaiFetch(env, "/api/ynai/tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, allowed_models: [], daily_gems_limit: null, total_gems_limit: null, max_gems_per_request: null, allow_paid_requests: true, allow_free_tier_requests: true }),
    }, UPSTREAM_TIMEOUT_MS, acc);
    const { data } = await upstreamJson(resp);
    if (resp.ok && data?.data?.token) return String(data.data.token);
    throw new HttpError(sanitizedMessage(data, `创建 Token 失败（HTTP ${resp.status}）`), 502, "TOKEN_PROVISION_FAILED");
  };
  let jwt = await accountJwt(env, acc);
  try {
    try { return await createKey(jwt, "yesnai-studio"); }
    catch (e) { return await createKey(jwt, `yesnai-studio-${Date.now() % 100000}`); }   // 重名退避
  } catch (e: any) {
    const reJwt = await refreshJwt(env, acc).catch(() => null);   // JWT 过期 → 自动重登再试
    if (!reJwt) throw e;
    try { return await createKey(reJwt, "yesnai-studio"); }
    catch { return await createKey(reJwt, `yesnai-studio-${Date.now() % 100000}`); }
  }
}

/* ================= 自动签到（全局时刻表 × 每账号独立状态） ================= */
function uniqueTimes(input: unknown, fallback: string[]) {
  const values = Array.isArray(input) ? input : fallback;
  return [...new Set(values.map(v => String(v).trim()).filter(v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v)))].sort();
}
function parseTimesArray(raw: unknown): unknown {
  try { return JSON.parse(String(raw || "[]")); } catch { return []; }
}
// 自动购买图包阈值：1-10000 的整数，非法/缺省回落 8（迁移 0011 默认值）
function clampAutobuyThreshold(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(10000, n) : 8;
}
function parseConfig(row: any) {
  // 存量库可能存进非法时区（老版本未校验），这里兜底防止 cron 整体崩死
  const tz = row?.timezone && validTimezone(row.timezone) ? row.timezone : DEFAULT_ZONE;
  return {
    enabled: row?.enabled !== 0,
    timezone: tz,
    weekday_times: uniqueTimes(parseTimesArray(row?.weekday_times), DEFAULT_WEEKDAY),
    weekend_times: uniqueTimes(parseTimesArray(row?.weekend_times), DEFAULT_WEEKEND),
    autobuy_enabled: Number(row?.autobuy_enabled || 0) !== 0,
    autobuy_threshold: clampAutobuyThreshold(row?.autobuy_threshold),
  };
}
async function getConfig(env: Env) {
  const row = await env.DB.prepare("SELECT * FROM autocheckin_config WHERE id=1").first<any>();
  return parseConfig(row);
}
async function saveConfig(env: Env, patch: any) {
  const current = await getConfig(env);
  const timezone = typeof patch.timezone === "string" && patch.timezone ? patch.timezone : current.timezone;
  if (!validTimezone(timezone)) throw new HttpError("时区无效（需 IANA 名称，如 Asia/Shanghai）", 400, "BAD_TIMEZONE");
  let autobuyThreshold = current.autobuy_threshold;
  if (patch.autobuy_threshold !== undefined) {
    const raw = Number(patch.autobuy_threshold), n = Math.floor(raw);
    if (!Number.isFinite(raw) || raw !== n || n < 1 || n > 10000)
      throw new HttpError("图包购买阈值需为 1-10000 的整数", 400, "BAD_AUTOBUY_THRESHOLD");
    autobuyThreshold = n;
  }
  const config = {
    enabled: patch.enabled === undefined ? current.enabled : Boolean(patch.enabled),
    timezone,
    weekday_times: uniqueTimes(patch.weekday_times, current.weekday_times),
    weekend_times: uniqueTimes(patch.weekend_times, current.weekend_times),
    autobuy_enabled: patch.autobuy_enabled === undefined ? current.autobuy_enabled : Boolean(patch.autobuy_enabled),
    autobuy_threshold: autobuyThreshold,
  };
  if (!config.weekday_times.length && !config.weekend_times.length) throw new HttpError("至少保留一个签到时间", 400, "SCHEDULE_EMPTY");
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO autocheckin_config(id,enabled,timezone,weekday_times,weekend_times,autobuy_enabled,autobuy_threshold,next_run_at,updated_at)
    VALUES(1,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,timezone=excluded.timezone,weekday_times=excluded.weekday_times,weekend_times=excluded.weekend_times,autobuy_enabled=excluded.autobuy_enabled,autobuy_threshold=excluded.autobuy_threshold,updated_at=excluded.updated_at`)
    .bind(config.enabled ? 1 : 0, config.timezone, JSON.stringify(config.weekday_times), JSON.stringify(config.weekend_times), config.autobuy_enabled ? 1 : 0, config.autobuy_threshold, now, now).run();
  return getConfig(env);
}
function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: p.weekday };
}
function slotKey(p: ReturnType<typeof localParts>, time: string) { return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${time}`; }
function slotMinutes(t: string) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3)); }
function dueSlot(times: string[], acc: Pick<AccountRow, "attempt_slots" | "success_slots">, date = new Date(), timezone = DEFAULT_ZONE) {
  const p = localParts(date, timezone);
  const dayTimes = ["Sat", "Sun"].includes(p.weekday) ? times : times; // times 已按工作日/周末选好
  const current = p.hour * 60 + p.minute;
  const due = [...dayTimes].sort().filter(t => current >= slotMinutes(t)); // 升序
  if (!due.length) return null;
  // 补签：优先今天最早一个还没尝试过的槽（覆盖 cron 停机跨槽的情况）；全部试过则落到最新槽进入重试
  // 槽状态按「当天集合」记录而非单值，避免多时间槽互相顶掉对方的已签记录导致整晚重复签到
  const tried = new Set([...(acc.attempt_slots || []), ...(acc.success_slots || [])]);
  const unattempted = due.find(t => !tried.has(slotKey(p, t)));
  return slotKey(p, unattempted || due[due.length - 1]);
}
function todayTimes(config: ReturnType<typeof parseConfig>, date = new Date()) {
  const p = localParts(date, config.timezone);
  return ["Sat", "Sun"].includes(p.weekday) ? config.weekend_times : config.weekday_times;
}
// 账号当天的有效时间槽：账号自定义优先，否则全局时刻表
function effectiveDayTimes(config: ReturnType<typeof parseConfig>, acc: AccountRow, date = new Date()) {
  const p = localParts(date, config.timezone);
  const custom = ["Sat", "Sun"].includes(p.weekday) ? acc.weekend_times : acc.weekday_times;
  if (custom) return uniqueTimes(parseTimesArray(custom), []);
  return ["Sat", "Sun"].includes(p.weekday) ? config.weekend_times : config.weekday_times;
}
function nextSlot(config: ReturnType<typeof parseConfig>, date = new Date()) {
  for (let d = 0; d < 8; d++) {
    const probe = new Date(date.getTime() + d * 86400000);
    const p = localParts(probe, config.timezone);
    const times = ["Sat", "Sun"].includes(p.weekday) ? config.weekend_times : config.weekday_times;
    const current = d === 0 ? p.hour * 60 + p.minute + 1 : -1;
    const t = times.find(x => slotMinutes(x) >= current);
    if (t) return slotKey(p, t);
  }
  return null;
}
function classifyCheckin(response: Response, data: any) {
  if (response.status === 401) return "jwt_expired";
  if (/turnstile/i.test(String(data?.message ?? data?.detail ?? ""))) return "manual_required";
  return response.ok ? "success" : "retry";
}
async function performCheckin(env: Env, acc: AccountRow, slot: string | null, opts: { manual?: boolean } = {}) {
  const config = await getConfig(env);
  const actualSlot = slot || dueSlot(effectiveDayTimes(config, acc), acc);
  if (!actualSlot) return { ok: false, skipped: true, message: "当前没有到点的签到时间" };
  let jwt = await accountJwt(env, acc);
  let response = await yesnaiFetch(env, "/api/user/checkin", { method: "POST", headers: { Authorization: `Bearer ${jwt}` } }, UPSTREAM_TIMEOUT_MS, acc);
  if (response.status === 401) {
    const reJwt = await refreshJwt(env, acc).catch(() => null); // 401 时尝试用托管密码重登一次
    if (reJwt) {
      jwt = reJwt;
      response = await yesnaiFetch(env, "/api/user/checkin", { method: "POST", headers: { Authorization: `Bearer ${jwt}` } }, UPSTREAM_TIMEOUT_MS, acc);
    }
  }
  const { data } = await upstreamJson(response);
  const message = sanitizedMessage(data, response.ok ? "签到成功" : `HTTP ${response.status}`);
  const status = classifyCheckin(response, data);
  const next = response.ok || status !== "retry" ? nextSlot(config) : new Date(Date.now() + RETRY_BACKOFF_MS).toISOString();
  const isNewSlot = acc.last_attempt_slot !== actualSlot;
  const logMsg = `[${accountPublic(acc).label}] ${message}`;
  // 当天槽集合：每次尝试入 attempted，成功追加 success；按天剪枝防膨胀
  const dayPrefix = actualSlot.split("T")[0] + "T";
  const attemptedSlots = [...new Set([...(acc.attempt_slots || []), actualSlot])].filter(k => k.startsWith(dayPrefix));
  const successSlots = response.ok
    ? [...new Set([...(acc.success_slots || []), actualSlot])].filter(k => k.startsWith(dayPrefix))
    : (acc.success_slots || []).filter(k => k.startsWith(dayPrefix));
  if (opts.manual) {
    // 手动测试：成功才推进签到状态；失败只置 retry 供 cron 接手，不动重试计数
    if (response.ok) await updateAccount(env, acc.id, { last_attempt_slot: actualSlot, last_success_slot: actualSlot, status: "success", last_message: message, retry_count: 0, attempt_slots: JSON.stringify(attemptedSlots), success_slots: JSON.stringify(successSlots) });
    else await updateAccount(env, acc.id, { last_attempt_slot: actualSlot, status: "retry", last_message: message, attempt_slots: JSON.stringify(attemptedSlots), success_slots: JSON.stringify(successSlots) });
  } else {
    // 换槽时重试计数归零，保证「每槽最多 1+4 次尝试」
    await updateAccount(env, acc.id, {
      last_attempt_slot: actualSlot, last_success_slot: response.ok ? actualSlot : null, status, last_message: message,
      retry_count: response.ok ? 0 : (isNewSlot ? 1 : acc.retry_count + 1),
      attempt_slots: JSON.stringify(attemptedSlots), success_slots: JSON.stringify(successSlots),
    });
  }
  await env.DB.prepare("INSERT INTO autocheckin_logs(account_id,attempted_at,slot,ok,status_code,message) VALUES(?,?,?,?,?,?)").bind(acc.id, nowIso(), actualSlot, response.ok ? 1 : 0, response.status, logMsg).run();
  return { ok: response.ok, message, status, slot: actualSlot, account: accountPublic(acc).label };
}

// 上游 ynai 业务响应存在两种形状：对象本体或 {message,data:{...}} 包一层，读法统一解包（仅图包购买流程使用）
function unwrapEnvelope(data: any) {
  return data && typeof data === "object" && data.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : data;
}
// 签到完成后按需自动购买图包（默认关闭，迁移 0011）：图包次数低于阈值且余额够 1 包时买 1 包。
// 结果（买了/没买原因/失败原因）写一条 autocheckin_logs（slot='autobuy'）；异常上抛由调用方兜底，绝不影响签到主流程。
async function autoBuyPacks(env: Env, acc: AccountRow) {
  const config = await getConfig(env);
  const threshold = clampAutobuyThreshold(config.autobuy_threshold);
  const label = accountPublic(acc).label;
  const log = (ok: boolean, statusCode: number, message: string) =>
    env.DB.prepare("INSERT INTO autocheckin_logs(account_id,attempted_at,slot,ok,status_code,message) VALUES(?,?,?,?,?,?)")
      .bind(acc.id, nowIso(), "autobuy", ok ? 1 : 0, statusCode, `[${label}] ${message}`.slice(0, 300)).run();
  // 重新读账号行：签到流程可能刚用托管密码重登并刷新过 JWT，取落库后的最新值
  const fresh = (await getAccount(env, acc.id)) || acc;
  const jwt = await accountJwt(env, fresh);
  const info = await upstreamJson(await yesnaiFetch(env, "/api/ynai/image-packs", { headers: { Authorization: `Bearer ${jwt}` } }, UPSTREAM_TIMEOUT_MS, acc));
  const pack = unwrapEnvelope(info.data);
  const credits = Number(pack?.image_pack_credits), gems = Number(pack?.balance_gems), packGems = Number(pack?.pack_gems);
  if (!info.response.ok || !Number.isFinite(credits) || !Number.isFinite(packGems)) {
    await log(false, info.response.status, `查询图包状态失败（HTTP ${info.response.status}）`);
    return;
  }
  if (pack?.enabled === false) { await log(true, info.response.status, `站点已关闭图包，未购买`); return; }
  if (credits >= threshold) { await log(true, info.response.status, `图包次数 ${credits} 未低于阈值 ${threshold}，未购买`); return; }
  if (!Number.isFinite(gems) || gems < packGems) {
    await log(true, info.response.status, `图包次数 ${credits} 低于阈值 ${threshold}，但余额不足（${Number.isFinite(gems) ? gems : "未知"} Gems < 每包 ${packGems} Gems），未购买`);
    return;
  }
  const buy = await upstreamJson(await yesnaiFetch(env, "/api/ynai/image-packs/purchase", {
    method: "POST", headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }, body: JSON.stringify({ packs: 1 }),
  }, UPSTREAM_TIMEOUT_MS, acc));
  if (buy.response.ok) await log(true, buy.response.status, `图包次数 ${credits} 低于阈值 ${threshold}，已自动购买 1 个图包（每包 ${packGems} Gems）`);
  else await log(false, buy.response.status, `自动购买图包失败（HTTP ${buy.response.status}）：${sanitizedMessage(buy.data, "上游错误")}`);
}

async function claimLease(env: Env) {
  const lease = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const r = await env.DB.prepare("UPDATE autocheckin_config SET lease_until=?,updated_at=? WHERE id=1 AND (lease_until IS NULL OR lease_until<?)").bind(lease, nowIso(), nowIso()).run();
  return (r.meta.changes ?? 0) > 0;
}
async function runScheduled(env: Env) {
  await ensureBootstrapped(env);
  const config = await getConfig(env);
  if (!config.enabled) return;
  const accounts = (await listAccounts(env)).filter(a => a.enabled);
  if (!accounts.length) return;
  if (!(await claimLease(env))) return;
  try {
    // 错峰：账号顺序随机打散，每个账号之间 3~8 秒随机间隔，避免整批瞬时连发
    const order = accounts.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < order.length; i++) {
      const acc = order[i];
      if (i > 0) await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
      try {
        const slot = dueSlot(effectiveDayTimes(config, acc), acc);   // 每账号按自己的时刻表取槽
        if (!slot) continue;
        const fresh = !(acc.attempt_slots || []).includes(slot);      // 按当天集合判断，多槽互不误判
        const lastAttempt = acc.last_attempt_at ? Date.parse(acc.last_attempt_at) : 0;
        const backoffOk = !lastAttempt || Date.now() - lastAttempt >= RETRY_BACKOFF_MS;
        const retryable = acc.status === "retry" && acc.retry_count < RETRY_MAX && backoffOk;
        if (!fresh && !retryable) continue;
        await performCheckin(env, acc, slot);
        if (config.autobuy_enabled) {
          // 授权挂接点：签到完成（成功或失败）后按开关自动购买图包；任何异常只记日志，不中断签到主流程
          try { await autoBuyPacks(env, acc); }
          catch (e) { console.error("[autobuy]", accountPublic(acc).label, e); }
        }
      } catch (e) {
        // 单账号故障不拖垮整批；终态错误（过期/人机验证）不再无意义重试
        if (acc.status !== "jwt_expired" && acc.status !== "manual_required") {
          await updateAccount(env, acc.id, { status: "retry", last_message: String(e).slice(0, 300), retry_count: acc.retry_count + 1 }).catch(() => {});
        }
        console.error("[scheduled]", accountPublic(acc).label, e);
      }
    }
  } finally {
    // 跑完（含异常）立即释放租约，下一轮 cron 与手动「立即测试」不再白等 10 分钟；10 分钟过期保留作崩溃兜底
    await env.DB.prepare("UPDATE autocheckin_config SET lease_until=NULL WHERE id=1").run().catch(() => {});
  }
}

/* ================= YesNAI 代理（按所选账号） ================= */
async function yesnaiRoute(request: Request, env: Env, route: string) {
  const acc = await resolveAccount(env, request);
  if (route === "models") return forward(await yesnaiFetch(env, "/v1/models"));
  if (route === "generate") {
    requireOrigin(request, env);
    const apiToken = await unseal(env, acc.api_token_enc);
    if (!apiToken) throw new HttpError(`账号「${accountPublic(acc).label}」未配置生图 API Token（设置里可补填）`, 500, "ACCOUNT_NO_TOKEN");
    const body = normalizeNaiBody(await readJson<any>(request));
    return forward(await yesnaiFetch(env, "/v1/nai/generate-image", { method: "POST", headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, UPSTREAM_TIMEOUT_GENERATE_MS, acc));
  }
  if (route === "quote") { requireOrigin(request, env); const body = await readJson<any>(request); return forward(await yesnaiFetch(env, "/api/ynai/playground/quote", { method: "POST", headers: { Authorization: `Bearer ${await accountJwt(env, acc)}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, UPSTREAM_TIMEOUT_QUOTE_MS, acc)); }
  if (route === "balance") return forward(await yesnaiFetch(env, "/api/ynai/user/balance", { headers: { Authorization: `Bearer ${await accountJwt(env, acc)}` } }, UPSTREAM_TIMEOUT_MS, acc));
  if (route === "checkin") { requireOrigin(request, env); return forward(await yesnaiFetch(env, "/api/user/checkin", { method: "POST", headers: { Authorization: `Bearer ${await accountJwt(env, acc)}` } }, UPSTREAM_TIMEOUT_MS, acc)); }
  // 图片工具代理：复用账号选择，透传上游二进制及表示头。
  if (route.startsWith("ai/")) return imageToolRoute(request, env, route.slice(3));
  throw new HttpError("未知 YesNAI 路由", 404, "ROUTE_NOT_FOUND");
}

// 上游 ynai 中转：前端「注册/一键导入」「钱包/图包/签到」经此访问上游 /api/ynai/* 业务 API；JWT 仅本次请求内存透传，不落盘不打日志。
async function upstreamRelay(request: Request, env: Env) {
  if (Number(request.headers.get("Content-Length") || 0) > 65536) throw new HttpError("relay 请求体过大", 413, "RELAY_BODY_TOO_LARGE");
  const payload = await readJson<any>(request);
  const path = payload?.path;
  // 白名单目的：中转通道只开放给上游业务 API，防止被当作任意目标代理；先做 URL 规范化，防 ../ 与百分号编码绕过。
  const u = new URL(path, upstreamBase(env) + "/");
  const clean = u.pathname + u.search;
  // /api/user/checkin（每日签到）不属于 /api/ynai/ 前缀，按规范化后 pathname 精确匹配放行（允许携带 query，如未来 ?month=）
  if (!clean.startsWith("/api/ynai/") && u.pathname !== "/api/user/checkin") throw new HttpError("仅允许中转 /api/ynai/ 路径与 /api/user/checkin", 403, "RELAY_PATH_DENIED");
  if (!["GET", "POST", "PUT", "DELETE"].includes(payload?.method)) throw new HttpError("不支持的转发方法", 400, "RELAY_METHOD_DENIED");
  const method = payload.method;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = payload?.auth;
  let relayAcc: AccountRow | null = null;
  if (typeof auth === "string" && auth) {
    headers.Authorization = "Bearer " + auth.replace(/^Bearer\s+/i, "");
  } else {
    // 钱包多账号：无 body.auth 时支持 X-Account-Id 头——按池账号解密托管的用户名密码现登上游（不缓存）后转发。
    // 找不到账号或缺托管密码直接拒绝；上游登录失败（含 401）由 upstreamLogin 按上游状态码抛出透传。
    const accountId = Number(String(request.headers.get("X-Account-Id") || "").trim());
    if (accountId) {
      relayAcc = await getAccount(env, accountId);
      const password = relayAcc ? await unseal(env, relayAcc.password_enc) : "";
      if (!relayAcc || !password) throw new HttpError("该账号缺少用户名密码，无法代登录", 400, "ACCOUNT_CREDENTIALS_MISSING");
      const { jwt } = await upstreamLogin(env, relayAcc.username, password, relayAcc);
      headers.Authorization = "Bearer " + jwt;
    }
  }
  const init: RequestInit = { method, headers };
  if (method !== "GET" && payload?.body != null) {
    const serialized = JSON.stringify(payload.body);
    if (serialized.length > 65536) throw new HttpError("relay 请求体过大", 413, "RELAY_BODY_TOO_LARGE");
    init.body = serialized;
  }
  let resp: Response;
  try { resp = await yesnaiFetch(env, clean, init, 30000, relayAcc); }
  catch (e: any) { throw new HttpError("上游站点不可达：" + sanitizedMessage(e, String(e)), 502, "UPSTREAM_UNAVAILABLE"); }
  const text = await resp.text();
  return new Response(text, { status: resp.status, headers: { "Content-Type": resp.headers.get("Content-Type") || "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function imageToolRoute(request: Request, env: Env, route: string) {
  const map: Record<string, string> = { "encode-vibe": "/api/ai/encode-vibe", "upscale": "/api/ai/upscale", "augment-image": "/api/ai/augment-image", "annotate-image": "/api/ai/annotate-image", "suggest-tags": "/api/ai/suggest-tags" };
  const upstreamPath = map[route];
  if (!upstreamPath) throw new HttpError("未知图片工具路由", 404, "ROUTE_NOT_FOUND");
  if (request.method !== "GET") requireOrigin(request, env);
  const acc = await resolveAccount(env, request);
  // AI tools use the upstream API token; retain JWT as a compatibility fallback for old accounts.
  const token = (await unseal(env, acc.api_token_enc).catch(() => "")) || await accountJwt(env, acc);
  const headers = new Headers(request.headers);
  for (const h of ["authorization", "host", "content-length", "connection", "transfer-encoding"]) headers.delete(h);
  headers.set("Authorization", `Bearer ${token}`);
  const toolBase = upstreamBase(env, acc);
  for (const [poolName, poolValue] of Object.entries(poolKeyHeaders(env, toolBase))) headers.set(poolName, poolValue);
  // Request bodies are single-use streams; clone before consuming/forwarding and preserve tool query parameters.
  const target = new URL(toolBase + upstreamPath);
  target.search = new URL(request.url).search;
  const resp = await fetch(target.toString(), { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.clone().arrayBuffer(), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_GENERATE_MS) });
  return forward(resp);
}

async function statsRoute(request: Request, env: Env, kind: "stats" | "logs") {
  const u = new URL(request.url), days = Math.min(Math.max(Number(u.searchParams.get("days")) || 7, 1), 90), since = new Date(Date.now() - days * 86400000).toISOString();
  if (kind === "logs") {
    const limit = Math.min(Math.max(Number(u.searchParams.get("limit")) || 50, 1), 200), offset = Math.max(Number(u.searchParams.get("offset")) || 0, 0), only = String(u.searchParams.get("only") || "");
    const where = ["created_at>=?"]; const binds: any[] = [since];
    if (["ok", "success"].includes(only)) where.push("ok=1"); else if (["failed", "failure"].includes(only)) where.push("ok=0");
    const clause = where.join(" AND ");
    const items = await env.DB.prepare(`SELECT l.id,l.request_id,l.account_id,l.path,l.mode,l.model,l.status_code,l.ok,l.duration_ms,l.bytes_in,l.bytes_out,l.cost_gems,l.created_at,
      (SELECT COUNT(*) FROM request_attempts a WHERE a.request_id=l.request_id) attempts,
      (SELECT a.error FROM request_attempts a WHERE a.request_id=l.request_id AND a.error IS NOT NULL ORDER BY a.id DESC LIMIT 1) error
      FROM request_logs l WHERE ${clause} ORDER BY l.created_at DESC,l.id DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all<any>();
    const total = await env.DB.prepare(`SELECT COUNT(*) c FROM request_logs WHERE ${clause}`).bind(...binds).first<any>();
    return json({ items: items.results || [], logs: items.results || [], total: Number(total?.c || 0) });
  }
  const today = new Date().toISOString().slice(0, 10), t = await env.DB.prepare("SELECT COUNT(*) requests,SUM(ok) ok,SUM(cost_gems) gems,AVG(duration_ms) avg_ms FROM request_logs WHERE substr(created_at,1,10)=?").bind(today).first<any>();
  const daily = await env.DB.prepare("SELECT substr(created_at,1,10) date,COUNT(*) requests,SUM(ok) ok,SUM(cost_gems) gems,AVG(duration_ms) avg_ms FROM request_logs WHERE created_at>=? GROUP BY substr(created_at,1,10) ORDER BY date DESC").bind(since).all<any>();
  const by_model = await env.DB.prepare("SELECT COALESCE(model,'') model,COUNT(*) requests,SUM(ok) ok,SUM(cost_gems) gems,AVG(duration_ms) avg_ms FROM request_logs WHERE created_at>=? GROUP BY model ORDER BY requests DESC").bind(since).all<any>();
  const by_account = await env.DB.prepare("SELECT account_id,COUNT(*) requests,SUM(ok) ok,SUM(cost_gems) gems,AVG(duration_ms) avg_ms FROM request_logs WHERE created_at>=? GROUP BY account_id ORDER BY requests DESC").bind(since).all<any>();
  const failures = await env.DB.prepare("SELECT l.*, (SELECT COUNT(*) FROM request_attempts a WHERE a.request_id=l.request_id) attempts FROM request_logs l WHERE l.ok=0 AND l.created_at>=? ORDER BY l.created_at DESC,l.id DESC LIMIT 20").bind(since).all<any>();
  const requests = Number(t?.requests || 0), ok = Number(t?.ok || 0);
  return json({ today: { requests, ok, success_rate: requests ? ok / requests : 0, gems: Number(t?.gems || 0), avg_ms: Number(t?.avg_ms || 0) },
    // Keep aliases for older clients while the canonical shape is grouped under today.
    today_requests: requests, today_success: ok, today_gems: Number(t?.gems || 0), avg_duration_ms: Number(t?.avg_ms || 0),
    daily: daily.results || [], by_model: by_model.results || [], by_account: by_account.results || [], recent_failures: failures.results || [] });
}

/* ================= 账号管理路由 ================= */
async function accountsRoute(request: Request, env: Env, rest: string) {
  const idMatch = rest.match(/^\/(\d+)(\/.*)?$/);
  // GET /api/accounts —— 列表（绝不含明文凭据）
  if (request.method === "GET" && rest === "") {
    const list = (await listAccounts(env)).map(accountPublic);
    let totalGems = 0; for (const a of list) totalGems += a.gems_last || 0;
    return json({ items: list, total_gems: totalGems });
  }
  // POST /api/accounts —— 用账号密码登录并收录（密码加密托管，JWT 过期自动续）
  if (request.method === "POST" && rest === "") {
    requireOrigin(request, env);
    const body = await readJson<any>(request);
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");
    if (!username || !password) throw new HttpError("用户名和密码必填", 400, "ACCOUNT_FIELDS_REQUIRED");
    const dup = await env.DB.prepare("SELECT id FROM accounts WHERE username=?").bind(username).first<any>();
    if (dup) throw new HttpError("该账号已在账号池中，无需重复添加", 409, "ACCOUNT_EXISTS");
    const { jwt } = await upstreamLogin(env, username, password);
    const now = nowIso();
    const r = await env.DB.prepare(`INSERT INTO accounts(label,username,jwt_enc,password_enc,api_token_enc,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)`)
      .bind(String(body?.label || username).slice(0, 40), username, await seal(env, jwt), await seal(env, password), body?.api_token ? await seal(env, String(body.api_token)) : "", now, now).run();
    const acc = await getAccount(env, Number(r.meta.last_row_id));
    return json(accountPublic(acc!));
  }
  // POST /api/accounts/batch —— 批量导入：{items:[{username,password},...]}，逐个登录收录，单条失败不中断
  if (request.method === "POST" && rest === "/batch") {
    requireOrigin(request, env);
    const body = await readJson<any>(request);
    const items = (Array.isArray(body?.items) ? body.items : [])
      .map((x: any) => ({ username: String(x?.username || "").trim(), password: String(x?.password || "") }))
      .filter((x: any) => x.username && x.password)
      .slice(0, 30);
    if (!items.length) throw new HttpError("没有可导入的账号（格式：账号----密码，每行一个）", 400, "ACCOUNT_BATCH_EMPTY");
    const results: any[] = [];
    const now = nowIso();
    for (const it of items) {
      try {
        if (await env.DB.prepare("SELECT id FROM accounts WHERE username=?").bind(it.username).first<any>()) { results.push({ username: it.username, ok: false, message: "该账号已在账号池中" }); continue; }
        const { jwt } = await upstreamLogin(env, it.username, it.password);
        const r = await env.DB.prepare(`INSERT INTO accounts(label,username,jwt_enc,password_enc,api_token_enc,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)`)
          .bind(it.username.slice(0, 40), it.username, await seal(env, jwt), await seal(env, it.password), "", now, now).run();
        const acc = await getAccount(env, Number(r.meta.last_row_id));
        results.push({ username: it.username, ok: true, label: accountPublic(acc!).label });
      } catch (e: any) {
        results.push({ username: it.username, ok: false, message: String(e?.message || e).slice(0, 120) });
      }
    }
    const list = (await listAccounts(env)).map(accountPublic);
    let totalGems = 0; for (const a of list) totalGems += a.gems_last || 0;
    return json({ results, added: results.filter(x => x.ok).length, items: list, total_gems: totalGems });
  }
  // POST /api/accounts/refresh_gems —— 刷新全部账号余额
  if (request.method === "POST" && rest === "/refresh_gems") {
    requireOrigin(request, env);
    const results: any[] = [];
    for (const acc of await listAccounts(env)) {
      if (!acc.jwt_enc) { results.push({ id: acc.id, ok: false, message: "无 JWT" }); continue; }
      try { const gems = await fetchBalance(env, acc); results.push({ id: acc.id, ok: true, gems }); }
      catch (e: any) { results.push({ id: acc.id, ok: false, message: e.message }); }
    }
    const list = (await listAccounts(env)).map(accountPublic);
    let totalGems = 0; for (const a of list) totalGems += a.gems_last || 0;
    return json({ results, items: list, total_gems: totalGems });
  }
  if (!idMatch) throw new HttpError("未知账号路由", 404, "ROUTE_NOT_FOUND");
  const id = Number(idMatch[1]); const sub = idMatch[2] || "";
  const acc = await getAccount(env, id);
  if (!acc) throw new HttpError("账号不存在", 404, "ACCOUNT_NOT_FOUND");
  // PATCH /api/accounts/{id} —— label / enabled / api_token / schedule / 重新登录
  if (request.method === "PATCH" && sub === "") {
    requireOrigin(request, env);
    const body = await readJson<any>(request);
    const patch: Record<string, unknown> = {};
    if (body?.label !== undefined) patch.label = String(body.label).slice(0, 40);
    if (body?.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
    if (body?.api_token !== undefined) patch.api_token_enc = await seal(env, String(body.api_token).trim());
    if (body?.schedule !== undefined) {
      // schedule:null 或空数组 = 重置跟随全局；{weekday_times, weekend_times} = 每账号自定义
      if (body.schedule === null) { patch.weekday_times = null; patch.weekend_times = null; }
      else {
        const wd = uniqueTimes(body.schedule?.weekday_times, []);
        const we = uniqueTimes(body.schedule?.weekend_times, []);
        if (!wd.length && !we.length) throw new HttpError("自定义时刻表至少保留一个时间", 400, "SCHEDULE_EMPTY");
        patch.weekday_times = wd.length ? JSON.stringify(wd) : null;
        patch.weekend_times = we.length ? JSON.stringify(we) : null;
      }
    }
    if (body?.password) { // 更新托管密码并立即重登刷新 JWT
      const { jwt } = await upstreamLogin(env, acc.username, String(body.password), acc);
      patch.password_enc = await seal(env, String(body.password));
      patch.jwt_enc = await seal(env, jwt);
    }
    await updateAccount(env, id, patch);
    return json(accountPublic((await getAccount(env, id))!));
  }
  // POST /api/accounts/{id}/provision_token —— 用该账号身份自动创建生图 API Token
  if (request.method === "POST" && sub === "/provision_token") {
    requireOrigin(request, env);
    const token = await provisionToken(env, acc);
    await updateAccount(env, id, { api_token_enc: await seal(env, token) });
    return json({ ok: true, label: accountPublic(acc).label, has_api_token: true });
  }
  // GET /api/accounts/{id}/balance
  if (request.method === "GET" && sub === "/balance") return json({ gems: await fetchBalance(env, acc) });
  // POST /api/accounts/{id}/test —— 单账号手动签到
  if (request.method === "POST" && sub === "/test") {
    requireOrigin(request, env);
    return json(await performCheckin(env, acc, null, { manual: true }));
  }
  // DELETE /api/accounts/{id}
  if (request.method === "DELETE" && sub === "") {
    requireOrigin(request, env);
    await env.DB.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
    return json({ ok: true });
  }
  throw new HttpError("未知账号路由", 404, "ROUTE_NOT_FOUND");
}

/* ================= 画廊（R2 + D1） ================= */
function b64ToBytes(b64: string): Uint8Array { return fromB64(b64); }
async function galleryRoute(request: Request, env: Env, rest: string) {
  // POST /api/gallery —— 上传一张（原图 + canvas 缩略图 + 元数据）
  if (request.method === "POST" && rest === "") {
    requireOrigin(request, env);
    const body = await readJson<any>(request);
    const image = String(body?.image || "");
    const fmt = String(body?.fmt || "png").toLowerCase();
    if (!image) throw new HttpError("缺少图片数据", 400, "GALLERY_NO_IMAGE");
    if (!IMG_TYPES[fmt]) throw new HttpError(`不支持的图片格式：${fmt}`, 400, "GALLERY_BAD_FORMAT");
    const m = body?.meta || {};
    const normalizedMeta = normalizeNaiBody({ parameters: { sampler: m.sampler, noise_schedule: m.noise } }).parameters;
    const id = crypto.randomUUID();
    const imgBytes = b64ToBytes(image);
    await env.R2.put(`img/${id}`, imgBytes, { httpMetadata: { contentType: IMG_TYPES[fmt] } });
    const thumb = String(body?.thumb || "");
    let thumbFmt = String(body?.thumb_fmt || "png").toLowerCase();
    if (!IMG_TYPES[thumbFmt]) thumbFmt = "png";
    const thumbBytes = thumb ? b64ToBytes(thumb) : null;
    if (thumbBytes) await env.R2.put(`thumb/${id}`, thumbBytes, { httpMetadata: { contentType: IMG_TYPES[thumbFmt] } });
    await env.DB.prepare(`INSERT INTO gallery(id,ts,fmt,thumb_fmt,prompt,prompt_base,artist,artist_id,artist_name,final_prompt,neg,model,seed,w,h,steps,scale,sampler,noise,n,action,cost,params_json,prompt_hash,snapshot_id,bytes,thumb_bytes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, Number(m.ts) || Date.now(), fmt, thumbFmt,
        String(m.prompt || "").slice(0, 2000), String(m.promptBase || "").slice(0, 2000), String(m.artist || "").slice(0, 4000),
        String(m.artistId || "").slice(0, 200), String(m.artistName || "").slice(0, 200), String(m.final_prompt || m.prompt || "").slice(0, 4000),
        String(m.neg || "").slice(0, 1000), String(m.model || ""),
        Number(m.seed) || 0, Number(m.w) || 0, Number(m.h) || 0, Number(m.steps) || 0, Number(m.scale) || 0,
        normalizedMeta.sampler, normalizedMeta.noise_schedule, Number(m.n) || 1, String(m.action || "generate"),
        m.cost == null ? null : Number(m.cost), String(m.params_json || "").slice(0, 2000), String(m.promptHash || m.prompt_hash || "").slice(0, 80), String(m.snapshotId || m.snapshot_id || "").slice(0, 80),
        imgBytes.byteLength, thumbBytes ? thumbBytes.byteLength : 0).run();
    return json({ id });
  }
  // POST /api/gallery/clear —— 清空（需 confirm:true）
  if (request.method === "POST" && rest === "/clear") {
    requireOrigin(request, env);
    const body = await readJson<any>(request);
    if (body?.confirm !== true) throw new HttpError("需要 confirm:true 才能清空画廊", 400, "GALLERY_CONFIRM_REQUIRED");
    let cursor: string | undefined; let deleted = 0;
    do {
      const list = await env.R2.list({ cursor });
      for (const obj of list.objects) { await env.R2.delete(obj.key); deleted++; }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    await env.DB.prepare("DELETE FROM gallery").run();
    return json({ deleted });
  }
  // GET /api/gallery?limit=&offset=&q=&model=&artist=&prompt_hash= —— 元数据分页与高级检索
  if (request.method === "GET" && rest === "") {
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 24, 1), GALLERY_PAGE_MAX);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    const q = String(url.searchParams.get("q") || "").trim().slice(0, 120);
    const model = String(url.searchParams.get("model") || "").trim().slice(0, 200);
    const artist = String(url.searchParams.get("artist") || "").trim().slice(0, 200);
    const promptHash = String(url.searchParams.get("prompt_hash") || "").trim().slice(0, 80);
    const clauses: string[] = [], binds: any[] = [];
    if (model) { clauses.push("model=?"); binds.push(model); }
    if (promptHash) { clauses.push("prompt_hash=?"); binds.push(promptHash); }
    if (artist) { clauses.push("(artist LIKE ? OR artist_name LIKE ?)"); binds.push(`%${artist}%`, `%${artist}%`); }
    if (q) { clauses.push("(prompt LIKE ? OR prompt_base LIKE ? OR artist LIKE ? OR artist_name LIKE ? OR model LIKE ? OR prompt_hash LIKE ?)"); binds.push(...Array(6).fill(`%${q}%`)); }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const select = `SELECT id,ts,fmt,thumb_fmt,prompt,prompt_base AS promptBase,artist,artist_id AS artistId,artist_name AS artistName,final_prompt,neg,model,seed,w,h,steps,scale,sampler,noise,n,action,cost,params_json,prompt_hash AS promptHash,snapshot_id AS snapshotId,bytes FROM gallery${where} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`;
    const items = await env.DB.prepare(select).bind(...binds, limit, offset).all<any>();
    const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM gallery${where}`).bind(...binds).first<any>();
    return json({ items: items.results || [], total: total?.c || 0 });
  }
  // GET /api/gallery/i/{id}?t=img|thumb —— 输出图片
  let m = rest.match(/^\/i\/([A-Za-z0-9-]+)$/);
  if (request.method === "GET" && m) {
    const id = m[1];
    const kind = new URL(request.url).searchParams.get("t") === "thumb" ? "thumb" : "img";
    const row = await env.DB.prepare("SELECT fmt,thumb_fmt FROM gallery WHERE id=?").bind(id).first<any>();
    const obj = await env.R2.get(`${kind}/${id}`);
    if (!row || !obj) throw new HttpError("图片不存在", 404, "GALLERY_NOT_FOUND");
    const fmt = kind === "thumb" ? (row.thumb_fmt || "png") : row.fmt;
    return new Response(obj.body, { headers: { "Content-Type": IMG_TYPES[fmt] || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" } });
  }
  // POST /api/gallery/{id}/publish —— 发布到公共画廊
  let publishMatch = rest.match(/^\/([A-Za-z0-9-]+)\/(publish|unpublish)$/);
  if (publishMatch && request.method === "POST") {
    requireOrigin(request, env);
    const id = publishMatch[1], action = publishMatch[2];
    const row = await env.DB.prepare("SELECT id FROM gallery WHERE id=?").bind(id).first<any>();
    if (!row) throw new HttpError("图片不存在", 404, "GALLERY_NOT_FOUND");
    if (action === "unpublish") {
      await env.DB.prepare("UPDATE gallery SET public=0,published_at=NULL WHERE id=?").bind(id).run();
      return json({ ok: true, public: false });
    }
    const body = await readJson<any>(request);
    const title = String(body?.title || "").trim().slice(0, 200);
    const tags = Array.isArray(body?.tags) ? body.tags.map(String).map((x: string) => x.trim()).filter(Boolean).slice(0, 50).join(", ") : String(body?.tags || "").trim().slice(0, 2000);
    const rating = String(body?.rating || "general").trim().toLowerCase();
    if (!title) throw new HttpError("发布标题不能为空", 400, "GALLERY_TITLE_REQUIRED");
    if (!/^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff .-]{0,199}$/.test(title)) throw new HttpError("发布标题格式无效", 400, "GALLERY_BAD_TITLE");
    if (!/^[A-Za-z0-9_\u4e00-\u9fff ,.-]{0,2000}$/.test(tags)) throw new HttpError("发布标签格式无效", 400, "GALLERY_BAD_TAGS");
    if (!["general", "r15", "r17"].includes(rating)) throw new HttpError("发布评级无效", 400, "GALLERY_BAD_RATING");
    const promptDisclosed = (body?.promptDisclosed ?? body?.prompt_disclosed) ? 1 : 0, paramsDisclosed = (body?.paramsDisclosed ?? body?.params_disclosed) ? 1 : 0;
    await env.DB.prepare("UPDATE gallery SET title=?,tags=?,rating=?,public=1,published_at=?,prompt_disclosed=?,params_disclosed=? WHERE id=?")
      .bind(title, tags, rating, nowIso(), promptDisclosed, paramsDisclosed, id).run();
    return json({ ok: true, public: true, id });
  }
  // DELETE /api/gallery/{id}
  m = rest.match(/^\/([A-Za-z0-9-]+)$/);
  if (request.method === "DELETE" && m) {
    requireOrigin(request, env);
    const id = m[1];
    await env.R2.delete([`img/${id}`, `thumb/${id}`]);
    const r = await env.DB.prepare("DELETE FROM gallery WHERE id=?").bind(id).run();
    if (!r.meta.changes) throw new HttpError("图片不存在", 404, "GALLERY_NOT_FOUND");
    return json({ ok: true });
  }
  throw new HttpError("未知画廊路由", 404, "ROUTE_NOT_FOUND");
}

function publicCors(response: Response, request: Request) {
  const h = new Headers(response.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, X-YesNAI-Visitor");
  h.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}

async function publicGalleryRoute(request: Request, env: Env, rest: string) {
  const visitor = String(request.headers.get("X-YesNAI-Visitor") || "").trim().slice(0, 128);
  if (request.method === "OPTIONS") return publicCors(new Response(null, { status: 204 }), request);
  if (request.method === "GET" && rest === "") {
    const u = new URL(request.url), limit = Math.min(Math.max(Number(u.searchParams.get("limit")) || 24, 1), GALLERY_PAGE_MAX), offset = Math.max(Number(u.searchParams.get("offset")) || 0, 0);
    const search = String(u.searchParams.get("search") || "").trim().slice(0, 100), rating = String(u.searchParams.get("rating") || "").trim().toLowerCase(), sort = String(u.searchParams.get("sort") || "new").trim().toLowerCase();
    const where = ["public=1"]; const binds: any[] = [];
    // 未公开提示词不参与搜索匹配，防止用词典逐词试探推断内容
    if (search) { where.push("(title LIKE ? OR tags LIKE ? OR (prompt_disclosed=1 AND prompt LIKE ?))"); const s = `%${search}%`; binds.push(s, s, s); }
    if (["general", "r15", "r17"].includes(rating)) { where.push("rating=?"); binds.push(rating); }
    const order = sort === "likes" ? "like_count DESC, published_at DESC" : "published_at DESC, ts DESC";
    const rows = await env.DB.prepare(`SELECT id,ts,fmt,thumb_fmt,title,tags,rating,public,published_at,prompt_disclosed,params_disclosed,view_count,like_count,model,w,h,steps,scale,sampler,noise FROM gallery WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all<any>();
    // params_disclosed=0 的作品不在列表外露生成参数（与详情接口守卫对齐）
    const items = (rows.results || []).map((x: any) => { if (x.params_disclosed) return x; const { steps, scale, sampler, noise, ...rest } = x; return rest; });
    if (visitor && items.length) { const ids = items.map(x => x.id); for (const item of items) item.liked = Boolean((await env.DB.prepare("SELECT 1 FROM gallery_likes WHERE visitor_id=? AND gallery_id=?").bind(visitor, item.id).first())); }
    const total = await env.DB.prepare(`SELECT COUNT(*) c FROM gallery WHERE ${where.join(" AND ")}`).bind(...binds).first<any>();
    return json({ items, total: Number(total?.c || 0) });
  }
  let m = rest.match(/^\/i\/([A-Za-z0-9-]+)$/);
  if (request.method === "GET" && m) {
    const id = m[1], row = await env.DB.prepare("SELECT fmt,thumb_fmt,public FROM gallery WHERE id=?").bind(id).first<any>();
    if (!row?.public) throw new HttpError("图片不存在", 404, "GALLERY_NOT_FOUND");
    const kind = new URL(request.url).searchParams.get("t") === "thumb" ? "thumb" : "img", obj = await env.R2.get(`${kind}/${id}`);
    if (!obj) throw new HttpError("图片不存在", 404, "GALLERY_NOT_FOUND");
    return new Response(obj.body, { headers: { "Content-Type": IMG_TYPES[kind === "thumb" ? row.thumb_fmt : row.fmt] || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" } });
  }
  m = rest.match(/^\/([A-Za-z0-9-]+)\/(view|like)$/);
  if (m && request.method === "POST") {
    const id = m[1], action = m[2], row = await env.DB.prepare("SELECT id FROM gallery WHERE id=? AND public=1").bind(id).first<any>();
    if (!row) throw new HttpError("图片不存在", 404, "GALLERY_NOT_FOUND");
    if (action === "view") { await env.DB.prepare("UPDATE gallery SET view_count=view_count+1 WHERE id=? AND public=1").bind(id).run(); return json({ ok: true }); }
    if (!visitor) throw new HttpError("需要 X-YesNAI-Visitor", 400, "VISITOR_REQUIRED");
    const existing = await env.DB.prepare("SELECT 1 FROM gallery_likes WHERE visitor_id=? AND gallery_id=?").bind(visitor, id).first();
    if (existing) { await env.DB.prepare("DELETE FROM gallery_likes WHERE visitor_id=? AND gallery_id=?").bind(visitor, id).run(); await env.DB.prepare("UPDATE gallery SET like_count=MAX(0,like_count-1) WHERE id=?").bind(id).run(); return json({ liked: false }); }
    const inserted = await env.DB.prepare("INSERT OR IGNORE INTO gallery_likes(visitor_id,gallery_id,created_at) VALUES(?,?,?)").bind(visitor, id, nowIso()).run();
    if ((inserted.meta.changes ?? 0) === 0) return json({ liked: true });
    await env.DB.prepare("UPDATE gallery SET like_count=like_count+1 WHERE id=?").bind(id).run();
    return json({ liked: true });
  }
  m = rest.match(/^\/([A-Za-z0-9-]+)$/); if (!m) throw new HttpError("未知公共画廊路由", 404, "ROUTE_NOT_FOUND");
  const id = m[1], row = await env.DB.prepare("SELECT * FROM gallery WHERE id=? AND public=1").bind(id).first<any>();
  if (!row) throw new HttpError("图片不存在", 404, "GALLERY_NOT_FOUND");
  if (request.method === "GET") { const out: any = { id: row.id, ts: row.ts, title: row.title, tags: row.tags, rating: row.rating, model: row.model, view_count: row.view_count, like_count: row.like_count, prompt_disclosed: row.prompt_disclosed, params_disclosed: row.params_disclosed }; if (row.prompt_disclosed) { out.prompt = row.prompt; out.prompt_base = row.prompt_base; out.neg = row.neg; } if (row.params_disclosed) out.params = row.params_json; return json(out); }
  throw new HttpError("未知公共画廊路由", 404, "ROUTE_NOT_FOUND");
}

function securityHeaders(response: Response) { const h = new Headers(response.headers); h.set("X-Content-Type-Options", "nosniff"); h.set("Referrer-Policy", "same-origin"); h.set("X-Frame-Options", "DENY"); return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h }); }
// 访问密钥：设置 APP_ACCESS_KEY Secret 后，除 GET /api/session 外的所有 API 都需要 X-Access-Key。
// 同时它也是账号凭据加密密钥的来源——多账号模式下必须设置。
function requireAccessKey(request: Request, env: Env) {
  if (!env.APP_ACCESS_KEY) return;
  if (request.headers.get("X-Access-Key") !== env.APP_ACCESS_KEY) throw new HttpError("需要访问密钥（在设置里填写 APP_ACCESS_KEY）", 401, "ACCESS_KEY_REQUIRED");
}

/* ================= RP 网关核心 ================= */
// migrations/0007_gateway_policy_fix.sql is an intentionally one-time migration;
// do not replay its ALTER TABLE statements against an already-upgraded D1 database.
interface GatewayKeyRow { id: number; name: string; key: string; enabled: number; mode: string; policy_json: string; use_count: number; last_used_at: string | null; created_at: string; updated_at: string; }
const GATEWAY_POLICY_FIELDS = ["daily_requests", "daily_gems", "max_concurrency", "allowed_models", "parameter_mode", "fixed_parameters", "limits", "allow_img2img", "allow_inpaint", "allow_extra_parameters"];
const GATEWAY_KNOWN_PARAMETERS = new Set(["width", "height", "steps", "n_samples", "scale", "seed", "sampler", "noise_schedule", "negative_prompt", "image", "mask", "img2img", "inpaint", "action", "model", "prompt", "size", "n", "parameters"]);
function gatewayMode(row: Partial<GatewayKeyRow>, body?: any) { return (body?.request_mode ?? body?.mode ?? row.mode) === "passthrough" ? "passthrough" : "restricted"; }
function gatewayPolicy(row: GatewayKeyRow) { try { const p = JSON.parse(row.policy_json || "{}"); return p && typeof p === "object" ? p : {}; } catch { return {}; } }
function gatewayPolicyFromBody(body: any, fallback: any = {}) {
  const source = body?.policy && typeof body.policy === "object" ? { ...fallback, ...body.policy } : { ...fallback };
  for (const f of GATEWAY_POLICY_FIELDS) if (body?.[f] !== undefined) source[f] = body[f];
  source.allowed_models = Array.isArray(source.allowed_models) ? source.allowed_models.map(String).filter(Boolean) : [];
  for (const f of ["fixed_parameters", "limits"]) if (!source[f] || typeof source[f] !== "object" || Array.isArray(source[f])) source[f] = {};
  return source;
}
function gatewayKeyPublic(row: GatewayKeyRow) {
  const policy = gatewayPolicy(row), mode = gatewayMode(row);
  return { id: row.id, name: row.name, key: row.key, enabled: row.enabled !== 0, mode, request_mode: mode,
    policy, ...Object.fromEntries(GATEWAY_POLICY_FIELDS.map(f => [f, policy[f] ?? (f === "allowed_models" ? [] : f.startsWith("allow_") ? false : null)])),
    use_count: row.use_count, last_used_at: row.last_used_at, created_at: row.created_at, updated_at: row.updated_at };
}
async function resolveGatewayKey(request: Request, env: Env): Promise<GatewayKeyRow> {
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!bearer) throw new HttpError("需要 Gateway API Key", 401, "GATEWAY_KEY_REQUIRED");
  let row: GatewayKeyRow | null = null;
  try { row = await env.DB.prepare("SELECT * FROM gateway_keys WHERE key=?").bind(bearer).first<GatewayKeyRow>(); }
  catch { throw new HttpError("Gateway 功能未初始化（请应用最新数据库迁移）", 500, "GATEWAY_TABLE_MISSING"); }
  if (!row) {
    try {
      const legacy = await env.DB.prepare("SELECT id,name,key,enabled,use_count,last_used_at,created_at FROM api_tokens WHERE key=?").bind(bearer).first<any>();
      if (legacy?.enabled) row = { ...legacy, mode: "restricted", policy_json: "{}", updated_at: legacy.created_at } as GatewayKeyRow;
    } catch { /* legacy table may be unavailable */ }
  }
  if (!row && bearer === env.APP_ACCESS_KEY) row = { id: 0, name: "admin", key: bearer, enabled: 1, mode: "restricted", policy_json: "{}", use_count: 0, last_used_at: null, created_at: nowIso(), updated_at: nowIso() };
  if (!row?.enabled) throw new HttpError("Gateway API Key 无效或已停用", 401, "GATEWAY_KEY_INVALID");
  if (row.id) await env.DB.prepare("UPDATE gateway_keys SET use_count=use_count+1,last_used_at=?,updated_at=? WHERE id=?").bind(nowIso(), nowIso(), row.id).run().catch(() => {});
  return row;
}
function checkGatewayPolicy(row: GatewayKeyRow, body: any) {
  const p = gatewayPolicy(row), params = body?.parameters && typeof body.parameters === "object" ? body.parameters : body || {};
  if (p.allow_extra_parameters === false) {
    const unknown = Object.keys(params).filter(k => !GATEWAY_KNOWN_PARAMETERS.has(k));
    if (unknown.length) throw new HttpError(`请求包含未知参数：${unknown.slice(0, 10).join(", ")}`, 403, "GATEWAY_UNKNOWN_PARAMETER");
  }
  const model = String(body?.model || params.model || "");
  if (p.allowed_models?.length && !p.allowed_models.includes(model)) throw new HttpError("模型不在该 Key 的允许列表中", 403, "GATEWAY_MODEL_RESTRICTED");
  if (p.models?.length && !p.allowed_models?.length && !p.models.includes(model)) throw new HttpError("模型不在该 Key 的允许列表中", 403, "GATEWAY_MODEL_RESTRICTED");
  const maxSamples = p.max_n_samples ?? p.max_n;
  if (maxSamples != null && Number(params.n_samples ?? body?.n ?? 1) > Number(maxSamples)) throw new HttpError("请求数量超过该 Key 限制", 403, "GATEWAY_N_RESTRICTED");
  const limits = p.limits && typeof p.limits === "object" ? p.limits : {};
  for (const field of ["width", "height", "steps", "max_steps", "scale", "max_scale", "n_samples", "max_n_samples"]) {
    const value = Number(params[field]); const rule = limits[field];
    const max = rule && typeof rule === "object" ? rule.max : rule;
    const min = rule && typeof rule === "object" ? rule.min : undefined;
    if (Number.isFinite(value) && value > 0 && ((min !== undefined && value < Number(min)) || (max !== undefined && value > Number(max)))) throw new HttpError(`参数 ${field} 超出该 Key 限制`, 403, "GATEWAY_PARAMETER_RESTRICTED");
  }
  for (const [field, max] of [["width", p.max_width], ["height", p.max_height], ["steps", p.max_steps], ["scale", p.max_scale], ["n_samples", p.max_n_samples ?? p.max_n]] as const) {
    if (max != null && Number(params[field]) > Number(max)) throw new HttpError(`参数 ${field} 超出该 Key 限制`, 403, "GATEWAY_PARAMETER_RESTRICTED");
  }
  const action = String(body?.action || params.action || "").toLowerCase();
  const hasImg = action === "img2img" || params.img2img != null || body?.img2img != null;
  const hasInpaint = action === "inpaint" || action === "infill" || params.inpaint != null || body?.inpaint != null || body?.mask != null;
  if (hasImg && p.allow_img2img === false) throw new HttpError("该 Key 不允许 img2img", 403, "GATEWAY_IMG2IMG_RESTRICTED");
  if (hasInpaint && p.allow_inpaint === false) throw new HttpError("该 Key 不允许 inpaint", 403, "GATEWAY_INPAINT_RESTRICTED");
}
async function gatewayGenerate(request: Request, env: Env, upstreamPath: string) {
  const key = await resolveGatewayKey(request, env);
  const started = Date.now(), requestId = crypto.randomUUID(), rawBody = await request.arrayBuffer();
  const mode = gatewayMode(key);
  let body: any = null;
  if (mode === "restricted") {
    try { body = JSON.parse(new TextDecoder().decode(rawBody)); } catch { throw new HttpError("请求 JSON 无效", 400, "INVALID_JSON"); }
    checkGatewayPolicy(key, body);
  }
  const policy = gatewayPolicy(key);
  const requestModel = body?.model || body?.parameters?.model || null;
  let forwardedBody: ArrayBuffer | Uint8Array;
  if (mode === "passthrough") {
    // Passthrough preserves the caller's bytes exactly; do not decode or re-encode them.
    forwardedBody = rawBody.slice(0);
  } else if (policy.parameter_mode === "fixed" && policy.fixed_parameters && typeof policy.fixed_parameters === "object") {
    // Clone the parsed JSON deeply before applying fixed parameters so the request object is never reused or mutated.
    const clonedBody = typeof structuredClone === "function" ? structuredClone(body) : JSON.parse(JSON.stringify(body));
    const parameters = clonedBody && typeof clonedBody.parameters === "object" && !Array.isArray(clonedBody.parameters)
      ? clonedBody.parameters : (clonedBody.parameters = {});
    Object.assign(parameters, structuredClone(policy.fixed_parameters));
    forwardedBody = new TextEncoder().encode(JSON.stringify(clonedBody));
  } else {
    forwardedBody = rawBody.slice(0);
  }
  const forwardedBytes = forwardedBody.byteLength;
  const today = new Date().toISOString().slice(0, 10);
  const dailyRequests = Number(policy.daily_requests || 0), dailyGems = Number(policy.daily_gems || 0);
  if (key.id && dailyGems > 0) {
    const usage = await env.DB.prepare("SELECT gem_count FROM daily_usage WHERE gateway_key_id=? AND usage_date=?").bind(key.id, today).first<any>();
    if (Number(usage?.gem_count || 0) >= dailyGems) throw new HttpError("已达到每日 Gems 限制", 429, "GATEWAY_DAILY_GEMS_LIMIT");
  }
  if (key.id) {
    const reserved = await env.DB.prepare(`INSERT INTO daily_usage(gateway_key_id,usage_date,request_count,gem_count,updated_at) VALUES(?,?,1,0,?)
      ON CONFLICT(gateway_key_id,usage_date) DO UPDATE SET request_count=request_count+1,updated_at=excluded.updated_at
      WHERE (? <= 0 OR request_count < ?) AND (? <= 0 OR gem_count < ?)`).bind(key.id, today, nowIso(), dailyRequests, dailyRequests, dailyGems, dailyGems).run();
    if (!(reserved.meta.changes ?? 0)) {
      const usage = await env.DB.prepare("SELECT request_count,gem_count FROM daily_usage WHERE gateway_key_id=? AND usage_date=?").bind(key.id, today).first<any>();
      if (dailyRequests > 0 && Number(usage?.request_count || 0) >= dailyRequests) throw new HttpError("已达到每日请求数限制", 429, "GATEWAY_DAILY_REQUEST_LIMIT");
      throw new HttpError("已达到每日 Gems 限制", 429, "GATEWAY_DAILY_GEMS_LIMIT");
    }
  }
  const candidates = await roundRobinPool(env); if (!candidates.length) throw new HttpError("没有可用账号", 503, "NO_ACCOUNT");
  const maxConcurrent = Number(policy.max_concurrency || 0);
  let leaseId = "";
  if (maxConcurrent > 0 && key.id) {
    leaseId = crypto.randomUUID();
    const leaseUntil = new Date(Date.now() + UPSTREAM_TIMEOUT_GENERATE_MS + 10000).toISOString();
    const claimed = await env.DB.prepare(`INSERT INTO concurrency_leases(lease_id,gateway_key_id,expires_at,created_at)
      SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM concurrency_leases WHERE gateway_key_id=? AND expires_at>?) < ?`).bind(leaseId, key.id, leaseUntil, nowIso(), key.id, nowIso(), maxConcurrent).run();
    if (!(claimed.meta.changes ?? 0)) throw new HttpError("当前并发已达限制", 429, "GATEWAY_CONCURRENCY_LIMIT");
  }
  let lastStatus = 502, lastMessage = "", accountName = "", accountId: number | null = null, response: Response | null = null, attemptNoTotal = 0;
  try {
    for (let i = 0; i < candidates.length; i++) {
      const acc = candidates[i]; accountId = acc.id; let token = await unseal(env, acc.api_token_enc).catch(() => ""); if (!token) continue;
      let retried401 = false, attemptNo = 0;
      while (true) {
        attemptNo++; attemptNoTotal++;
        try { response = await yesnaiFetch(env, upstreamPath, { method: "POST", headers: gatewayRequestHeaders(request, token), body: mode === "passthrough" ? rawBody.slice(0) : forwardedBody.slice(0) }, UPSTREAM_TIMEOUT_GENERATE_MS, acc); }
        catch (e: any) { lastMessage = String(e?.message || e); await env.DB.prepare("INSERT INTO request_attempts(request_id,gateway_key_id,account_id,attempt_no,error,created_at) VALUES(?,?,?,?,?,?)").bind(requestId, key.id, acc.id, attemptNo, lastMessage.slice(0, 300), nowIso()).run().catch(() => {}); break; }
        await env.DB.prepare("INSERT INTO request_attempts(request_id,gateway_key_id,account_id,attempt_no,status_code,created_at) VALUES(?,?,?,?,?,?)").bind(requestId, key.id, acc.id, attemptNo, response.status, nowIso()).run().catch(() => {});
        if (response.status === 401 && !retried401) { const fresh = await refreshJwt(env, acc).catch(() => null); if (fresh) { const rebuilt = await provisionToken(env, acc).catch(() => null); if (rebuilt) { token = rebuilt; await updateAccount(env, acc.id, { api_token_enc: await seal(env, rebuilt) }); retried401 = true; continue; } } }
        break;
      }
      if (!response) continue;
      if (response.ok) { accountName = accountPublic(acc).label; accountId = acc.id; break; }
      lastStatus = response.status; const clone = response.clone(); let data: any = {}; try { data = await clone.json(); } catch {} lastMessage = sanitizedMessage(data, `HTTP ${response.status}`);
      if (![401, 402, 429].includes(response.status) && response.status < 500) break;
      response = null;
    }
    if (!response) throw new HttpError(`所有候选账号均失败（最后：HTTP ${lastStatus} ${lastMessage}）`, 502, "ALL_ACCOUNTS_FAILED");
    const costGems = await (async () => { try { const meta = await response!.clone().json() as any; const n = Number(meta?.job?.cost_gems ?? meta?.cost_gems); return Number.isFinite(n) ? n : null; } catch { return null; } })();
    if (key.id && costGems != null && costGems > 0) await env.DB.prepare("UPDATE daily_usage SET gem_count=gem_count+?,updated_at=? WHERE gateway_key_id=? AND usage_date=?").bind(costGems, nowIso(), key.id, today).run().catch(() => {});
    const out = gatewayForwardResponse(response, requestId), duration = Date.now() - started, bytesOut = Number(response.headers.get("Content-Length") || 0) || null;
    await env.DB.prepare("INSERT INTO request_logs(request_id,gateway_key_id,account_id,path,mode,model,status_code,ok,duration_ms,bytes_in,bytes_out,cost_gems,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(requestId, key.id || null, accountId, upstreamPath, mode, requestModel, response.status, response.ok ? 1 : 0, duration, rawBody.byteLength, bytesOut, costGems, nowIso()).run().catch(() => {});
    const h = new Headers(out.headers); if (accountName) h.set("X-YesNAI-Account", accountName); h.set("X-Gateway-Attempts", String(attemptNoTotal)); return new Response(out.body, { status: out.status, statusText: response.statusText, headers: h });
  } catch (e: any) {
    await env.DB.prepare("INSERT INTO request_logs(request_id,gateway_key_id,account_id,path,mode,model,status_code,ok,duration_ms,bytes_in,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(requestId, key.id || null, accountId, upstreamPath, mode, requestModel, response?.status || (e instanceof HttpError ? e.status : 500), 0, Date.now() - started, rawBody.byteLength, nowIso()).run().catch(() => {});
    if (e && typeof e === "object") { e.requestId = requestId; e.attempts = attemptNoTotal; }
    throw e;
  } finally { if (leaseId) await env.DB.prepare("DELETE FROM concurrency_leases WHERE lease_id=?").bind(leaseId).run().catch(() => {}); }
}

// 对外就是"一个 NAI 账号"：Authorization: Bearer <APP_ACCESS_KEY>（或 X-Access-Key），
// 内部在账号池里轮询（round-robin）分摊额度，401/402/429/5xx 自动换下一个候选。
function requireExternalKey(request: Request, env: Env) {
  if (!env.APP_ACCESS_KEY) throw new HttpError("外部 API 需要先设置 APP_ACCESS_KEY", 401, "ACCESS_KEY_REQUIRED");
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (bearer !== env.APP_ACCESS_KEY && request.headers.get("X-Access-Key") !== env.APP_ACCESS_KEY) {
    throw new HttpError("统一密钥无效", 401, "ACCESS_KEY_REQUIRED");
  }
}
// 生图端点鉴权：yst- 分发密钥统一走 resolveGatewayKey（gateway_keys → api_tokens 兼容 → admin 回退），
// 新网关密钥与旧 api_tokens 密钥在全部外部接口上行为一致，use_count 每请求只 +1。
async function resolveExternalAuth(request: Request, env: Env): Promise<"admin" | GatewayKeyRow> {
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (bearer.startsWith("yst-")) return resolveGatewayKey(request, env);
  requireExternalKey(request, env);
  return "admin";
}
// 受限密钥调用 chat/generate 直链时与 gatewayGenerate 同规：先校验策略，再合并钉死参数
function applyGatewayPolicyToBody(row: GatewayKeyRow, naiBody: any) {
  checkGatewayPolicy(row, naiBody);
  const fixed = gatewayPolicy(row).fixed_parameters;
  if (fixed && typeof fixed === "object" && !Array.isArray(fixed)) {
    const parameters = naiBody?.parameters && typeof naiBody.parameters === "object" && !Array.isArray(naiBody.parameters)
      ? naiBody.parameters : (naiBody.parameters = {});
    Object.assign(parameters, structuredClone(fixed));
  }
}
async function requireGatewayOrExternalAuth(request: Request, env: Env) {
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (bearer.startsWith("yst-")) {
    await resolveGatewayKey(request, env);
    return;
  }
  requireExternalKey(request, env);
}
// 共享生图内核：轮询选号 + 失败转移。返回上游响应与实际服务账号（参数 4xx 透传时账号为空）
async function generateViaPool(env: Env, naiBody: any): Promise<{ resp: Response; account: string }> {
  naiBody = normalizeNaiBody(naiBody);
  await ensureBootstrapped(env);
  const all = (await listAccounts(env)).filter(a => a.enabled);
  if (!all.length) throw new HttpError("没有启用中的账号", 503, "NO_ACCOUNT");
  if (!all.some(a => a.api_token_enc)) throw new HttpError("账号池中没有配置生图 API Token 的账号", 503, "NO_TOKEN_ACCOUNT");
  // 轮询选号：候选序列按游标轮转，失败转移遍历整个池
  const pool = await roundRobinPool(env);
  if (!pool.length) throw new HttpError("没有启用中的账号", 503, "NO_ACCOUNT");
  let lastStatus = 0, lastMessage = "", attempted = 0;
  const poolStarted = Date.now();
  for (const acc of pool) {
    const remaining = GENERATE_POOL_BUDGET_MS - (Date.now() - poolStarted);
    if (remaining <= 0) break;
    const token = await unseal(env, acc.api_token_enc).catch(() => "");
    if (!token) continue;
    attempted++;
    const timeoutMs = Math.min(UPSTREAM_TIMEOUT_GENERATE_MS, remaining);
    const resp = await yesnaiFetch(env, "/v1/nai/generate-image", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(naiBody) }, timeoutMs, acc);
    if (resp.ok) return { resp, account: accountPublic(acc).label };
    // 余额不足 / 限流 / Token 失效 / 上游 5xx：换下一个候选重试
    if ([401, 402, 429].includes(resp.status) || resp.status >= 500) {
      lastStatus = resp.status;
      const { data } = await upstreamJson(resp);
      lastMessage = sanitizedMessage(data, `HTTP ${resp.status}`);
      continue;
    }
    // 参数错误等 4xx：换账号结果一样，直接透传
    return { resp, account: "" };
  }
  if (!attempted) throw new HttpError("账号池中没有配置生图 API Token 的账号", 503, "NO_TOKEN_ACCOUNT");
  if (Date.now() - poolStarted >= GENERATE_POOL_BUDGET_MS) throw new HttpError("账号池生图请求超过总等待时间", 504, "GENERATE_POOL_TIMEOUT");
  throw new HttpError(`所有候选账号均失败（最后：HTTP ${lastStatus} ${lastMessage}）`, 502, "ALL_ACCOUNTS_FAILED");
}
async function externalGenerate(request: Request, env: Env) {
  const body = await readJson<any>(request);
  const { resp, account } = await generateViaPool(env, body);
  const out = await forward(resp);
  if (!account) return out;
  const h = new Headers(out.headers);
  h.set("X-Ynai-Account", account);
  return new Response(out.body, { status: out.status, headers: h });
}

/* ================= OpenAI 兼容层（/v1/images/generations） ================= */
const SIZE_ALIAS: Record<string, string> = { "竖图": "832x1216", "横图": "1216x832", "方图": "1024x1024" };
// OpenAI Images 请求 → NAI 原生 body；parameters 扩展对象整体浅合并（negative_prompt/steps/scale/seed/sampler 等）
function openaiToNai(body: any) {
  const rawPrompt = Array.isArray(body?.input) ? body.input : (Array.isArray(body?.prompt) ? body.prompt : [body?.prompt]);
  const input = rawPrompt.map((s: any) => String(s ?? "")).filter((s: string) => s.trim());
  if (!input.length) throw new HttpError("prompt 不能为空", 400, "PROMPT_REQUIRED");
  const sizeRaw = SIZE_ALIAS[String(body?.size ?? "").trim()] || String(body?.size ?? "832x1216");
  const m = sizeRaw.match(/^(\d{2,5})\s*[xX×]\s*(\d{2,5})$/);
  if (!m) throw new HttpError("size 格式无效（示例 832x1216 / 1024x1024）", 400, "BAD_SIZE");
  const n = Math.min(Math.max(Number(body?.n) || 1, 1), 8);
  const parameters: Record<string, unknown> = {
    width: Number(m[1]), height: Number(m[2]), n_samples: n,
    ...(body?.parameters && typeof body.parameters === "object" && !Array.isArray(body.parameters) ? body.parameters : {}),
  };
  if (body?.n !== undefined) parameters.n_samples = n;   // 显式 n 永远生效
  return { model: String(body?.model || "nai-diffusion-4-5-full"), action: "generate", input, parameters };
}
// 上游模型列表 → OpenAI list 格式（兼容字符串数组 / {id} 数组 / {data:[...]}）
function openaiModelList(up: any) {
  const raw = Array.isArray(up) ? up : (Array.isArray(up?.data) ? up.data : []);
  const seen = new Set<string>(); const data: any[] = [];
  for (const item of raw) {
    const id = typeof item === "string" ? item : (item?.id || item?.model || item?.name);
    if (!id || seen.has(String(id))) continue;
    seen.add(String(id));
    data.push(typeof item === "object" && item ? { ...item, id: String(id), object: "model", owned_by: item.owned_by || "yesnai-studio" } : { id: String(id), object: "model", owned_by: "yesnai-studio" });
  }
  return { object: "list", data };
}
async function externalGenerateOpenAI(request: Request, env: Env) {
  const body = await readJson<any>(request);
  const { resp, account } = await generateViaPool(env, openaiToNai(body));
  if (!resp.ok) return forward(resp);   // 参数/上游错误透传（保留上游原文）
  const { data } = await upstreamJson(resp);
  const images = Array.isArray(data?.images) ? data.images : [];
  if (!images.length) throw new HttpError("上游未返回图片", 502, "NO_IMAGES");
  const payload = JSON.stringify({
    created: Math.floor(Date.now() / 1000),
    data: images.map((b64: unknown) => ({ b64_json: b64 })),   // response_format=url 自动按 b64_json 返回（第一版不做 URL 托管）
    cost_gems: data?.job?.cost_gems ?? null,
  });
  return new Response(payload, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", ...(account ? { "X-Ynai-Account": account } : {}) } });
}

/* ================= Prompt API（Nai2API 中文转 NAI 提示词） ================= */
const PROMPT_SYSTEM_MESSAGE = `You are a specialist at converting Chinese image requests into precise NovelAI Diffusion prompts.

OUTPUT CONTRACT
- Return exactly one line of English, comma-separated NovelAI/booru-style tags. Never return prose, headings, Markdown, Chinese, JSON or a negative-prompt section.
- For an adult NSFW scene, the first tag must be nsfw.
- Use concise visual tags, not sentences. Split compound ideas into concrete tags; for example, 月下 becomes moonlight, night.
- Describe only people, objects, clothing, background, lighting, camera framing and physical actions that are objectively visible in the requested image. Never include thoughts, memories, metaphors, plans or story exposition.
- Do not invent artist names, model settings, unrelated details or sexual content that the user did not request.

TAG PRIORITY AND ORDER
1. If this is a known copyrighted/fandom character, put the official English character tag or widely used canonical character tag first, followed immediately by its defining appearance. Never fabricate a character identity. For an original character, use original instead of its personal name.
2. Subject count and identity: 1girl, 1boy, multiple girls, species, role or archetype; include age only when visually relevant or needed to establish an adult-only explicit scene.
3. Defining appearance: hairstyle, hair color, eye color, skin, body type and distinctive accessories. These are the highest-priority consistency tags.
4. Clothing and its exact current state: garment type, material and details, whether it is intact, lifted, open, torn, partially removed or absent.
5. Main pose and action: standing, kneeling, walking, sleeping, cooking and other concrete actions.
6. Fine action and interaction details: which hand does what, contact with self, another adult, a prop or the environment; distinguish one hand from both hands and use spatially precise tags.
7. Visible expression and gaze: looking at viewer, looking away, smile, open mouth, blush, tears and other observable reactions.
8. Camera and visible body region: from above, from below, from behind, upper body, lower body, full body, close-up, between legs, dutch angle and focal emphasis.
9. Location, props, time, weather, lighting and atmosphere: bedroom, beach, indoors, morning, night, moonlight, rim lighting and other visible scene information.

CONSISTENCY RULES
- The latest explicit state in the request wins. Remove every conflicting tag instead of outputting both states.
- Adapt features to what the camera can actually see. A lower-body-only frame must omit facial expression, eye color and other invisible upper-body details. A back view must omit invisible eye details; a covered face or blindfold must omit hidden eye details.
- Convert dialogue or narrative claims into visible actions only when the request makes the action visually clear; for example, “showing underwear” becomes lifting skirt, panties.
- Preserve exact relative positions, prop locations, clothing state, lighting and interaction partners. Never swap who performs or receives an action.
- Use explicit absence tags such as no bra or no panties only when the absence is visually important and directly requested; otherwise omit the element.

WEIGHTING
- Emphasize only the most important stable traits or focal actions with NovelAI braces: {tag}, {{tag}}, {{{tag}}}. Prefer defining appearance, then action, clothing and expression. Avoid excessive weighting and never weight every tag.
- De-emphasize minor background details with [tag] or [[tag]] only when needed.
- Keep logically related tags adjacent and allocate more tags to the visual focal point than to minor background details.

For multiple characters, keep each character's appearance and actions unambiguous and adjacent. `;
function promptApiBase(value: string): string {
  const raw = String(value || "").trim().replace(/\/$/, "");
  if (!raw) return "";
  return raw.replace(/\/(?:chat\/completions|models)\/?$/i, "").replace(/\/v1\/?$/i, "");
}
interface PromptApiConfig { base: string; key: string; model: string; }
async function getPromptApiConfig(env: Env): Promise<PromptApiConfig> {
  let stored: any = null;
  try {
    const row = await env.DB.prepare("SELECT v FROM runtime_kv WHERE k='prompt_api_config'").first<any>();
    if (row?.v) stored = JSON.parse(await unseal(env, row.v));
  } catch { /* 未迁移或旧配置时使用 Secret */ }
  return {
    base: promptApiBase(stored?.base || env.PROMPT_API_BASE || ""),
    key: String(stored?.key || env.PROMPT_API_KEY || "").trim(),
    model: String(stored?.model || env.PROMPT_API_MODEL || "").trim(),
  };
}
async function savePromptApiConfig(env: Env, value: any) {
  const current = await getPromptApiConfig(env);
  const next = { base: promptApiBase(value?.base ?? current.base), key: String(value?.key ?? current.key).trim(), model: String(value?.model ?? current.model).trim() };
  if (!next.base || !next.key || !next.model) throw new HttpError("请填写 API 地址、API Key 和模型名", 400, "PROMPT_API_FIELDS_REQUIRED");
  const sealed = await seal(env, JSON.stringify(next));
  await env.DB.prepare("INSERT INTO runtime_kv(k,v) VALUES('prompt_api_config',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(sealed).run();
  return { configured: true, model: next.model };
}
async function promptApiConfigured(env: Env): Promise<boolean> { const c = await getPromptApiConfig(env); return Boolean(c.base && c.key && c.model); }
async function promptApiStatus(env: Env) { const c = await getPromptApiConfig(env); return { configured: Boolean(c.base && c.key && c.model), model: c.model }; }
function cleanPromptApiOutput(value: unknown): string {
  return String(value || "").trim().replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/, "").replace(/^prompt\s*:\s*/i, "").replace(/^("|')|("|')$/g, "").replace(/\s+/g, " ").trim();
}
async function promptApiRequest(env: Env, path: string, init: RequestInit = {}, timeoutMs = 60_000) {
  const config = await getPromptApiConfig(env);
  if (!config.base || !config.key || !config.model) throw new HttpError("尚未配置中文提示词 API", 503, "PROMPT_API_NOT_CONFIGURED");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(config.base + "/v1" + path, { ...init, signal: controller.signal, headers: { Accept: "application/json", Authorization: `Bearer ${config.key}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) } });
    const text = await response.text(); let data: any; try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new HttpError("中文提示词 API 密钥无效或无权限", 502, "PROMPT_API_AUTH");
      if (response.status === 429) throw new HttpError("中文提示词 API 请求过于频繁", 502, "PROMPT_API_RATE_LIMIT");
      throw new HttpError(`中文提示词 API 返回 HTTP ${response.status}：${sanitizedMessage(data, "上游错误")}`, 502, "PROMPT_API_UPSTREAM");
    }
    return data;
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    if (e?.name === "AbortError") throw new HttpError("中文提示词 API 请求超时", 504, "PROMPT_API_TIMEOUT");
    throw new HttpError("无法连接中文提示词 API", 502, "PROMPT_API_CONNECT");
  } finally { clearTimeout(timer); }
}
const ARTIST_OPTIMIZE_SYSTEM_MESSAGE = `You optimize NovelAI artist strings. The user's input is an existing artist string, not a request for a new list.

OUTPUT CONTRACT
- Output only the artist string itself. Do not output explanations, headings, Markdown, JSON, quotes, or commentary.
- Always preserve the exact artist: prefix (lowercase) at the beginning of the output.
- Preserve the input's artist syntax, including N::...:: weighted groups, parentheses, brackets, commas, and meaningful line breaks. Do not flatten a multi-line artist string into one line.
- Never invent, translate, or substitute artist names. Names already present in the input may be retained even if they are outside any suggested target pool.
- Mode optimize: improve the existing string while preserving its intent and names. Mode merge: merge/deduplicate the existing entries while preserving their syntax and names. Mode slim: shorten the existing string while preserving the most useful existing names and syntax.
- If target_count is provided, treat it as a soft target for the number of existing artist entries; never add names to reach it.
- Return nothing except the final artist string.`;
function cleanArtistOptimizeOutput(value: unknown): string {
  let result = String(value || "").replace(/\r\n?/g, "\n").trim();
  result = result.replace(/^```(?:[a-z0-9_-]+)?[ \t]*\n?/i, "").replace(/\n?[ \t]*```[ \t]*$/i, "").trim();
  // Drop a standalone explanatory lead-in, but never remove the required artist: prefix.
  result = result.replace(/^(?:here(?:'s| is)|the optimized artist string is|优化后的画师串是)[：:\-]?\s*\n+/i, "").trim();
  result = result.replace(/^(?:artist\s*(?:string|prompt)|画师串)[：:]\s*/i, "artist: ");
  if (!result) return "";
  if (!/^artist\s*:/i.test(result)) result = `artist: ${result}`;
  result = result.replace(/^artist\s*:/i, "artist:");
  return result.split("\n").map(line => line.trim()).filter((line, index, lines) => line || (index > 0 && index < lines.length - 1)).join("\n").trim();
}
async function artistOptimize(env: Env, body: any): Promise<string> {
  const content = String(body?.content ?? body?.artist ?? "").trim();
  if (!content) throw new HttpError("请输入画师串", 400, "ARTIST_REQUIRED");
  if (content.length > 12_000) throw new HttpError("画师串不能超过 12000 字", 400, "ARTIST_TOO_LONG");
  const mode = String(body?.mode || "optimize").trim().toLowerCase();
  if (!["optimize", "merge", "slim"].includes(mode)) throw new HttpError("mode 仅支持 optimize、merge 或 slim", 400, "ARTIST_BAD_MODE");
  const targetRaw = body?.target_count;
  let targetCount: number | undefined;
  if (targetRaw !== undefined && targetRaw !== null && String(targetRaw).trim() !== "") {
    targetCount = Number(targetRaw);
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 100) throw new HttpError("target_count 必须是 1 到 100 的整数", 400, "ARTIST_BAD_TARGET_COUNT");
  }
  const instruction = String(body?.instruction || "").trim().slice(0, 2000);
  const extra = String(body?.extra || "").trim().slice(0, 4000);
  const config = await getPromptApiConfig(env);
  const data = await promptApiRequest(env, "/chat/completions", { method: "POST", body: JSON.stringify({ model: config.model, messages: [{ role: "system", content: ARTIST_OPTIMIZE_SYSTEM_MESSAGE }, { role: "user", content: JSON.stringify({ mode, target_count: targetCount ?? null, artist: content, instruction, extra }) }], temperature: 0.2, max_tokens: 2000, stream: false }) });
  const raw = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
  const text = Array.isArray(raw) ? raw.map((x: any) => typeof x === "string" ? x : x?.text || x?.content || "").join("\n") : raw;
  const result = cleanArtistOptimizeOutput(text);
  if (!result) throw new HttpError("API 没有返回画师串", 502, "ARTIST_API_BAD_OUTPUT");
  return result;
}
const ARTIST_ASSIST_SYSTEM_MESSAGE = `You assist with editing an existing NovelAI artist string. Return JSON only: {"summary":string,"ops":[{"id":string,"op":"remove"|"add"|"weight"|"keep","artist":string,"weight":number|null,"reason":string}]}. Never return markdown or prose. Only suggest removing existing artists, adding names from the supplied candidate list, changing weights between 0.2 and 2.0, or keeping an existing artist. Never invent names.`;
function cleanArtistAssist(value: unknown) {
  let text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let data: any; try { data = JSON.parse(text); } catch { throw new HttpError("AI 返回的建议不是有效 JSON", 502, "ARTIST_ASSIST_BAD_JSON"); }
  if (!data || !Array.isArray(data.ops)) throw new HttpError("AI 返回的建议格式无效", 502, "ARTIST_ASSIST_BAD_OUTPUT");
  const allowed = new Set(["remove", "add", "weight", "keep"]);
  const ops = data.ops.slice(0, 100).filter((x: any) => x && allowed.has(String(x.op)) && String(x.artist || "").trim()).map((x: any) => ({ id: String(x.id || ""), op: String(x.op), artist: String(x.artist).trim().slice(0, 120), weight: x.weight == null ? null : Number(x.weight), reason: String(x.reason || "").trim().slice(0, 240) }));
  for (const op of ops) if ((op.op === "add" || op.op === "weight") && op.weight != null && (!Number.isFinite(op.weight) || op.weight < 0.2 || op.weight > 2)) throw new HttpError("AI 返回了非法权重", 502, "ARTIST_ASSIST_BAD_WEIGHT");
  return { summary: String(data.summary || "").slice(0, 400), ops };
}
async function artistAssist(env: Env, body: any) {
  const content = String(body?.content ?? body?.artist ?? "").trim();
  if (!content) throw new HttpError("请输入画师串", 400, "ARTIST_REQUIRED");
  if (content.length > 12000) throw new HttpError("画师串不能超过 12000 字", 400, "ARTIST_TOO_LONG");
  if (String(body?.action || "suggest") !== "suggest") throw new HttpError("action 仅支持 suggest", 400, "ARTIST_ASSIST_BAD_ACTION");
  const config = await getPromptApiConfig(env);
  const data = await promptApiRequest(env, "/chat/completions", { method: "POST", body: JSON.stringify({ model: config.model, messages: [{ role: "system", content: ARTIST_ASSIST_SYSTEM_MESSAGE }, { role: "user", content: JSON.stringify({ content, mode: body?.mode || "optimize", instruction: String(body?.instruction || "").slice(0, 2000), target_count: body?.target_count ?? null, tokens: Array.isArray(body?.tokens) ? body.tokens.slice(0, 100) : [], candidates: Array.isArray(body?.candidates) ? body.candidates.slice(0, 160) : [] }) }], temperature: 0.2, max_tokens: 1800, stream: false }) });
  const raw = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
  return cleanArtistAssist(Array.isArray(raw) ? raw.map((x: any) => typeof x === "string" ? x : x?.text || x?.content || "").join("") : raw);
}

async function convertChinesePrompt(env: Env, prompt: string, modelOverride = ""): Promise<string> {
  const input = String(prompt || "").trim();
  if (!input) throw new HttpError("请输入中文画面描述", 400, "PROMPT_REQUIRED");
  if (input.length > 3000) throw new HttpError("中文画面描述不能超过 3000 字", 400, "PROMPT_TOO_LONG");
  const config = await getPromptApiConfig(env);
  const model = String(modelOverride || config.model).trim() || config.model;
  const data = await promptApiRequest(env, "/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "system", content: PROMPT_SYSTEM_MESSAGE }, { role: "user", content: input }], temperature: 0.35, max_tokens: 1000, stream: false }) });
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
  const result = cleanPromptApiOutput(Array.isArray(content) ? content.map((x: any) => typeof x === "string" ? x : x?.text || "").join("") : content);
  if (!result) throw new HttpError("API 没有返回提示词", 502, "PROMPT_API_BAD_OUTPUT");
  return result;
}
async function promptApiModels(env: Env) {
  const data = await promptApiRequest(env, "/models", {}, 15_000);
  const source = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return source.map((x: any) => typeof x === "string" ? x : x?.id || x?.name).map(String).filter(Boolean).filter((x: string, i: number, a: string[]) => a.indexOf(x) === i).sort();
}


function chatTextContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(x => typeof x === "string" ? x : String(x?.text || x?.content || "")).join(" ");
  return String(content?.text || content?.content || "");
}
function promptFromChat(body: any): string {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const raw = chatTextContent([...messages].reverse().find((m: any) => m?.role === "user")?.content ?? messages[messages.length - 1]?.content);
  const marked = raw.match(/image###([\s\S]*?)###/i);
  return (marked ? marked[1] : raw).replace(/^\s*(生成图片|帮我画|请画|画一张|出图)[:：\s]*/i, "").trim();
}
function decodeImageB64(value: string): Uint8Array {
  const clean = String(value || "").replace(/^data:image\/[^;]+;base64,/, "");
  const bin = atob(clean); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function queryToNai(url: URL) {
  const q = url.searchParams;
  const tag = q.get("tag") || q.get("prompt") || "";
  if (!tag.trim()) throw new HttpError("tag 不能为空", 400, "PROMPT_REQUIRED");
  const sizeRaw = SIZE_ALIAS[q.get("size") || ""] || q.get("size") || "832x1216";
  const m = sizeRaw.match(/^(\d{2,5})\s*[xX×]\s*(\d{2,5})$/);
  if (!m) throw new HttpError("size 格式无效（示例 832x1216 / 1024x1024）", 400, "BAD_SIZE");
  const p: Record<string, unknown> = {
    width: Number(m[1]), height: Number(m[2]), n_samples: Math.min(Math.max(Number(q.get("n")) || 1, 1), 8),
    steps: Number(q.get("steps")) || 28, scale: Number(q.get("scale")) || 5,
    sampler: q.get("sampler") || "k_euler_ancestral", noise_schedule: q.get("noise_schedule") || "karras",
    negative_prompt: q.get("negative") || "",
  };
  if (q.get("seed") !== null) p.seed = Number(q.get("seed")) || 0;
  return { model: q.get("model") || "nai-diffusion-4-5-full", action: "generate", input: [q.get("artist") ? `${q.get("artist")}, ${tag}` : tag], parameters: p };
}
async function externalGenerateDirect(request: Request, env: Env, url: URL) {
  const token = url.searchParams.get("token");
  const authRequest = token ? new Request(request, { headers: new Headers({ ...Object.fromEntries(request.headers), Authorization: `Bearer ${token}` }) }) : request;
  const keyRow = await resolveExternalAuth(authRequest, env);
  const naiBody = queryToNai(url);
  if (keyRow !== "admin") applyGatewayPolicyToBody(keyRow, naiBody);
  const { resp, account } = await generateViaPool(env, naiBody);
  if (!resp.ok) return forward(resp);
  const { data } = await upstreamJson(resp);
  const first = Array.isArray(data?.images) ? data.images[0] : null;
  if (!first) throw new HttpError("上游未返回图片", 502, "NO_IMAGES");
  const h = new Headers({ "Content-Type": "image/png", "Cache-Control": "no-store", "X-Ynai-Account": account });
  return new Response(decodeImageB64(first), { headers: h });
}
async function externalChatGenerate(request: Request, env: Env) {
  const keyRow = await resolveExternalAuth(request, env);   // 鉴权移入处理函数：单次解析、单次计数
  const body = await readJson<any>(request);
  const prompt = promptFromChat(body);
  if (!prompt) throw new HttpError("messages 中没有可用提示词", 400, "PROMPT_REQUIRED");
  const input = /[㐀-鿿]/.test(prompt) ? await convertChinesePrompt(env, prompt) : prompt;
  const size = SIZE_ALIAS[String(body?.size || "")] || String(body?.size || "832x1216");
  const nai = openaiToNai({ model: body?.model, prompt: input, size, n: body?.n, parameters: body?.parameters });
  if (keyRow !== "admin") applyGatewayPolicyToBody(keyRow, nai);
  const { resp, account } = await generateViaPool(env, nai);
  if (!resp.ok) return forward(resp);
  const { data } = await upstreamJson(resp);
  const images = Array.isArray(data?.images) ? data.images : [];
  if (!images.length) throw new HttpError("上游未返回图片", 502, "NO_IMAGES");
  const content = images.map((b64: string, i: number) => `![Generated Image ${i + 1}](data:image/png;base64,${b64})`).join("\n\n");
  return json({ id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: nai.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: input.length, completion_tokens: 0, total_tokens: input.length }, cost_gems: data?.job?.cost_gems ?? null }, 200, account ? { "X-Ynai-Account": account } : {});
}

/* ================= 分发密钥管理 ================= */
async function gatewayKeysRoute(request: Request, env: Env, rest: string) {
  const idMatch = rest.match(/^\/(\d+)$/), id = idMatch ? Number(idMatch[1]) : 0;
  if (request.method === "GET" && rest === "") { const { results } = await env.DB.prepare("SELECT * FROM gateway_keys ORDER BY id DESC").all<GatewayKeyRow>(); return json({ items: (results || []).map(gatewayKeyPublic) }); }
  if (request.method === "POST" && rest === "") { requireOrigin(request, env); const body = await readJson<any>(request); const now = nowIso(); const key = "yst-" + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, "0")).join(""); const mode = gatewayMode({}, body); const policy = gatewayPolicyFromBody(body); const r = await env.DB.prepare("INSERT INTO gateway_keys(name,key,mode,policy_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(String(body?.name || "").slice(0, 80), key, mode, JSON.stringify(policy), now, now).run(); return json(gatewayKeyPublic({ id: Number(r.meta.last_row_id), name: String(body?.name || ""), key, enabled: 1, mode, policy_json: JSON.stringify(policy), use_count: 0, last_used_at: null, created_at: now, updated_at: now } as GatewayKeyRow)); }
  if (!id) throw new HttpError("未知 Gateway Key 路由", 404, "ROUTE_NOT_FOUND");
  if (request.method === "PATCH") { requireOrigin(request, env); const body = await readJson<any>(request); const current = await env.DB.prepare("SELECT * FROM gateway_keys WHERE id=?").bind(id).first<GatewayKeyRow>(); if (!current) throw new HttpError("Gateway Key 不存在", 404, "GATEWAY_KEY_NOT_FOUND"); const sets: string[] = [], vals: any[] = []; if (body?.name !== undefined) { sets.push("name=?"); vals.push(String(body.name).slice(0, 80)); } if (body?.enabled !== undefined) { sets.push("enabled=?"); vals.push(body.enabled ? 1 : 0); } if (body?.request_mode !== undefined || body?.mode !== undefined) { sets.push("mode=?"); vals.push(gatewayMode(current, body)); } if (body?.policy !== undefined || GATEWAY_POLICY_FIELDS.some(f => body?.[f] !== undefined)) { sets.push("policy_json=?"); vals.push(JSON.stringify(gatewayPolicyFromBody(body, gatewayPolicy(current)))); } if (!sets.length) throw new HttpError("没有可更新字段", 400, "NO_FIELDS"); sets.push("updated_at=?"); vals.push(nowIso(), id); await env.DB.prepare(`UPDATE gateway_keys SET ${sets.join(",")} WHERE id=?`).bind(...vals).run(); const row = await env.DB.prepare("SELECT * FROM gateway_keys WHERE id=?").bind(id).first<GatewayKeyRow>(); return json(gatewayKeyPublic(row!)); }
  if (request.method === "DELETE") { requireOrigin(request, env); await env.DB.prepare("DELETE FROM gateway_keys WHERE id=?").bind(id).run(); return json({ ok: true }); }
  throw new HttpError("未知 Gateway Key 路由", 404, "ROUTE_NOT_FOUND");
}

async function tokensRoute(request: Request, env: Env, rest: string) {
  const idMatch = rest.match(/^\/(\d+)$/);
  if (request.method === "GET" && rest === "") { const { results } = await env.DB.prepare("SELECT id,name,key,enabled,use_count,last_used_at,created_at FROM api_tokens ORDER BY id DESC").all<any>(); return json({ items: results || [] }); }
  if (request.method === "POST" && rest === "") { requireOrigin(request, env); const body = await readJson<any>(request); const name = String(body?.name || "").slice(0, 40); const key = "yst-" + [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join(""); const created = nowIso(); const r = await env.DB.prepare("INSERT INTO api_tokens(name,key,created_at) VALUES(?,?,?)").bind(name, key, created).run(); return json({ id: Number(r.meta.last_row_id), name, key, enabled: 1, use_count: 0, last_used_at: null, created_at: created }); }
  const id = idMatch ? Number(idMatch[1]) : 0;
  if (id && request.method === "PATCH") { requireOrigin(request, env); const body = await readJson<any>(request); if (body?.enabled === undefined) throw new HttpError("没有可更新字段", 400, "NO_FIELDS"); await env.DB.prepare("UPDATE api_tokens SET enabled=? WHERE id=?").bind(body.enabled ? 1 : 0, id).run(); return json({ ok: true }); }
  if (id && request.method === "DELETE") { requireOrigin(request, env); await env.DB.prepare("DELETE FROM api_tokens WHERE id=?").bind(id).run(); return json({ ok: true }); }
  throw new HttpError("未知令牌路由", 404, "ROUTE_NOT_FOUND");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url), path = url.pathname;
      let response: Response;
      // 公共画廊不经过管理 API 鉴权墙；其写操作在路由内部做 visitor/origin 校验。
      if (path.startsWith("/pub/")) {
        response = await publicGalleryRoute(request, env, path.slice("/pub/gallery".length));
        response = publicCors(response, request);
      }
      // /api/session 不鉴权：供前端探测模式与展示配置状态（账号细节走需密钥的 /api/accounts）
      else if (path === "/api/session") {
        let accounts = 0;
        try { accounts = (await env.DB.prepare("SELECT COUNT(*) AS c FROM accounts").first<any>())?.c || 0; } catch { /* D1 未迁移时仍能响应 */ }
        response = json({ configured: Boolean(env.YESNAI_JWT) || accounts > 0, accounts, access_key_required: Boolean(env.APP_ACCESS_KEY) });
      }
      else if (path.startsWith("/api/")) {
        requireAccessKey(request, env);
        if (path === "/api/stats" && request.method === "GET") response = await statsRoute(request, env, "stats");
        else if (path === "/api/logs" && request.method === "GET") response = await statsRoute(request, env, "logs");
        else if (path.startsWith("/api/ai/") && request.method !== "DELETE") response = await imageToolRoute(request, env, path.slice("/api/ai/".length));
        else if (path === "/api/prompt/status" && request.method === "GET") response = json(await promptApiStatus(env));
        else if (path === "/api/prompt/config" && request.method === "GET") { const c = await getPromptApiConfig(env); response = json({ base: c.base, model: c.model, configured: Boolean(c.base && c.key && c.model), key_configured: Boolean(c.key) }); }
        else if (path === "/api/prompt/config" && request.method === "PUT") { requireOrigin(request, env); response = json(await savePromptApiConfig(env, await readJson<any>(request))); }
        else if (path === "/api/prompt/models" && request.method === "POST") { requireOrigin(request, env); response = json({ models: await promptApiModels(env) }); }
        else if (path === "/api/prompt/convert" && request.method === "POST") { requireOrigin(request, env); const body = await readJson<any>(request); response = json({ prompt: await convertChinesePrompt(env, body?.prompt, body?.model) }); }
        else if (path === "/api/prompt/artist-assist" && request.method === "POST") { requireOrigin(request, env); response = json(await artistAssist(env, await readJson<any>(request))); }
        else if (path === "/api/prompt/artist-optimize" && request.method === "POST") { requireOrigin(request, env); response = json({ artist: await artistOptimize(env, await readJson<any>(request)) }); }
        else if (path === "/api/autocheckin/settings" && request.method === "GET") response = json(await getConfig(env));
        else if (path === "/api/autocheckin/settings" && request.method === "PATCH") { requireOrigin(request, env); response = json(await saveConfig(env, await readJson<any>(request))); }
        else if (path === "/api/autocheckin/test" && request.method === "POST") {
          requireOrigin(request, env);
          const body = await readJson<any>(request).catch(() => ({}));
          const acc = body?.account_id ? await getAccount(env, Number(body.account_id)) : null;
          if (acc) response = json(await performCheckin(env, acc, null, { manual: true }));
          else if (!(await claimLease(env))) response = json({ ok: false, message: "签到正在进行中，请稍后再试" });
          else {
            // 测试按钮：对全部启用账号各强制执行一次（无到点槽也不跳过）；手动结果不污染 cron 重试计数
            const config = await getConfig(env);
            const fallback = () => { const p = localParts(new Date(), config.timezone); return slotKey(p, `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`); };
            const results = [];
            for (const a of (await listAccounts(env)).filter(x => x.enabled)) {
              const slot = dueSlot(effectiveDayTimes(config, a), a) || fallback();
              results.push(await performCheckin(env, a, slot, { manual: true }));
            }
            response = json({ results });
          }
        }
        else if (path.startsWith("/api/accounts")) response = await accountsRoute(request, env, path.slice("/api/accounts".length));
        else if (path.startsWith("/api/gateway/keys")) response = await gatewayKeysRoute(request, env, path.slice("/api/gateway/keys".length));
        else if (path.startsWith("/api/tokens")) response = await tokensRoute(request, env, path.slice("/api/tokens".length));
        else if (path.startsWith("/api/gallery")) response = await galleryRoute(request, env, path.slice("/api/gallery".length));
        else if (path === "/api/nai/relay" && request.method === "POST") { requireOrigin(request, env); response = await upstreamRelay(request, env); }
        else if (path.startsWith("/api/yesnai/")) response = await yesnaiRoute(request, env, path.slice("/api/yesnai/".length));
        else response = error("API 路由不存在", 404, "ROUTE_NOT_FOUND");
      }
      // 统一密钥外部网关：NAI 兼容路径（供脚本 / 支持自定义 base URL 的工具直接调用）
      // Nai2API 兼容：GET 直链直接返回 PNG；token 可放 query，也可用 Authorization Header
      else if (path === "/generate" && request.method === "GET") response = await externalGenerateDirect(request, env, url);
      else if (path === "/v1/chat/completions" && request.method === "POST") { response = await externalChatGenerate(request, env); }
      else if (path === "/v1/models" && request.method === "GET") {
        await requireGatewayOrExternalAuth(request, env);
        const resp = await yesnaiFetch(env, "/v1/models");
        if (!resp.ok) return securityHeaders(gatewayForwardResponse(resp));
        const { data } = await upstreamJson(resp);
        response = json(openaiModelList(data));
      }
      else if (path === "/v1/nai/generate-image" && request.method === "POST") { response = await gatewayGenerate(request, env, "/v1/nai/generate-image"); }
      // OpenAI 兼容生图端点：Gateway Key 或管理员访问密钥，body {model,prompt,size,n,parameters?}
      // 鉴权与 use_count 计数都在 gatewayGenerate 内部一次完成（此前路由层重复解析导致每请求 +2）
      else if (path === "/v1/images/generations" && request.method === "POST") { response = await gatewayGenerate(request, env, "/v1/images/generations"); }
      else if (path === "/v1/balance" && request.method === "GET") {
        requireExternalKey(request, env);
        await ensureBootstrapped(env);
        const list = (await listAccounts(env)).map(accountPublic);
        let totalGems = 0; for (const a of list) totalGems += a.gems_last || 0;
        response = json({ accounts: list.map(a => ({ label: a.label, gems: a.gems_last, enabled: a.enabled })), total_gems: totalGems });
      }
      else response = await env.ASSETS.fetch(request);
      return securityHeaders(response);
    } catch (e: any) {
      if (e && e.name === "TimeoutError") return securityHeaders(error("上游请求超时", 504, "UPSTREAM_TIMEOUT"));
      console.error("[worker]", e && e.stack || String(e));
      const failed = e instanceof HttpError ? error(e.message, e.status, e.code) : error("服务器内部错误", 500, "INTERNAL_ERROR");
      failed.headers.set("X-Gateway-Request-Id", e?.requestId || crypto.randomUUID());
      if (e?.attempts != null) failed.headers.set("X-Gateway-Attempts", String(e.attempts));
      return securityHeaders(failed);
    }
  },
  // cron 异常绝不能逃逸：一条坏数据打死调度的事不能再发生
  async scheduled(_event: ScheduledEvent, env: Env) {
    try { await runScheduled(env); }
    catch (e) { console.error("[scheduled]", e && e.stack || String(e)); }
  },
};
