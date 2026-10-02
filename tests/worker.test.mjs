// 回归测试：配合 tests/run.sh 使用（wrangler dev 跑在 127.0.0.1:8787，假上游在 127.0.0.1:8790）
const B = "http://127.0.0.1:8787", U = "http://127.0.0.1:8790", KEY = "test-admin-key", ORI = { Origin: B };
let pass = 0, fail = 0;
const ok = (c, m, extra = "") => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m, extra); } };
async function req(method, path, { body, key, headers = {} } = {}) {
  const h = { ...headers }; if (body !== undefined) h["Content-Type"] = "application/json"; if (key) h["X-Access-Key"] = key;
  if (method !== "GET") Object.assign(h, ORI, headers);
  const r = await fetch(B + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { s: r.status, j, text, h: r.headers };
}
const up = async p => (await fetch(U + p)).json();
const gen = (over = {}, params = {}) => ({ model: "nai-diffusion-4-5-full", action: "generate", input: "1girl, smile", promptBase: "x", artist: "y", promptHash: "z",
  parameters: { width: 832, height: 1216, steps: 28, scale: 5, n_samples: 1, seed: 1, sampler: "k_euler_ancestral", noise_schedule: "karras", negative_prompt: "", ...params }, ...over });

let r;
console.log("[1] 无密钥 / 空库");
ok((await req("GET", "/api/yesnai/models")).s === 401, "models 无密钥 401");
ok((await req("POST", "/api/yesnai/generate", { body: gen() })).s === 401, "generate 无密钥 401");
ok((await req("GET", "/api/accounts", { key: "wrong" })).s === 401, "错误密钥 401");
r = await req("GET", "/api/yesnai/balance", { key: KEY });
ok(r.s === 409, "还没有账号时查余额返回 409（不是 500）", r.s);
ok((await req("GET", "/api/accounts", { key: KEY })).j.items.length === 0, "未配置 Secret 时不再插入空的「主账号（Secret）」");

console.log("[2] 账号 & 去重");
r = await req("POST", "/api/accounts", { key: KEY, body: { username: "alice", password: "p", api_token: "ynai-a" } });
ok(r.s === 200, "添加 alice", r.text);
r = await req("POST", "/api/accounts", { key: KEY, body: { username: "ALICE", password: "p2" } });
r = await req("GET", "/api/accounts", { key: KEY });
ok(r.j.items.length === 1 && r.j.items[0].has_api_token, "同名不区分大小写去重，保留 token", r.text);
const aliceId = r.j.items[0].id;
await req("PATCH", "/api/accounts/" + aliceId, { key: KEY, body: { label: "主账号（测试）" } });
r = await req("GET", "/api/prompt/status", { key: KEY });
ok(r.j && r.j.configured === false && "model" in r.j, "prompt/status 返回真实对象", r.text);

console.log("[3] 会话");
r = await req("GET", "/api/session");
ok(r.j.admin_authenticated === false && r.j.accounts === undefined, "session：无密钥时不暴露账号数", r.text);
r = await req("GET", "/api/session", { key: KEY });
ok(r.j.admin_authenticated === true && r.j.accounts === 1, "session：管理员视角");
let L, g;

console.log("[4] 网关密钥");
r = await req("POST", "/api/gateway/keys", { key: KEY, body: { name: "rp", allowed_models: ["nai-diffusion-4-5-full"], daily_requests: 2 } });
const gk = r.j.key; ok(/^yst-/.test(gk), "创建网关密钥");
const chat = (k, model = "nai-diffusion-4-5-full") => fetch(B + "/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + k, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "1girl, smile" }] }) });
let cr = await chat(gk); ok(cr.status === 200, "新网关密钥可用于 chat/completions（旧版 401）", await cr.clone().text().then(t => t.slice(0, 150)));
ok(decodeURIComponent(cr.headers.get("X-Ynai-Account") || "") === "主账号（测试）", "中文账号名响应头不再崩溃");
cr = await chat(gk, "nai-diffusion-5-full"); ok(cr.status === 403, "网关策略对 chat 生效（模型白名单）");
cr = await chat(gk); ok(cr.status === 200, "第 2 次");
cr = await chat(gk); ok(cr.status === 429, "daily_requests=2 对 chat 生效");
await up("/__reset");
let gr = await fetch(B + "/v1/nai/generate-image", { method: "POST", headers: { "X-Access-Key": KEY, "Content-Type": "application/json", Cookie: "a=b" }, body: JSON.stringify(gen()) });
ok(gr.status === 200, "管理员用 X-Access-Key 调网关（旧版 401）");
L = await up("/__log"); g = L.find(x => x.url === "/v1/nai/generate-image");
ok(g && !g.headers["x-access-key"] && !g.headers.cookie, "网关不再把访问密钥/Cookie 转发给上游", JSON.stringify(g?.headers));
r = await req("POST", "/api/tokens", { key: KEY, body: { name: "legacy" } });
const lk = r.j.key;
gr = await fetch(B + "/v1/nai/generate-image", { method: "POST", headers: { Authorization: "Bearer " + lk, "Content-Type": "application/json" }, body: JSON.stringify(gen()) });
ok(gr.status === 200, "旧 yst- 分发密钥仍可用");
r = await req("GET", "/api/tokens", { key: KEY }); const lrow = r.j.items.find(x => x.key === lk);
r = await req("GET", "/api/gateway/keys", { key: KEY }); const grow = r.j.items.find(x => x.key === gk);
ok(lrow.use_count === 1 && grow.use_count === 4, "旧密钥计数记在 api_tokens，不串到网关密钥", `legacy=${lrow.use_count} gw=${grow.use_count}`);

console.log("[5] 自动签到");
await req("PATCH", "/api/autocheckin/settings", { key: KEY, body: { weekday_times: ["00:00", "00:01"], weekend_times: ["00:00", "00:01"] } });
await up("/__reset");
for (let i = 0; i < 3; i++) await fetch(B + "/cdn-cgi/local/scheduled");
L = await up("/__log");
ok(L.filter(x => x.url === "/api/user/checkin").length === 1, "两个签到槽、连触发 3 次 cron 只签 1 次", L.map(x => x.url).join());
r = await req("POST", "/api/autocheckin/test", { key: KEY, body: {} });
ok(Array.isArray(r.j.results), "cron 跑完立刻手动测试不被租约挡住", r.text);
r = await req("POST", "/api/accounts/" + aliceId + "/test", { key: KEY });
ok(r.j.ok === true, "单账号手动测试在今天已签后仍可强制执行", r.text);

console.log("[6] 公共广场");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const mk = async (prompt, disclosed) => { const a = await req("POST", "/api/gallery", { key: KEY, body: { image: png, fmt: "png", meta: { prompt, steps: 28, scale: 5 } } }); await req("POST", `/api/gallery/${a.j.id}/publish`, { key: KEY, body: { title: "作品" + (disclosed ? "A" : "B"), promptDisclosed: disclosed, paramsDisclosed: disclosed } }); return a.j.id; };
await mk("hiddenword cat", false); await mk("openword dog", true);
let pg = await (await fetch(B + "/pub/gallery?search=hiddenword")).json();
ok(pg.items.length === 0, "未公开提示词搜不到", JSON.stringify(pg));
pg = await (await fetch(B + "/pub/gallery?search=openword")).json();
ok(pg.items.length === 1 && pg.items[0].steps === 28, "公开提示词可搜，公开参数可见");
pg = await (await fetch(B + "/pub/gallery", { headers: { "X-YesNAI-Visitor": "v1" } })).json();
const hid = pg.items.find(x => x.title === "作品B");
ok(hid && hid.steps == null && hid.scale == null && hid.liked === false, "未公开参数不返回；点赞状态批量查询正常", JSON.stringify(hid));
const shown = pg.items.find(x => x.title === "作品A");
const det = await (await fetch(B + "/pub/gallery/" + shown.id)).json();
ok(det.params && det.params.steps === 28 && det.params.scale === 5, "公开参数给出真实生成参数", JSON.stringify(det.params));
const th = await fetch(B + "/pub/gallery/i/" + shown.id + "?t=thumb");
ok(th.status === 200 && th.headers.get("content-type") === "image/png", "无缩略图时回退原图", th.status);

console.log("[7] 画廊二进制上传 / 批量清空");
const bin = Buffer.from(png, "base64");
const fd = new FormData();
fd.append("image", new Blob([bin], { type: "image/png" }), "image.png");
fd.append("thumb", new Blob([bin], { type: "image/png" }), "thumb.png");
fd.append("fmt", "png"); fd.append("thumb_fmt", "png");
fd.append("meta", JSON.stringify({ prompt: "multipart cat", steps: 28, params_json: "x".repeat(9000) }));
let mr = await fetch(B + "/api/gallery", { method: "POST", headers: { "X-Access-Key": KEY, Origin: B }, body: fd });
const mj = await mr.json();
ok(mr.status === 200 && mj.id, "multipart 上传成功", JSON.stringify(mj));
const back = Buffer.from(await (await fetch(B + "/api/gallery/i/" + mj.id, { headers: { "X-Access-Key": KEY } })).arrayBuffer());
ok(back.equals(bin), "取回的原图字节一致");
r = await req("GET", "/api/gallery?q=multipart", { key: KEY });
ok(r.j.items[0]?.params_json === "", "超长 params_json 不再存成截断的坏 JSON");
r = await req("POST", "/api/gallery/clear", { key: KEY, body: { confirm: true } });
ok(r.s === 200 && r.j.deleted === 4, "批量清空 R2（2 张 JSON 上传原图 + 1 张 multipart 原图与缩略图）", r.text);

console.log("[8] 生图 Token 失效自动重建（限频）");
await up("/__reset");
r = await req("POST", "/api/accounts", { key: KEY, body: { username: "bob", password: "p", api_token: "ynai-bad" } });
const bobId = r.j.id;
await req("PATCH", "/api/accounts/" + aliceId, { key: KEY, body: { enabled: false } });
const gw = () => fetch(B + "/v1/nai/generate-image", { method: "POST", headers: { "X-Access-Key": KEY, "Content-Type": "application/json" }, body: JSON.stringify(gen()) });
let tr = await gw();
L = await up("/__log");
ok(tr.status === 200 && L.filter(x => x.url === "/api/ynai/tokens").length === 1, "401 → 重登并重建 Token 后成功", tr.status);
await req("PATCH", "/api/accounts/" + bobId, { key: KEY, body: { api_token: "ynai-bad" } });
await up("/__reset");
tr = await gw();
L = await up("/__log");
ok(tr.status !== 200 && L.filter(x => x.url === "/api/ynai/tokens").length === 0, "6 小时内不再重复新建上游 Token", tr.status);
await req("PATCH", "/api/accounts/" + aliceId, { key: KEY, body: { enabled: true } });

console.log("[9] 自动轮询 / 图片工具路由");
await req("PATCH", "/api/accounts/" + bobId, { key: KEY, body: { api_token: "ynai-bob2" } });
await up("/__reset");
const autoGen = () => fetch(B + "/api/yesnai/generate", { method: "POST", headers: { "X-Access-Key": KEY, "X-Account-Id": "auto", Origin: B, "Content-Type": "application/json" }, body: JSON.stringify(gen()) });
await autoGen();
await fetch(B + "/api/yesnai/balance", { headers: { "X-Access-Key": KEY, "X-Account-Id": "auto" } });
await autoGen();
const used = (await up("/__log")).filter(x => x.url === "/v1/nai/generate-image").map(x => x.auth);
ok(used.length === 2 && used[0] !== used[1], "「自动」生图在两个账号间轮换（查余额不推进游标）", used.join());
r = await req("GET", "/api/ai/generate-image/suggest-tags?prompt=1girl&model=nai-diffusion-4-5-full", { key: KEY });
ok(r.s === 200 && r.j?.tags, "suggest-tags 路由可用", r.s);


console.log("[10] 免费计划：子请求分批 / 流式计费 / 汇总统计 / 分页不数总数");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let stats0 = (await req("GET", "/api/stats", { key: KEY })).j.today;
await up("/__cost/7"); await up("/__big/3");
gr = await fetch(B + "/v1/nai/generate-image", { method: "POST", headers: { "X-Access-Key": KEY, "Content-Type": "application/json" }, body: JSON.stringify(gen()) });
const bigBody = await gr.text();
ok(gr.status === 200 && bigBody.length > 3 * 1024 * 1024, "3MB 生图响应完整转发给调用方", bigBody.length);
await sleep(500);
let stats1 = (await req("GET", "/api/stats", { key: KEY })).j.today;
ok(stats1.requests === stats0.requests + 1 && stats1.gems - stats0.gems === 7, "大响应里流式扫出 cost_gems=7 并计入汇总统计", JSON.stringify([stats0, stats1]));
r = await req("GET", "/api/logs?limit=1", { key: KEY });
ok(r.j.items[0]?.cost_gems === 7 && r.j.has_more === true && r.j.total === undefined, "请求日志记录费用；默认不数总数、给 has_more", r.text.slice(0, 200));
ok((await req("GET", "/api/logs?limit=1&total=1", { key: KEY })).j.total > 1, "?total=1 时才给总数");
// 批量导入：一次最多 8 个，其余通过 remaining 返回
const many = Array.from({ length: 11 }, (_, i) => ({ username: "bulk" + i, password: "p" }));
r = await req("POST", "/api/accounts/batch", { key: KEY, body: { items: many } });
ok(r.j.results.length === 8 && r.j.remaining.length === 3 && r.j.added === 8, "批量导入单次处理 8 个、剩余 3 个返回", r.text.slice(0, 120));
r = await req("POST", "/api/accounts/batch", { key: KEY, body: { items: r.j.remaining } });
ok(r.j.added === 3 && r.j.remaining.length === 0, "续传剩余 3 个");
// 全部测试：分页
let pages = 0, tested = 0, off = 0;
do { r = await req("POST", "/api/autocheckin/test", { key: KEY, body: { offset: off } }); pages++; tested += r.j.results.length; off = r.j.next_offset; } while (off != null && pages < 10);
const enabledCount = (await req("GET", "/api/accounts", { key: KEY })).j.items.filter(x => x.enabled).length;
ok(pages === Math.ceil(enabledCount / 6) && tested === enabledCount, `全部测试按 6 个一页分 ${pages} 次完成（${enabledCount} 个账号）`, tested);
ok(!JSON.stringify(r.j).includes("jwt-"), "测试结果不含 JWT");
// 画廊：总数只在第一页
await mk("page one", true); await mk("page two", true);
r = await req("GET", "/api/gallery?limit=1&offset=0", { key: KEY });
ok(r.j.total >= 2 && r.j.has_more === true && r.j.storage_bytes > 0, "画廊第一页给总数与占用空间", r.text.slice(0, 160));
r = await req("GET", "/api/gallery?limit=1&offset=1", { key: KEY });
ok(r.j.total === undefined && r.j.items.length === 1, "翻页不再数总数");
pg = await (await fetch(B + "/pub/gallery?limit=1&offset=1&sort=likes")).json();
ok(pg.total === undefined && pg.items.length === 1 && typeof pg.has_more === "boolean", "广场翻页不数总数（最热排序走索引）", JSON.stringify(pg).slice(0, 120));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
