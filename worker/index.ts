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
  LOG_RETENTION_DAYS?: string; // 请求/签到日志保留天数，默认 30
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
// 一次 cron 调用里留给签到的子请求预算（50 减去配置读取、租约、清理日志等固定开销）
const CRON_SUBREQUEST_BUDGET = 36;
const BATCH_MAX = 8, REFRESH_MAX = 15, TEST_ALL_MAX = 6;   // 同理：批量导入 / 刷新余额 / 全部测试每次调用处理的账号数
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
// 定长比较，避免逐字节比较泄露密钥前缀的时间差
function safeEqual(a: string, b: string) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
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
// 响应头只能是 Latin-1：账号标签多为中文（如「主账号（Secret）」），直接 set 会抛 TypeError，统一 URL 编码
function withAccountHeader(response: Response, account: string) {
  if (!account) return response;
  const h = new Headers(response.headers); h.set("X-Ynai-Account", encodeURIComponent(account));
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
  // 只转发白名单头：旧实现透传全部请求头，会把 X-Access-Key、Cookie、调用方真实 IP 等一并发给上游
  const h = new Headers();
  for (const name of ["Accept", "Accept-Language", "User-Agent"]) { const v = request.headers.get(name); if (v) h.set(name, v); }
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
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64) }, key, fromB64(ctB64));
    return new TextDecoder().decode(pt);
  } catch {
    // 原来这里会抛出看不懂的 OperationError（500 服务器内部错误）
    throw new HttpError("账号凭据无法解密：APP_ACCESS_KEY 可能已更换，请换回原密钥或重新导入账号", 500, "CREDENTIAL_DECRYPT_FAILED");
  }
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
// 首次运行：把 Worker Secret 里的单账号引导成 accounts 表的第一行，之后统一走表。
// 表里有过账号后，本隔离内不再重复查询（每次生图省一次 D1 往返）。
let bootstrapped = false;
async function ensureBootstrapped(env: Env) {
  if (bootstrapped) return;
  // 没配 Secret 就不引导：旧实现会插入一个没有任何凭据的「主账号（Secret）」，排在第一位导致默认生图/余额/签到都失败
  if (!env.YESNAI_JWT && !env.YESNAI_API_TOKEN) { bootstrapped = true; return; }
  const { results } = await env.DB.prepare("SELECT id FROM accounts LIMIT 1").all();
  if ((results || []).length) { bootstrapped = true; return; }
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
// advance=false 只"看"当前轮到谁、不推进游标：余额/报价/签到等非生图请求用它。
// 旧实现里这些请求也会推进游标——每次生图后前端刷新余额又推进一格，两个账号时「自动」永远落在同一个账号上。
async function roundRobinPool(env: Env, accounts?: AccountRow[], advance = true): Promise<AccountRow[]> {
  const all = (accounts || await listAccounts(env)).filter(a => a.enabled);
  const withTok = all.filter(a => a.api_token_enc).sort((x, y) => x.id - y.id);
  if (withTok.length <= 1) return withTok.length ? withTok : (all.length ? [all[0]] : []);
  let start = 0;
  try {
    if (advance) {
      const row = await env.DB.prepare(
        `INSERT INTO runtime_kv(k,v) VALUES('rr_cursor','1') ON CONFLICT(k) DO UPDATE SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT) RETURNING v`
      ).first<any>();
      start = Math.max(0, (Number(row?.v) || 1) - 1) % withTok.length;
    } else {
      const row = await env.DB.prepare("SELECT v FROM runtime_kv WHERE k='rr_cursor'").first<any>();
      start = Math.max(0, Number(row?.v) || 0) % withTok.length;   // 下一次生图将轮到的账号
    }
  } catch { /* runtime_kv 未迁移时退化为按 id 顺序，绝不让选号 500 */ }
  return [...withTok.slice(start), ...withTok.slice(0, start)];
}
async function resolveAccount(env: Env, request: Request): Promise<AccountRow> {
  await ensureBootstrapped(env);
  const raw = String(request.headers.get("X-Account-Id") || "").trim();
  if (raw === "auto") {
    const seq = await roundRobinPool(env, undefined, false);
    if (!seq.length) throw new HttpError("没有可用账号——请在设置里添加 YesNAI 账号", 409, "NO_ACCOUNT");
    return seq[0];
  }
  const headerId = Number(raw);
  const acc = headerId ? await getAccount(env, headerId) : null;
  if (acc) return acc;
  const all = await listAccounts(env);
  const active = all.find(a => a.enabled) || all[0];
  if (!active) throw new HttpError("没有可用账号——请在设置里添加 YesNAI 账号", 409, "NO_ACCOUNT");
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
// 同一用户名（不区分大小写）只保留一行：已存在则更新凭据，避免重复导入后重复签到、在账号池里重复轮询
async function upsertAccount(env: Env, v: { username: string; password: string; jwt: string; label?: unknown; apiToken?: string }): Promise<AccountRow> {
  const existing = await env.DB.prepare("SELECT * FROM accounts WHERE lower(username)=lower(?) ORDER BY id LIMIT 1").bind(v.username).first<AccountRow>();
  if (existing) {
    const patch: Record<string, unknown> = { jwt_enc: await seal(env, v.jwt), password_enc: await seal(env, v.password), enabled: 1 };
    if (v.apiToken) patch.api_token_enc = await seal(env, v.apiToken);
    if (v.label) patch.label = String(v.label).slice(0, 40);
    await updateAccount(env, existing.id, patch);
    return (await getAccount(env, existing.id))!;
  }
  const now = nowIso();
  const r = await env.DB.prepare(`INSERT INTO accounts(label,username,jwt_enc,password_enc,api_token_enc,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)`)
    .bind(String(v.label || v.username).slice(0, 40), v.username, await seal(env, v.jwt), await seal(env, v.password), v.apiToken ? await seal(env, v.apiToken) : "", now, now).run();
  return (await getAccount(env, Number(r.meta.last_row_id)))!;
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
  const current = p.hour * 60 + p.minute;
  const due = [...times].sort().filter(t => current >= slotMinutes(t));
  if (!due.length) return null;
  // 补签：优先今天最早一个还没尝试过的槽（覆盖 cron 停机跨槽的情况）；全部试过则落到最新槽进入重试
  // 槽状态按「当天集合」记录而非单值，避免多时间槽互相顶掉对方的已签记录导致整晚重复签到
  // 站点签到每天只能成功一次：今天任一槽已成功就不再发请求（否则后面的槽每天会多打一次上游）
  const today = slotKey(p, "");
  if ((acc.success_slots || []).some(k => k.startsWith(today))) return null;
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
function nowSlot(config: ReturnType<typeof parseConfig>, date = new Date()) {
  const p = localParts(date, config.timezone);
  return slotKey(p, `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`);
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
async function performCheckin(env: Env, acc: AccountRow, slot: string | null, opts: { manual?: boolean } = {}, cfg?: ReturnType<typeof parseConfig>) {
  const config = cfg || await getConfig(env);   // cron 传入已读好的配置，省一次 D1 查询
  // 手动测试无到点槽时按「当前时刻」强制执行一次（与「全部测试」一致）
  const actualSlot = slot || dueSlot(effectiveDayTimes(config, acc), acc) || (opts.manual ? nowSlot(config) : null);
  if (!actualSlot) return { ok: false, skipped: true, message: "今天已签到，或还没到签到时间" };
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
    if (response.ok) await updateAccount(env, acc.id, { last_attempt_slot: actualSlot, last_attempt_at: nowIso(), last_success_slot: actualSlot, status: "success", last_message: message, retry_count: 0, attempt_slots: JSON.stringify(attemptedSlots), success_slots: JSON.stringify(successSlots) });
    else await updateAccount(env, acc.id, { last_attempt_slot: actualSlot, last_attempt_at: nowIso(), status: "retry", last_message: message, attempt_slots: JSON.stringify(attemptedSlots), success_slots: JSON.stringify(successSlots) });
  } else {
    // 换槽时重试计数归零，保证「每槽最多 1+4 次尝试」
    // 失败时保留上一次成功槽（不再置空），dueSlot 依赖它判断「今天已签」
    await updateAccount(env, acc.id, {
      last_attempt_slot: actualSlot, last_attempt_at: nowIso(), last_success_slot: response.ok ? actualSlot : undefined, status, last_message: message,
      retry_count: response.ok ? 0 : (isNewSlot ? 1 : acc.retry_count + 1),
      attempt_slots: JSON.stringify(attemptedSlots), success_slots: JSON.stringify(successSlots),
    });
  }
  await env.DB.prepare("INSERT INTO autocheckin_logs(account_id,attempted_at,slot,ok,status_code,message) VALUES(?,?,?,?,?,?)").bind(acc.id, nowIso(), actualSlot, response.ok ? 1 : 0, response.status, logMsg).run();
  return { ok: response.ok, message, status, slot: actualSlot, account: accountPublic(acc).label, jwt };
}

// 上游 ynai 业务响应存在两种形状：对象本体或 {message,data:{...}} 包一层，读法统一解包（仅图包购买流程使用）
function unwrapEnvelope(data: any) {
  return data && typeof data === "object" && data.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : data;
}
// 签到完成后按需自动购买图包（默认关闭，迁移 0011）：图包次数低于阈值且余额够 1 包时买 1 包。
// 结果（买了/没买原因/失败原因）写一条 autocheckin_logs（slot='autobuy'）；异常上抛由调用方兜底，绝不影响签到主流程。
async function autoBuyPacks(env: Env, acc: AccountRow, cfg?: ReturnType<typeof parseConfig>, jwtIn?: string) {
  const config = cfg || await getConfig(env);
  const threshold = clampAutobuyThreshold(config.autobuy_threshold);
  const label = accountPublic(acc).label;
  const log = (ok: boolean, statusCode: number, message: string) =>
    env.DB.prepare("INSERT INTO autocheckin_logs(account_id,attempted_at,slot,ok,status_code,message) VALUES(?,?,?,?,?,?)")
      .bind(acc.id, nowIso(), "autobuy", ok ? 1 : 0, statusCode, `[${label}] ${message}`.slice(0, 300)).run();
  // 签到流程直接把它用过（可能刚重登刷新过）的 JWT 传进来；单独调用时才重新读账号行
  const jwt = jwtIn || await accountJwt(env, (await getAccount(env, acc.id)) || acc);
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
  // 先筛出本轮真正要签的账号，没有就不占租约（旧实现每次都占 10 分钟租约且从不释放，
  // 导致到点签到被推迟一个 cron 周期、手动测试也常被「正在进行中」挡住）
  const todo = accounts.filter(acc => {
    const slot = dueSlot(effectiveDayTimes(config, acc), acc);   // 每账号按自己的时刻表取槽
    if (!slot) return false;
    const fresh = !(acc.attempt_slots || []).includes(slot);      // 按当天集合判断，多槽互不误判
    const lastAttempt = acc.last_attempt_at ? Date.parse(acc.last_attempt_at) : 0;
    const backoffOk = !lastAttempt || Date.now() - lastAttempt >= RETRY_BACKOFF_MS;
    const retryable = acc.status === "retry" && acc.retry_count < RETRY_MAX && backoffOk;
    return fresh || retryable;
  });
  if (!todo.length) return;
  if (!(await claimLease(env))) return;
  try {
    // 免费计划每次调用最多 50 个子请求（D1 查询 + 外部 fetch 合计）。实测每个账号签到约 5 个、
    // 加自动买图包约 8 个，10 个账号一次跑完要 100 个，第 5、6 个账号之后会全部报错。
    // 所以每轮只处理放得下的几个，剩下的留给下一轮 cron（5 分钟后，已签的不会重复）。
    const perAccount = config.autobuy_enabled ? 8 : 5;
    const maxThisRun = Math.max(1, Math.floor(CRON_SUBREQUEST_BUDGET / perAccount));
    // 错峰：账号顺序随机打散，每个账号之间 3~8 秒随机间隔，避免整批瞬时连发
    const order = shuffle(todo).slice(0, maxThisRun);
    for (let i = 0; i < order.length; i++) {
      const acc = order[i];
      if (i > 0) await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
      await checkinOne(env, config, acc);
    }
  } finally { await releaseLease(env); }
}
function shuffle<T>(list: T[]): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
async function releaseLease(env: Env) {
  await env.DB.prepare("UPDATE autocheckin_config SET lease_until=NULL WHERE id=1").run().catch(() => {});
}
async function checkinOne(env: Env, config: ReturnType<typeof parseConfig>, acc: AccountRow) {
  const slot = dueSlot(effectiveDayTimes(config, acc), acc);
  if (!slot) return;
  try {
    const res: any = await performCheckin(env, acc, slot, {}, config);
    if (config.autobuy_enabled) {
      // 签到完成（成功或失败）后按开关自动购买图包；任何异常只记日志，不中断签到主流程
      try { await autoBuyPacks(env, acc, config, res?.jwt); }
      catch (e) { console.error("[autobuy]", accountPublic(acc).label, e); }
    }
  } catch (e) {
    // 单账号故障不拖垮整批；终态错误（过期/人机验证）不再无意义重试。
    // 记下槽位与时间，让 30 分钟退避和「每槽最多 1+4 次」对异常路径同样生效
    if (acc.status !== "jwt_expired" && acc.status !== "manual_required") {
      const sameSlot = acc.last_attempt_slot === slot;
      const dayPrefix = slot.split("T")[0] + "T";
      const attemptedSlots = [...new Set([...(acc.attempt_slots || []), slot])].filter(k => k.startsWith(dayPrefix));
      await updateAccount(env, acc.id, { status: "retry", last_attempt_slot: slot, last_attempt_at: nowIso(), last_message: String(e).slice(0, 300), retry_count: sameSlot ? acc.retry_count + 1 : 1, attempt_slots: JSON.stringify(attemptedSlots) }).catch(() => {});
    }
    console.error("[scheduled]", accountPublic(acc).label, e);
  }
}

/* ================= YesNAI 代理（按所选账号） ================= */
async function yesnaiRoute(request: Request, env: Env, route: string) {
  if (route === "models") return forward(await yesnaiFetch(env, "/v1/models"));
  if (route === "generate" && String(request.headers.get("X-Account-Id") || "").trim() === "auto") {
    // 「自动」= 账号池轮询 + 失败转移（旧实现只取轮到的第一个账号，失败不换号）
    requireOrigin(request, env);
    const { resp, account } = await generateViaPool(env, await readJson<any>(request));
    return withAccountHeader(await forward(resp), account);
  }
  const acc = await resolveAccount(env, request);
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
  const map: Record<string, string> = { "encode-vibe": "/api/ai/encode-vibe", "upscale": "/api/ai/upscale", "augment-image": "/api/ai/augment-image", "annotate-image": "/api/ai/annotate-image",
    // 前端调用的是 generate-image/suggest-tags（与 NovelAI 官方 /ai/generate-image/suggest-tags 一致），旧映射表里没有，恒 404
    "generate-image/suggest-tags": "/api/ai/generate-image/suggest-tags", "suggest-tags": "/api/ai/generate-image/suggest-tags" };
  const upstreamPath = map[route];
  if (!upstreamPath) throw new HttpError("未知图片工具路由", 404, "ROUTE_NOT_FOUND");
  if (request.method !== "GET") requireOrigin(request, env);
  const acc = await resolveAccount(env, request);
  // AI tools use the upstream API token; retain JWT as a compatibility fallback for old accounts.
  const token = (await unseal(env, acc.api_token_enc).catch(() => "")) || await accountJwt(env, acc);
  // 只带必要的头给上游：不转发访问密钥、Cookie、调用方 IP 等
  const headers = new Headers();
  for (const name of ["Content-Type", "Accept", "Accept-Language", "User-Agent"]) { const v = request.headers.get(name); if (v) headers.set(name, v); }
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
      FROM request_logs l WHERE ${clause} ORDER BY l.created_at DESC,l.id DESC LIMIT ? OFFSET ?`).bind(...binds, limit + 1, offset).all<any>();
    const rows = items.results || [], hasMore = rows.length > limit; if (hasMore) rows.pop();
    // 总条数要把整段时间的日志全数一遍（每天 1000 次请求、7 天就是 7000 行读取），默认不算；需要时加 ?total=1
    const out: any = { items: rows, logs: rows, has_more: hasMore };
    if (u.searchParams.get("total") === "1") out.total = Number((await env.DB.prepare(`SELECT COUNT(*) c FROM request_logs WHERE ${clause}`).bind(...binds).first<any>())?.c || 0);
    return json(out);
  }
  // 读按天汇总表（迁移 0014）：行数 = 天数 × 模型数 × 账号数，与请求量无关
  const today = new Date().toISOString().slice(0, 10), sinceDate = since.slice(0, 10);
  const agg = "SUM(requests) requests,SUM(ok) ok,SUM(gems) gems,CAST(SUM(duration_ms) AS REAL)/MAX(1,SUM(requests)) avg_ms";
  const [t, daily, by_model, by_account] = await Promise.all([
    env.DB.prepare(`SELECT ${agg} FROM stats_daily WHERE date=?`).bind(today).first<any>(),
    env.DB.prepare(`SELECT date,${agg} FROM stats_daily WHERE date>=? GROUP BY date ORDER BY date DESC`).bind(sinceDate).all<any>(),
    env.DB.prepare(`SELECT model,${agg} FROM stats_daily WHERE date>=? GROUP BY model ORDER BY requests DESC`).bind(sinceDate).all<any>(),
    env.DB.prepare(`SELECT NULLIF(account_id,0) account_id,${agg} FROM stats_daily WHERE date>=? GROUP BY account_id ORDER BY requests DESC`).bind(sinceDate).all<any>(),
  ]);
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
    const acc = await upsertAccount(env, { username, password, jwt, label: body?.label, apiToken: body?.api_token ? String(body.api_token).trim() : "" });
    return json(accountPublic(acc));
  }
  // POST /api/accounts/batch —— 批量导入：{items:[{username,password},...]}，逐个登录收录，单条失败不中断
  if (request.method === "POST" && rest === "/batch") {
    requireOrigin(request, env);
    const body = await readJson<any>(request);
    const items = (Array.isArray(body?.items) ? body.items : [])
      .map((x: any) => ({ username: String(x?.username || "").trim(), password: String(x?.password || "") }))
      .filter((x: any) => x.username && x.password);
    if (!items.length) throw new HttpError("没有可导入的账号（格式：账号----密码，每行一个）", 400, "ACCOUNT_BATCH_EMPTY");
    // 免费计划每次调用最多 50 个子请求，每个账号导入约 4 个：一次最多处理 BATCH_MAX 个，多出的返回给调用方下次再发
    const rest = items.splice(BATCH_MAX);
    const results: any[] = [];
    for (const it of items) {
      try {
        if (await env.DB.prepare("SELECT id FROM accounts WHERE username=?").bind(it.username).first<any>()) { results.push({ username: it.username, ok: false, message: "该账号已在账号池中" }); continue; }
        const { jwt } = await upstreamLogin(env, it.username, it.password);
        const acc = await upsertAccount(env, { username: it.username, password: it.password, jwt });
        results.push({ username: it.username, ok: true, label: accountPublic(acc).label });
      } catch (e: any) {
        results.push({ username: it.username, ok: false, message: String(e?.message || e).slice(0, 120) });
      }
    }
    const list = (await listAccounts(env)).map(accountPublic);
    let totalGems = 0; for (const a of list) totalGems += a.gems_last || 0;
    return json({ results, added: results.filter(x => x.ok).length, remaining: rest, items: list, total_gems: totalGems });
  }
  // POST /api/accounts/refresh_gems —— 刷新全部账号余额
  if (request.method === "POST" && rest === "/refresh_gems") {
    requireOrigin(request, env);
    const results: any[] = [];
    const body = await readJson<any>(request).catch(() => ({}));
    const all = await listAccounts(env), offset = Math.max(0, Number(body?.offset) || 0);
    // 分页刷新（每个账号 2 个子请求，一次最多 REFRESH_MAX 个），前端按 next_offset 继续
    const page = all.slice(offset, offset + REFRESH_MAX), nextOffset = offset + page.length < all.length ? offset + page.length : null;
    for (const acc of page) {
      if (!acc.jwt_enc) { results.push({ id: acc.id, ok: false, message: "无 JWT" }); continue; }
      try { const gems = await fetchBalance(env, acc); results.push({ id: acc.id, ok: true, gems }); }
      catch (e: any) { results.push({ id: acc.id, ok: false, message: e.message }); }
    }
    const list = (await listAccounts(env)).map(accountPublic);
    let totalGems = 0; for (const a of list) totalGems += a.gems_last || 0;
    return json({ results, next_offset: nextOffset, items: list, total_gems: totalGems });
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
    const r: any = await performCheckin(env, acc, null, { manual: true }); delete r.jwt;   // 不把 JWT 返回给前端
    return json(r);
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
async function readGalleryUpload(request: Request) {
  if (Number(request.headers.get("Content-Length") || 0) > MAX_JSON_BYTES) throw new HttpError("请求体过大", 413, "BODY_TOO_LARGE");
  if ((request.headers.get("Content-Type") || "").toLowerCase().startsWith("multipart/form-data")) {
    let form: FormData;
    try { form = await request.formData(); } catch { throw new HttpError("上传表单无效", 400, "GALLERY_BAD_FORM"); }
    const file = (name: string) => { const v = form.get(name) as unknown; return v && typeof v === "object" && "arrayBuffer" in (v as any) ? v as File : null; };
    const img = file("image"), thumb = file("thumb");
    let m: any = {}; try { m = JSON.parse(String(form.get("meta") || "{}")) || {}; } catch {}
    return {
      imgBytes: new Uint8Array(img ? await img.arrayBuffer() : new ArrayBuffer(0)),
      thumbBytes: thumb ? new Uint8Array(await thumb.arrayBuffer()) : null,
      fmt: String(form.get("fmt") || "png").toLowerCase(), thumbFmt: String(form.get("thumb_fmt") || "png").toLowerCase(), m,
    };
  }
  const body = await readJson<any>(request);
  const thumb = String(body?.thumb || "");
  return {
    imgBytes: body?.image ? b64ToBytes(String(body.image)) : new Uint8Array(0),
    thumbBytes: thumb ? b64ToBytes(thumb) : null,
    fmt: String(body?.fmt || "png").toLowerCase(), thumbFmt: String(body?.thumb_fmt || "png").toLowerCase(), m: body?.meta || {},
  };
}
async function galleryRoute(request: Request, env: Env, rest: string) {
  // POST /api/gallery —— 上传一张（原图 + canvas 缩略图 + 元数据）
  if (request.method === "POST" && rest === "") {
    requireOrigin(request, env);
    // 两种上传格式：multipart（新前端，原图与缩略图直接二进制，省掉 base64 的 1/3 体积和解码）与旧的 JSON base64（兼容）
    const { imgBytes, thumbBytes, fmt, thumbFmt: thumbFmtRaw, m } = await readGalleryUpload(request);
    if (!imgBytes.byteLength) throw new HttpError("缺少图片数据", 400, "GALLERY_NO_IMAGE");
    if (!IMG_TYPES[fmt]) throw new HttpError(`不支持的图片格式：${fmt}`, 400, "GALLERY_BAD_FORMAT");
    const thumbFmt = IMG_TYPES[thumbFmtRaw] ? thumbFmtRaw : "png";
    const normalizedMeta = normalizeNaiBody({ parameters: { sampler: m.sampler, noise_schedule: m.noise } }).parameters;
    const id = crypto.randomUUID();
    await env.R2.put(`img/${id}`, imgBytes, { httpMetadata: { contentType: IMG_TYPES[fmt] } });
    if (thumbBytes) await env.R2.put(`thumb/${id}`, thumbBytes, { httpMetadata: { contentType: IMG_TYPES[thumbFmt] } });
    // params_json 截断会变成坏 JSON、复现时静默丢参数：超长就不存，而不是截断
    const paramsJson = String(m.params_json || "");
    await env.DB.prepare(`INSERT INTO gallery(id,ts,fmt,thumb_fmt,prompt,prompt_base,artist,artist_id,artist_name,final_prompt,neg,model,seed,w,h,steps,scale,sampler,noise,n,action,cost,params_json,prompt_hash,snapshot_id,bytes,thumb_bytes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, Number(m.ts) || Date.now(), fmt, thumbFmt,
        String(m.prompt || "").slice(0, 2000), String(m.promptBase || "").slice(0, 2000), String(m.artist || "").slice(0, 4000),
        String(m.artistId || "").slice(0, 200), String(m.artistName || "").slice(0, 200), String(m.final_prompt || m.prompt || "").slice(0, 4000),
        String(m.neg || "").slice(0, 1000), String(m.model || ""),
        Number(m.seed) || 0, Number(m.w) || 0, Number(m.h) || 0, Number(m.steps) || 0, Number(m.scale) || 0,
        normalizedMeta.sampler, normalizedMeta.noise_schedule, Number(m.n) || 1, String(m.action || "generate"),
        m.cost == null ? null : Number(m.cost), paramsJson.length <= 8000 ? paramsJson : "", String(m.promptHash || m.prompt_hash || "").slice(0, 80), String(m.snapshotId || m.snapshot_id || "").slice(0, 80),
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
      const list = await env.R2.list({ cursor, limit: 1000 });
      const keys = list.objects.map(o => o.key);
      if (keys.length) { await env.R2.delete(keys); deleted += keys.length; }   // 批量删除，一次最多 1000 个
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    await env.DB.prepare("DELETE FROM gallery").run();
    await bumpPubVersion(env);
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
    const select = `SELECT id,ts,fmt,thumb_fmt,prompt,prompt_base AS promptBase,artist,artist_id AS artistId,artist_name AS artistName,final_prompt,neg,model,seed,w,h,steps,scale,sampler,noise,n,action,cost,params_json,prompt_hash AS promptHash,snapshot_id AS snapshotId,bytes,public,title,tags,rating,prompt_disclosed,params_disclosed FROM gallery${where} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`;
    const res = await env.DB.prepare(select).bind(...binds, limit + 1, offset).all<any>();
    const items = res.results || [], hasMore = items.length > limit; if (hasMore) items.pop();
    // COUNT(*) 每次都要把整个画廊数一遍（D1 按扫描行数计费），只在第一页算；顺带给出占用空间（R2 免费 10 GB）
    const out: any = { items, has_more: hasMore };
    if (offset === 0) {
      const t = await env.DB.prepare(`SELECT COUNT(*) AS c, SUM(COALESCE(bytes,0)+COALESCE(thumb_bytes,0)) AS b FROM gallery${where}`).bind(...binds).first<any>();
      out.total = Number(t?.c || 0); if (!where) out.storage_bytes = Number(t?.b || 0);
    }
    return json(out);
  }
  // GET /api/gallery/i/{id}?t=img|thumb —— 输出图片
  let m = rest.match(/^\/i\/([A-Za-z0-9-]+)$/);
  if (request.method === "GET" && m) {
    const id = m[1];
    const kind = new URL(request.url).searchParams.get("t") === "thumb" ? "thumb" : "img";
    let obj = await env.R2.get(`${kind}/${id}`), servedKind = kind;
    // 没有缩略图（生成缩略图失败 / 旧数据）时直接回退原图，省掉前端一次 404 + 重试
    if (!obj && kind === "thumb") { obj = await env.R2.get(`img/${id}`); servedKind = "img"; }
    if (!obj) throw new HttpError("图片不存在", 404, "GALLERY_NOT_FOUND");
    // 上传时已把 Content-Type 写进 R2 元数据，画廊一屏几十张缩略图就省掉几十次 D1 查询；只有没写元数据的旧对象才回查数据库
    let type = obj.httpMetadata?.contentType;
    if (!type) {
      const row = await env.DB.prepare("SELECT fmt,thumb_fmt FROM gallery WHERE id=?").bind(id).first<any>();
      type = IMG_TYPES[servedKind === "thumb" ? (row?.thumb_fmt || "png") : row?.fmt] || "application/octet-stream";
    }
    return new Response(obj.body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" } });
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
      await bumpPubVersion(env);
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
    await bumpPubVersion(env);
    return json({ ok: true, public: true, id });
  }
  // DELETE /api/gallery/{id}
  m = rest.match(/^\/([A-Za-z0-9-]+)$/);
  if (request.method === "DELETE" && m) {
    requireOrigin(request, env);
    const id = m[1];
    await env.R2.delete([`img/${id}`, `thumb/${id}`]);
    const r = await env.DB.prepare("DELETE FROM gallery WHERE id=?").bind(id).run();
    await bumpPubVersion(env);
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

// 广场列表缓存的版本号：发布 / 撤回 / 删除 / 点赞后 +1，缓存键带版本号，所以改动立刻可见
async function bumpPubVersion(env: Env) {
  await env.DB.prepare("INSERT INTO runtime_kv(k,v) VALUES('pub_ver','1') ON CONFLICT(k) DO UPDATE SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT)").run().catch(() => {});
}
// 广场列表（不含访客个人的点赞状态，可被边缘缓存）
async function publicList(env: Env, u: URL) {
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit")) || 24, 1), GALLERY_PAGE_MAX), offset = Math.max(Number(u.searchParams.get("offset")) || 0, 0);
  const search = String(u.searchParams.get("search") || "").trim().slice(0, 100), rating = String(u.searchParams.get("rating") || "").trim().toLowerCase(), sort = String(u.searchParams.get("sort") || "new").trim().toLowerCase();
  const where = ["public=1"]; const binds: any[] = [];
  // 只在作者公开了提示词的作品里搜 prompt，否则可以逐词探测未公开的提示词
  if (search) { where.push("(title LIKE ? OR tags LIKE ? OR (prompt_disclosed=1 AND prompt LIKE ?))"); const s = `%${search}%`; binds.push(s, s, s); }
  if (["general", "r15", "r17"].includes(rating)) { where.push("rating=?"); binds.push(rating); }
  const order = sort === "likes" ? "like_count DESC, published_at DESC" : "published_at DESC, ts DESC";
  // 生成参数仅在 params_disclosed 时返回
  const rows = await env.DB.prepare(`SELECT id,ts,fmt,thumb_fmt,title,tags,rating,public,published_at,prompt_disclosed,params_disclosed,view_count,like_count,model,w,h,
    CASE WHEN params_disclosed=1 THEN steps END AS steps, CASE WHEN params_disclosed=1 THEN scale END AS scale,
    CASE WHEN params_disclosed=1 THEN sampler END AS sampler, CASE WHEN params_disclosed=1 THEN noise END AS noise
    FROM gallery WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, limit + 1, offset).all<any>();
  const items = rows.results || [], hasMore = items.length > limit; if (hasMore) items.pop();
  const out: any = { items, has_more: hasMore };
  // 总数只在第一页算（COUNT 要数遍全部公开作品），翻页时前端沿用第一页的总数
  if (offset === 0) out.total = Number((await env.DB.prepare(`SELECT COUNT(*) c FROM gallery WHERE ${where.join(" AND ")}`).bind(...binds).first<any>())?.c || 0);
  return out;
}
async function publicGalleryRoute(request: Request, env: Env, rest: string) {
  const visitor = String(request.headers.get("X-YesNAI-Visitor") || "").trim().slice(0, 128);
  if (request.method === "OPTIONS") return publicCors(new Response(null, { status: 204 }), request);
  if (request.method === "GET" && rest === "") {
    const u = new URL(request.url);
    // 列表本身对所有访客都一样，在边缘缓存 5 分钟（自定义域名下生效；workers.dev 上 Cache API 不工作就照常查库）。
    // 缓存键带版本号，发布 / 撤回 / 点赞会换版本，立刻可见；只有浏览数最多滞后 5 分钟。每位访客自己的点赞状态单独查一次。
    const ver = (await env.DB.prepare("SELECT v FROM runtime_kv WHERE k='pub_ver'").first<any>().catch(() => null))?.v || "0";
    const cacheKey = new Request(`${u.origin}/__cache/pub-list/${encodeURIComponent(ver)}?${[...u.searchParams].filter(([k]) => ["limit", "offset", "search", "rating", "sort"].includes(k)).sort().map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`);
    const cache = (globalThis as any).caches?.default as Cache | undefined;
    let page: any = null;
    try { const hit = await cache?.match(cacheKey); if (hit) page = await hit.json(); } catch { /* 缓存不可用 */ }
    if (!page) { page = await publicList(env, u); try { await cache?.put(cacheKey, new Response(JSON.stringify(page), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } })); } catch {} }
    const items = page.items;
    if (visitor && items.length) {
      // 一次查询取回本页点赞状态（旧实现每张图一条查询）
      const liked = await env.DB.prepare(`SELECT gallery_id FROM gallery_likes WHERE visitor_id=? AND gallery_id IN (${items.map(() => "?").join(",")})`).bind(visitor, ...items.map((x: any) => x.id)).all<any>();
      const set = new Set((liked.results || []).map((r: any) => r.gallery_id));
      for (const item of items) item.liked = set.has(item.id);
    }
    return json(page);
  }
  let m = rest.match(/^\/i\/([A-Za-z0-9-]+)$/);
  if (request.method === "GET" && m) {
    const id = m[1], row = await env.DB.prepare("SELECT fmt,thumb_fmt,public FROM gallery WHERE id=?").bind(id).first<any>();
    if (!row?.public) throw new HttpError("图片不存在", 404, "GALLERY_NOT_FOUND");
    let kind = new URL(request.url).searchParams.get("t") === "thumb" ? "thumb" : "img", obj = await env.R2.get(`${kind}/${id}`);
    if (!obj && kind === "thumb") { kind = "img"; obj = await env.R2.get(`img/${id}`); }   // 无缩略图回退原图（广场卡片原来会显示成空白）
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
    if (existing) { await env.DB.prepare("DELETE FROM gallery_likes WHERE visitor_id=? AND gallery_id=?").bind(visitor, id).run(); await env.DB.prepare("UPDATE gallery SET like_count=MAX(0,like_count-1) WHERE id=?").bind(id).run(); await bumpPubVersion(env); return json({ liked: false }); }
    const inserted = await env.DB.prepare("INSERT OR IGNORE INTO gallery_likes(visitor_id,gallery_id,created_at) VALUES(?,?,?)").bind(visitor, id, nowIso()).run();
    if ((inserted.meta.changes ?? 0) === 0) return json({ liked: true });
    await env.DB.prepare("UPDATE gallery SET like_count=like_count+1 WHERE id=?").bind(id).run();
    await bumpPubVersion(env);
    return json({ liked: true });
  }
  m = rest.match(/^\/([A-Za-z0-9-]+)$/); if (!m) throw new HttpError("未知公共画廊路由", 404, "ROUTE_NOT_FOUND");
  const id = m[1], row = await env.DB.prepare("SELECT * FROM gallery WHERE id=? AND public=1").bind(id).first<any>();
  if (!row) throw new HttpError("图片不存在", 404, "GALLERY_NOT_FOUND");
  if (request.method === "GET") { const out: any = { id: row.id, ts: row.ts, title: row.title, tags: row.tags, rating: row.rating, model: row.model, view_count: row.view_count, like_count: row.like_count, prompt_disclosed: row.prompt_disclosed, params_disclosed: row.params_disclosed }; if (row.prompt_disclosed) { out.prompt = row.prompt; out.prompt_base = row.prompt_base; out.neg = row.neg; } if (row.params_disclosed) {
      // 公开参数要给真正的生成参数（模型/尺寸/步数/CFG/采样器/种子），原来只返回 params_json 里的界面开关（v4struct、strength 之类）
      let extra: any = {}; try { extra = JSON.parse(row.params_json || "{}") || {}; } catch {}
      out.params = { model: row.model, size: row.w && row.h ? `${row.w}×${row.h}` : null, steps: row.steps, scale: row.scale, sampler: row.sampler, noise_schedule: row.noise, seed: row.seed, action: row.action,
        ...(extra.strength && row.action !== "generate" ? { strength: extra.strength } : {}), ...(extra.extra ? { extra: extra.extra } : {}) };
    }
    return json(out); }
  throw new HttpError("未知公共画廊路由", 404, "ROUTE_NOT_FOUND");
}

function securityHeaders(response: Response) { const h = new Headers(response.headers); h.set("X-Content-Type-Options", "nosniff"); h.set("Referrer-Policy", "same-origin"); h.set("X-Frame-Options", "DENY"); return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h }); }
// 访问密钥：设置 APP_ACCESS_KEY Secret 后，除 GET /api/session 外的所有 API 都需要 X-Access-Key。
// 同时它也是账号凭据加密密钥的来源——多账号模式下必须设置。
function isAdmin(request: Request, env: Env) {
  if (!env.APP_ACCESS_KEY) return true;   // 未设密钥 = 不设防（README 要求生产环境必须设置）
  return safeEqual(String(request.headers.get("X-Access-Key") || ""), env.APP_ACCESS_KEY);
}
function requireAccessKey(request: Request, env: Env) {
  if (!isAdmin(request, env)) throw new HttpError("需要访问密钥（在设置里填写 APP_ACCESS_KEY）", 401, "ACCESS_KEY_REQUIRED");
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
// 统一解析外部调用者身份：gateway_keys（新 yst- 密钥，带策略）→ api_tokens（旧 yst- 密钥）→ APP_ACCESS_KEY（管理员）。
// 旧密钥以负 id 参与用量统计，避免与 gateway_keys 同号 id 串用 daily_usage / use_count（旧实现的串号 bug）。
async function resolveGatewayKey(request: Request, env: Env, opts: { count?: boolean } = {}): Promise<GatewayKeyRow> {
  const auth = request.headers.get("Authorization") || "";
  const bearer = (auth.startsWith("Bearer ") ? auth.slice(7).trim() : "") || String(request.headers.get("X-Access-Key") || "").trim();
  if (!bearer) throw new HttpError("需要 API Key（Authorization: Bearer yst-... 或访问密钥）", 401, "GATEWAY_KEY_REQUIRED");
  if (env.APP_ACCESS_KEY && safeEqual(bearer, env.APP_ACCESS_KEY)) {
    return { id: 0, name: "admin", key: "", enabled: 1, mode: "restricted", policy_json: "{}", use_count: 0, last_used_at: null, created_at: nowIso(), updated_at: nowIso() };
  }
  let row: GatewayKeyRow | null = null;
  try { row = await env.DB.prepare("SELECT * FROM gateway_keys WHERE key=?").bind(bearer).first<GatewayKeyRow>(); }
  catch { throw new HttpError("Gateway 功能未初始化（请应用最新数据库迁移）", 500, "GATEWAY_TABLE_MISSING"); }
  let legacyId = 0;
  if (!row) {
    try {
      const legacy = await env.DB.prepare("SELECT id,name,key,enabled,use_count,last_used_at,created_at FROM api_tokens WHERE key=?").bind(bearer).first<any>();
      if (legacy) { legacyId = Number(legacy.id); row = { ...legacy, id: -legacyId, mode: "restricted", policy_json: "{}", updated_at: legacy.created_at } as GatewayKeyRow; }
    } catch { /* legacy table may be unavailable */ }
  }
  if (!row?.enabled) throw new HttpError("API Key 无效或已停用", 401, "GATEWAY_KEY_INVALID");
  if (opts.count !== false) {
    if (legacyId) await env.DB.prepare("UPDATE api_tokens SET use_count=use_count+1,last_used_at=? WHERE id=?").bind(nowIso(), legacyId).run().catch(() => {});
    else await env.DB.prepare("UPDATE gateway_keys SET use_count=use_count+1,last_used_at=?,updated_at=? WHERE id=?").bind(nowIso(), nowIso(), row.id).run().catch(() => {});
  }
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
// 生图 Token 失效时用托管密码重登并新建 Token。每账号 6 小时最多重建一次：
// 旧实现每遇到 401 就在上游新建一个 Token，上游账号下会堆积大量 yesnai-studio-xxxx（上游 Token 列表/删除接口未知，无法回收）。
const TOKEN_REBUILD_INTERVAL_MS = 6 * 3600_000;
async function rebuildTokenThrottled(env: Env, acc: AccountRow): Promise<string | null> {
  const k = `tok_rebuild:${acc.id}`;
  try {
    const last = await env.DB.prepare("SELECT v FROM runtime_kv WHERE k=?").bind(k).first<any>();
    if (last?.v && Date.now() - Date.parse(last.v) < TOKEN_REBUILD_INTERVAL_MS) return null;
    // 先占位再重建，并发请求不会同时各建一个
    const claimed = await env.DB.prepare(`INSERT INTO runtime_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v WHERE v=?`).bind(k, nowIso(), last?.v ?? "").run();
    if (!(claimed.meta.changes ?? 0)) return null;
  } catch { return null; }
  const fresh = await refreshJwt(env, acc).catch(() => null);
  if (!fresh) return null;
  const rebuilt = await provisionToken(env, (await getAccount(env, acc.id)) || acc).catch(() => null);
  if (!rebuilt) return null;
  await updateAccount(env, acc.id, { api_token_enc: await seal(env, rebuilt), last_message: `生图 Token 失效，已于 ${nowIso().slice(0, 16).replace("T", " ")} UTC 自动重建` });
  return rebuilt;
}
function applyFixedParameters(policy: any, body: any) {
  if (policy.parameter_mode !== "fixed" || !policy.fixed_parameters || typeof policy.fixed_parameters !== "object") return body;
  // 深拷贝后再覆盖固定参数，绝不改动原请求对象
  const cloned = structuredClone(body);
  const parameters = cloned && typeof cloned.parameters === "object" && !Array.isArray(cloned.parameters) ? cloned.parameters : (cloned.parameters = {});
  Object.assign(parameters, structuredClone(policy.fixed_parameters));
  return cloned;
}
// 网关准入：每日 Gems 上限检查 → 原子预占当日请求数 → 并发租约。返回 release() 供 finally 释放租约。
async function gatewayAdmit(env: Env, key: GatewayKeyRow, policy: any) {
  const today = new Date().toISOString().slice(0, 10);
  const dailyRequests = Number(policy.daily_requests || 0), dailyGems = Number(policy.daily_gems || 0);
  let leaseId = "";
  if (key.id) {
    if (dailyGems > 0) {
      const usage = await env.DB.prepare("SELECT gem_count FROM daily_usage WHERE gateway_key_id=? AND usage_date=?").bind(key.id, today).first<any>();
      if (Number(usage?.gem_count || 0) >= dailyGems) throw new HttpError("已达到每日 Gems 限制", 429, "GATEWAY_DAILY_GEMS_LIMIT");
    }
    const reserved = await env.DB.prepare(`INSERT INTO daily_usage(gateway_key_id,usage_date,request_count,gem_count,updated_at) VALUES(?,?,1,0,?)
      ON CONFLICT(gateway_key_id,usage_date) DO UPDATE SET request_count=request_count+1,updated_at=excluded.updated_at
      WHERE (? <= 0 OR request_count < ?) AND (? <= 0 OR gem_count < ?)`).bind(key.id, today, nowIso(), dailyRequests, dailyRequests, dailyGems, dailyGems).run();
    if (!(reserved.meta.changes ?? 0)) {
      const usage = await env.DB.prepare("SELECT request_count FROM daily_usage WHERE gateway_key_id=? AND usage_date=?").bind(key.id, today).first<any>();
      if (dailyRequests > 0 && Number(usage?.request_count || 0) >= dailyRequests) throw new HttpError("已达到每日请求数限制", 429, "GATEWAY_DAILY_REQUEST_LIMIT");
      throw new HttpError("已达到每日 Gems 限制", 429, "GATEWAY_DAILY_GEMS_LIMIT");
    }
    const maxConcurrent = Number(policy.max_concurrency || 0);
    if (maxConcurrent > 0) {
      leaseId = crypto.randomUUID();
      const leaseUntil = new Date(Date.now() + UPSTREAM_TIMEOUT_GENERATE_MS + 10000).toISOString();
      const claimed = await env.DB.prepare(`INSERT INTO concurrency_leases(lease_id,gateway_key_id,expires_at,created_at)
        SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM concurrency_leases WHERE gateway_key_id=? AND expires_at>?) < ?`).bind(leaseId, key.id, leaseUntil, nowIso(), key.id, nowIso(), maxConcurrent).run();
      if (!(claimed.meta.changes ?? 0)) throw new HttpError("当前并发已达限制", 429, "GATEWAY_CONCURRENCY_LIMIT");
    }
  }
  return {
    today,
    async recordCost(costGems: number | null) {
      if (key.id && costGems != null && costGems > 0) await env.DB.prepare("UPDATE daily_usage SET gem_count=gem_count+?,updated_at=? WHERE gateway_key_id=? AND usage_date=?").bind(costGems, nowIso(), key.id, today).run().catch(() => {});
    },
    async release() {
      if (leaseId) await env.DB.prepare("DELETE FROM concurrency_leases WHERE lease_id=? OR expires_at<?").bind(leaseId, nowIso()).run().catch(() => {});
    },
  };
}
async function logGatewayRequest(env: Env, row: { requestId: string; keyId: number; accountId: number | null; path: string; mode: string; model: string | null; status: number; ok: boolean; started: number; bytesIn: number; bytesOut?: number | null; cost?: number | null }) {
  const now = nowIso(), dur = Date.now() - row.started, ok = row.ok ? 1 : 0;
  const log = env.DB.prepare("INSERT INTO request_logs(request_id,gateway_key_id,account_id,path,mode,model,status_code,ok,duration_ms,bytes_in,bytes_out,cost_gems,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(row.requestId, row.keyId || null, row.accountId, row.path, row.mode, row.model, row.status, ok, dur, row.bytesIn, row.bytesOut ?? null, row.cost ?? null, now);
  // 同时累加按天汇总（迁移 0014），统计页只读汇总表；两条语句一次 batch 发出，只算 1 个子请求
  const roll = env.DB.prepare(`INSERT INTO stats_daily(date,model,account_id,requests,ok,gems,duration_ms) VALUES(?,?,?,1,?,?,?)
    ON CONFLICT(date,model,account_id) DO UPDATE SET requests=requests+1,ok=ok+excluded.ok,gems=gems+excluded.gems,duration_ms=duration_ms+excluded.duration_ms`)
    .bind(now.slice(0, 10), row.model || "", row.accountId || 0, ok, row.cost || 0, dur);
  await env.DB.batch([log, roll]).catch(() => log.run().catch(() => {}));   // 未迁移 0014 时退回只写日志
}
function costFromUpstream(data: any): number | null { const n = Number(data?.job?.cost_gems ?? data?.cost_gems); return Number.isFinite(n) ? n : null; }
// 免费计划每次调用只有 10ms CPU：生图响应是几 MB 的 base64，整段 JSON.parse 一次就要 4~5ms。
// 这里不解析，只在字节流里找 "cost_gems" 后面的数字。base64 里不会出现双引号，所以按 '"' 定位、命中极少。
const COST_KEY = new TextEncoder().encode('"cost_gems"');
function findCostGems(buf: Uint8Array, dec: TextDecoder): number | null {
  for (let i = buf.indexOf(0x22); i >= 0 && i + COST_KEY.length <= buf.length; i = buf.indexOf(0x22, i + 1)) {
    let k = 1; while (k < COST_KEY.length && buf[i + k] === COST_KEY[k]) k++;
    if (k < COST_KEY.length) continue;
    const m = /^\s*:\s*(-?\d+(?:\.\d+)?)\s*[,}\]]/.exec(dec.decode(buf.subarray(i + k, i + k + 48)));
    if (m) return Number(m[1]);
  }
  return null;
}
async function scanCostGems(stream: ReadableStream<Uint8Array> | null): Promise<number | null> {
  if (!stream) return null;
  const reader = stream.getReader(), dec = new TextDecoder();
  let tail: Uint8Array | null = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) return null;
      // 键名/数字可能被切在两个分块之间：只把接缝处前后 64 字节拼起来再找一次，不复制整个分块（实测 2.7MB 约 1ms，整段解析约 4ms）
      let found: number | null = null;
      if (tail) { const seam = new Uint8Array(tail.length + Math.min(64, value.length)); seam.set(tail); seam.set(value.subarray(0, 64), tail.length); found = findCostGems(seam, dec); }
      if (found == null) found = findCostGems(value, dec);
      if (found != null) { reader.cancel().catch(() => {}); return found; }
      // 保留最近 64 字节作为下一次的接缝（分块很小时要跨多个分块累积）
      if (value.length >= 64 || !tail) tail = value.slice(Math.max(0, value.length - 64));
      else { const t = new Uint8Array(tail.length + value.length); t.set(tail); t.set(value, tail.length); tail = t.slice(Math.max(0, t.length - 64)); }
    }
  } catch { return null; }
}

async function gatewayGenerate(request: Request, env: Env, upstreamPath: string, ctx?: ExecutionContext) {
  const key = await resolveGatewayKey(request, env);
  const started = Date.now(), requestId = crypto.randomUUID(), rawBody = await request.arrayBuffer();
  const mode = gatewayMode(key);
  const policy = gatewayPolicy(key);
  let body: any = null;
  let forwardedBody: ArrayBuffer | Uint8Array = rawBody.slice(0);   // passthrough：原样字节，不解码不重编码
  if (mode === "restricted") {
    try { body = JSON.parse(new TextDecoder().decode(rawBody)); } catch { throw new HttpError("请求 JSON 无效", 400, "INVALID_JSON"); }
    checkGatewayPolicy(key, body);
    const fixed = applyFixedParameters(policy, body);
    if (fixed !== body) forwardedBody = new TextEncoder().encode(JSON.stringify(fixed));
  }
  const requestModel = body?.model || body?.parameters?.model || null;
  const admit = await gatewayAdmit(env, key, policy);
  const candidates = await roundRobinPool(env);
  let lastStatus = 502, lastMessage = "", accountName = "", accountId: number | null = null, response: Response | null = null, attemptNoTotal = 0;
  try {
    if (!candidates.length) throw new HttpError("没有可用账号", 503, "NO_ACCOUNT");
    for (let i = 0; i < candidates.length; i++) {
      const acc = candidates[i]; accountId = acc.id; let token = await unseal(env, acc.api_token_enc).catch(() => ""); if (!token) continue;
      let retried401 = false, attemptNo = 0;
      response = null;
      while (true) {
        attemptNo++; attemptNoTotal++;
        try { response = await yesnaiFetch(env, upstreamPath, { method: "POST", headers: gatewayRequestHeaders(request, token), body: forwardedBody.slice(0) }, UPSTREAM_TIMEOUT_GENERATE_MS, acc); }
        catch (e: any) { lastMessage = String(e?.message || e); await env.DB.prepare("INSERT INTO request_attempts(request_id,gateway_key_id,account_id,attempt_no,error,created_at) VALUES(?,?,?,?,?,?)").bind(requestId, key.id, acc.id, attemptNo, lastMessage.slice(0, 300), nowIso()).run().catch(() => {}); break; }
        await env.DB.prepare("INSERT INTO request_attempts(request_id,gateway_key_id,account_id,attempt_no,status_code,created_at) VALUES(?,?,?,?,?,?)").bind(requestId, key.id, acc.id, attemptNo, response.status, nowIso()).run().catch(() => {});
        // Token 失效：用托管密码重登并重建生图 Token，同账号再试一次
        if (response.status === 401 && !retried401) { const rebuilt = await rebuildTokenThrottled(env, acc); if (rebuilt) { token = rebuilt; retried401 = true; continue; } }
        break;
      }
      if (!response) continue;
      if (response.ok) { accountName = accountPublic(acc).label; accountId = acc.id; break; }
      lastStatus = response.status; const clone = response.clone(); let data: any = {}; try { data = await clone.json(); } catch {} lastMessage = sanitizedMessage(data, `HTTP ${response.status}`);
      if (![401, 402, 429].includes(response.status) && response.status < 500) break;   // 参数类 4xx：换账号结果一样，直接透传
      response = null;
    }
    if (!response) throw new HttpError(`所有候选账号均失败（最后：HTTP ${lastStatus} ${lastMessage}）`, 502, "ALL_ACCOUNTS_FAILED");
    // 图片边下边转给调用方；扣费统计、请求日志放到响应发出后的后台任务里做（不再先把整个响应读进内存再解析）
    const ok = response.ok, status = response.status, bytesOut = Number(response.headers.get("Content-Length") || 0) || null;
    let body = response.body, tap: ReadableStream<Uint8Array> | null = null;
    if (ok && body) [body, tap] = body.tee();
    const finish = (async () => {
      const costGems = ok ? await scanCostGems(tap) : null;
      await admit.recordCost(costGems);
      await logGatewayRequest(env, { requestId, keyId: key.id, accountId, path: upstreamPath, mode, model: requestModel, status, ok, started, bytesIn: rawBody.byteLength, bytesOut, cost: costGems });
    })().catch(() => {});
    if (ctx) ctx.waitUntil(finish); else await finish;
    const out = gatewayForwardResponse(new Response(body, response), requestId);
    const h = new Headers(out.headers); if (accountName) h.set("X-Ynai-Account", encodeURIComponent(accountName)); h.set("X-Gateway-Attempts", String(attemptNoTotal));
    return new Response(out.body, { status: out.status, statusText: response.statusText, headers: h });
  } catch (e: any) {
    await logGatewayRequest(env, { requestId, keyId: key.id, accountId, path: upstreamPath, mode, model: requestModel, status: response?.status || (e instanceof HttpError ? e.status : 500), ok: false, started, bytesIn: rawBody.byteLength });
    if (e && typeof e === "object") { e.requestId = requestId; e.attempts = attemptNoTotal; }
    throw e;
  } finally { await admit.release(); }
}

// 走账号池的外部生图（/v1/chat/completions、GET /generate）：与 /v1/nai/generate-image 共用同一套密钥、策略、配额与日志
async function gatewayPoolGenerate(env: Env, key: GatewayKeyRow, naiBody: any, path: string) {
  const started = Date.now(), requestId = crypto.randomUUID();
  const mode = gatewayMode(key), policy = gatewayPolicy(key);
  if (mode === "restricted") { checkGatewayPolicy(key, naiBody); naiBody = applyFixedParameters(policy, naiBody); }
  const admit = await gatewayAdmit(env, key, policy);
  const bytesIn = JSON.stringify(naiBody).length;
  try {
    const { resp, account, accountId } = await generateViaPool(env, naiBody);
    if (!resp.ok) {
      await logGatewayRequest(env, { requestId, keyId: key.id, accountId, path, mode, model: naiBody.model, status: resp.status, ok: false, started, bytesIn });
      return { resp, data: null as any, account };
    }
    const { data } = await upstreamJson(resp);
    const cost = costFromUpstream(data);
    await admit.recordCost(cost);
    await logGatewayRequest(env, { requestId, keyId: key.id, accountId, path, mode, model: naiBody.model, status: resp.status, ok: true, started, bytesIn, cost });
    return { resp, data, account };
  } catch (e) {
    await logGatewayRequest(env, { requestId, keyId: key.id, accountId: null, path, mode, model: naiBody?.model || null, status: e instanceof HttpError ? e.status : 500, ok: false, started, bytesIn });
    throw e;
  } finally { await admit.release(); }
}

// /v1/balance 等管理员外部端点：Authorization: Bearer <APP_ACCESS_KEY> 或 X-Access-Key
function requireExternalKey(request: Request, env: Env) {
  if (!env.APP_ACCESS_KEY) throw new HttpError("外部 API 需要先设置 APP_ACCESS_KEY", 401, "ACCESS_KEY_REQUIRED");
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!safeEqual(bearer, env.APP_ACCESS_KEY) && !isAdmin(request, env)) throw new HttpError("统一密钥无效", 401, "ACCESS_KEY_REQUIRED");
}
// 共享生图内核：轮询选号 + 失败转移。返回上游响应与实际服务账号（参数 4xx 透传时账号为空）
async function generateViaPool(env: Env, naiBody: any): Promise<{ resp: Response; account: string; accountId: number | null }> {
  naiBody = normalizeNaiBody(naiBody);
  await ensureBootstrapped(env);
  const accounts = await listAccounts(env);   // 只查一次账号表，轮询直接复用
  const all = accounts.filter(a => a.enabled);
  if (!all.length) throw new HttpError("没有启用中的账号", 503, "NO_ACCOUNT");
  if (!all.some(a => a.api_token_enc)) throw new HttpError("账号池中没有配置生图 API Token 的账号", 503, "NO_TOKEN_ACCOUNT");
  // 轮询选号：候选序列按游标轮转，失败转移遍历整个池
  const pool = await roundRobinPool(env, accounts);
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
    if (resp.ok) return { resp, account: accountPublic(acc).label, accountId: acc.id };
    // 余额不足 / 限流 / Token 失效 / 上游 5xx：换下一个候选重试
    if ([401, 402, 429].includes(resp.status) || resp.status >= 500) {
      lastStatus = resp.status;
      const { data } = await upstreamJson(resp);
      lastMessage = sanitizedMessage(data, `HTTP ${resp.status}`);
      continue;
    }
    // 参数错误等 4xx：换账号结果一样，直接透传
    return { resp, account: "", accountId: acc.id };
  }
  if (!attempted) throw new HttpError("账号池中没有配置生图 API Token 的账号", 503, "NO_TOKEN_ACCOUNT");
  if (Date.now() - poolStarted >= GENERATE_POOL_BUDGET_MS) throw new HttpError("账号池生图请求超过总等待时间", 504, "GENERATE_POOL_TIMEOUT");
  throw new HttpError(`所有候选账号均失败（最后：HTTP ${lastStatus} ${lastMessage}）`, 502, "ALL_ACCOUNTS_FAILED");
}
/* ================= OpenAI 兼容辅助（chat/completions 与 GET /generate 使用） ================= */
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
async function promptApiRequest(env: Env, path: string, init: RequestInit = {}, timeoutMs = 60_000, override: any = {}) {
  const saved = await getPromptApiConfig(env);
  const config = { ...saved, ...(override?.base ? { base: promptApiBase(override.base) } : {}), ...(override?.key ? { key: String(override.key).trim() } : {}), ...(override?.model ? { model: String(override.model).trim() } : {}) };
  if (!config.base || !config.key || (path !== "/models" && !config.model)) throw new HttpError("尚未配置中文提示词 API", 503, "PROMPT_API_NOT_CONFIGURED");
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
// 允许用表单里尚未保存的 base/key 读取模型（首次配置时还没保存，旧实现只读已保存配置，必然报「尚未配置」）
async function promptApiModels(env: Env, override: any = {}) {
  const data = await promptApiRequest(env, "/models", {}, 15_000, override);
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
  // workerd 原生 Uint8Array.fromBase64 比 atob + 逐字节循环快一个数量级（2MB 图片约省 5ms CPU）
  const native = (Uint8Array as any).fromBase64;
  if (typeof native === "function") { try { return native(clean.trim()); } catch { /* 非标准填充等，退回旧路径 */ } }
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
  // Nai2API 兼容：token 可放 query（注意会进访问日志，优先用 Authorization 头）
  const token = url.searchParams.get("token");
  const authRequest = token ? new Request(request, { headers: new Headers({ ...Object.fromEntries(request.headers), Authorization: `Bearer ${token}` }) }) : request;
  const key = await resolveGatewayKey(authRequest, env);
  const { resp, data, account } = await gatewayPoolGenerate(env, key, queryToNai(url), "/generate");
  if (!resp.ok) return forward(resp);
  const first = Array.isArray(data?.images) ? data.images[0] : null;
  if (!first) throw new HttpError("上游未返回图片", 502, "NO_IMAGES");
  const h = new Headers({ "Content-Type": "image/png", "Cache-Control": "no-store" });
  if (account) h.set("X-Ynai-Account", encodeURIComponent(account));
  return new Response(decodeImageB64(first), { headers: h });
}
async function externalChatGenerate(request: Request, env: Env) {
  const key = await resolveGatewayKey(request, env);
  const body = await readJson<any>(request);
  const prompt = promptFromChat(body);
  if (!prompt) throw new HttpError("messages 中没有可用提示词", 400, "PROMPT_REQUIRED");
  const input = /[㐀-鿿]/.test(prompt) ? await convertChinesePrompt(env, prompt) : prompt;
  const size = SIZE_ALIAS[String(body?.size || "")] || String(body?.size || "832x1216");
  const nai = openaiToNai({ model: body?.model, prompt: input, size, n: body?.n, parameters: body?.parameters });
  const { resp, data, account } = await gatewayPoolGenerate(env, key, nai, "/v1/chat/completions");
  if (!resp.ok) return forward(resp);
  const images = Array.isArray(data?.images) ? data.images : [];
  if (!images.length) throw new HttpError("上游未返回图片", 502, "NO_IMAGES");
  const content = images.map((b64: string, i: number) => `![Generated Image ${i + 1}](data:image/png;base64,${b64})`).join("\n\n");
  return json({ id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: nai.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: input.length, completion_tokens: 0, total_tokens: input.length }, cost_gems: data?.job?.cost_gems ?? null }, 200, account ? { "X-Ynai-Account": encodeURIComponent(account) } : {});
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

// 定期清理：过期计数桶 / 并发租约，以及超过保留期的请求日志、重试记录、签到日志、每日用量。
// 每次 cron 每张表最多删 5000 行，存量很大时分多次慢慢删完，不会单次跑太久。
function clampInt(v: unknown, min: number, max: number, fallback: number) { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }
async function pruneData(env: Env) {
  const now = nowIso();
  const days = clampInt(env.LOG_RETENTION_DAYS, 1, 3650, 30);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const usageCutoff = new Date(Date.now() - Math.max(days, 90) * 86_400_000).toISOString().slice(0, 10);
  const jobs: [string, string][] = [
    ["DELETE FROM concurrency_leases WHERE expires_at<?", now],
    ["DELETE FROM request_attempts WHERE rowid IN (SELECT rowid FROM request_attempts WHERE created_at<? LIMIT 5000)", cutoff],
    ["DELETE FROM request_logs WHERE rowid IN (SELECT rowid FROM request_logs WHERE created_at<? LIMIT 5000)", cutoff],
    ["DELETE FROM autocheckin_logs WHERE rowid IN (SELECT rowid FROM autocheckin_logs WHERE attempted_at<? LIMIT 5000)", cutoff],
    ["DELETE FROM daily_usage WHERE usage_date<?", usageCutoff],
    ["DELETE FROM stats_daily WHERE date<?", usageCutoff],   // 汇总表很小，保留得比明细日志久（至少 90 天）
  ];
  for (const [sql, arg] of jobs) await env.DB.prepare(sql).bind(arg).run().catch(() => {});
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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
        const admin = isAdmin(request, env);
        response = json({ configured: Boolean(env.YESNAI_JWT) || accounts > 0, accounts: admin ? accounts : undefined,
          access_key_required: Boolean(env.APP_ACCESS_KEY), admin_authenticated: admin });
      }
      else if (path.startsWith("/api/")) {
        requireAccessKey(request, env);
        if (path === "/api/stats" && request.method === "GET") response = await statsRoute(request, env, "stats");
        else if (path === "/api/logs" && request.method === "GET") response = await statsRoute(request, env, "logs");
        else if (path.startsWith("/api/ai/") && request.method !== "DELETE") response = await imageToolRoute(request, env, path.slice("/api/ai/".length));
        else if (path === "/api/prompt/status" && request.method === "GET") response = json(await promptApiStatus(env));
        else if (path === "/api/prompt/config" && request.method === "GET") { const c = await getPromptApiConfig(env); response = json({ base: c.base, model: c.model, configured: Boolean(c.base && c.key && c.model), key_configured: Boolean(c.key) }); }
        else if (path === "/api/prompt/config" && request.method === "PUT") { requireOrigin(request, env); response = json(await savePromptApiConfig(env, await readJson<any>(request))); }
        else if (path === "/api/prompt/models" && request.method === "POST") { requireOrigin(request, env); response = json({ models: await promptApiModels(env, await readJson<any>(request).catch(() => ({}))) }); }
        else if (path === "/api/prompt/convert" && request.method === "POST") { requireOrigin(request, env); const body = await readJson<any>(request); response = json({ prompt: await convertChinesePrompt(env, body?.prompt, body?.model) }); }
        else if (path === "/api/prompt/artist-assist" && request.method === "POST") { requireOrigin(request, env); response = json(await artistAssist(env, await readJson<any>(request))); }
        else if (path === "/api/prompt/artist-optimize" && request.method === "POST") { requireOrigin(request, env); response = json({ artist: await artistOptimize(env, await readJson<any>(request)) }); }
        else if (path === "/api/autocheckin/settings" && request.method === "GET") response = json(await getConfig(env));
        else if (path === "/api/autocheckin/settings" && request.method === "PATCH") { requireOrigin(request, env); response = json(await saveConfig(env, await readJson<any>(request))); }
        else if (path === "/api/autocheckin/test" && request.method === "POST") {
          requireOrigin(request, env);
          const body = await readJson<any>(request).catch(() => ({}));
          const acc = body?.account_id ? await getAccount(env, Number(body.account_id)) : null;
          let nextOffset: number | null = null;
          if (acc) { const r: any = await performCheckin(env, acc, null, { manual: true }); delete r.jwt; response = json(r); }
          else if (!(await claimLease(env))) response = json({ ok: false, message: "签到正在进行中，请稍后再试" });
          else {
            // 测试按钮：对全部启用账号各强制执行一次（无到点槽也不跳过）；手动结果不污染 cron 重试计数
            try {
              const config = await getConfig(env);
              const results: any[] = [];
              // 分页：每个账号手动签到约 5 个子请求，一次最多 TEST_ALL_MAX 个，前端按 next_offset 继续
              const enabled = (await listAccounts(env)).filter(x => x.enabled), offset = Math.max(0, Number(body?.offset) || 0);
              const page = enabled.slice(offset, offset + TEST_ALL_MAX);
              nextOffset = offset + page.length < enabled.length ? offset + page.length : null;
              for (const a of page) {
                const slot = dueSlot(effectiveDayTimes(config, a), a) || nowSlot(config);
                const r: any = await performCheckin(env, a, slot, { manual: true }, config).catch((e: any) => ({ ok: false, account: accountPublic(a).label, message: String(e?.message || e).slice(0, 200) }));
                delete r.jwt; results.push(r);
              }
              response = json({ results, next_offset: nextOffset });
            } finally { await releaseLease(env); }
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
      else if (path === "/v1/chat/completions" && request.method === "POST") response = await externalChatGenerate(request, env);
      else if (path === "/v1/models" && request.method === "GET") {
        await resolveGatewayKey(request, env, { count: false });
        const resp = await yesnaiFetch(env, "/v1/models");
        if (!resp.ok) return securityHeaders(gatewayForwardResponse(resp));
        const { data } = await upstreamJson(resp);
        response = json(openaiModelList(data));
      }
      else if (path === "/v1/nai/generate-image" && request.method === "POST") { response = await gatewayGenerate(request, env, "/v1/nai/generate-image", ctx); }
      // OpenAI 兼容生图端点：Gateway Key 或管理员访问密钥，body {model,prompt,size,n,parameters?}
      else if (path === "/v1/images/generations" && request.method === "POST") response = await gatewayGenerate(request, env, "/v1/images/generations", ctx);
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
      // 4xx（鉴权、参数、限流）是正常业务结果，不刷错误日志；只记 5xx 与未预期异常
      if (!(e instanceof HttpError) || e.status >= 500) console.error("[worker]", e && e.stack || String(e));
      const failed = e instanceof HttpError ? error(e.message, e.status, e.code) : error("服务器内部错误", 500, "INTERNAL_ERROR");
      failed.headers.set("X-Gateway-Request-Id", e?.requestId || crypto.randomUUID());
      if (e?.attempts != null) failed.headers.set("X-Gateway-Attempts", String(e.attempts));
      return securityHeaders(failed);
    }
  },
  // cron 异常绝不能逃逸：一条坏数据打死调度的事不能再发生
  async scheduled(_event: ScheduledEvent, env: Env) {
    try { await runScheduled(env); }
    catch (e: any) { console.error("[scheduled]", e && e.stack || String(e)); }
    await pruneData(env).catch((e: any) => console.error("[prune]", e && e.stack || String(e)));
  },
};
