#!/usr/bin/env node
// 星彩绘图台 · 一键部署到 Cloudflare
// 用法：Windows 双击 deploy.bat；macOS / Linux 运行 ./deploy.sh；或直接 node tools/deploy.mjs
//   node tools/deploy.mjs          首次运行按提示选择 / 新建资源，之后回车即可更新部署
//   node tools/deploy.mjs --yes    用上次保存的配置直接部署，不再询问（适合以后的日常更新）
//   node tools/deploy.mjs --reconfigure   重新选择 Worker / 数据库 / 存储桶 / 域名
// 做的事：登录检查 → 选择或新建 D1 与 R2 → 生成部署配置 → 备份数据库 → 执行迁移 → 首次自动生成访问密钥 → 发布 → 自检
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(ROOT, ".deploy");
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const KEY_FILE = path.join(STATE_DIR, "APP_ACCESS_KEY.txt");
const GENERATED = "wrangler.deploy.jsonc";   // 放在仓库根目录，main / assets / migrations 的相对路径才能对上
const ARGS = new Set(process.argv.slice(2));
const AUTO = ARGS.has("--yes") || ARGS.has("-y");
const IS_WIN = process.platform === "win32";

const c = { b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` };
const step = (n, t) => console.log(`\n${c.b(`[${n}]`)} ${c.b(t)}`);
const info = t => console.log("    " + t);
const warn = t => console.log("    " + c.y("⚠ " + t));
const fail = t => { console.log("\n" + c.r("✗ " + t)); process.exit(1); };

// 自己排队读行：readline.question 在输入是管道 / 粘贴多行时会丢掉提前到达的行；输入结束时一律按默认值处理
let rl = null; const lines = [], waiters = []; let eof = false;
function io() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", l => (waiters.length ? waiters.shift()(l) : lines.push(l)));
    rl.on("close", () => { eof = true; while (waiters.length) waiters.shift()(null); });
  }
  return rl;
}
async function readLine(prompt) {
  io(); process.stdout.write(prompt);
  const l = lines.length ? lines.shift() : eof ? null : await new Promise(r => waiters.push(r));
  if (!process.stdin.isTTY) process.stdout.write((l ?? "") + "\n");   // 管道输入时回显，日志才看得懂
  return l ?? "";
}
async function ask(q, def = "") {
  if (AUTO) return def;
  const a = (await readLine(`    ${q}${def ? c.d(`（回车 = ${def}）`) : ""}：`)).trim();
  return a || def;
}
async function confirm(q, def = true) {
  if (AUTO) return def;
  const a = (await readLine(`    ${q} ${c.d(def ? "[Y/n]" : "[y/N]")}：`)).trim().toLowerCase();
  return a ? a.startsWith("y") || a === "是" : def;
}
async function choose(title, items, defIndex = 0) {
  info(title);
  items.forEach((it, i) => info(`  ${c.b(String(i + 1))}. ${it}`));
  while (true) {
    const a = await ask("输入序号", String(defIndex + 1));
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
    warn("请输入列表里的序号");
    if (eof) fail("输入已结束");
  }
}

/* ---------- wrangler 调用 ---------- */
let WR = null;   // 实际使用的 wrangler 命令
const ENV = { ...process.env, WRANGLER_SEND_METRICS: "false" };
const quote = a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function run(args, { capture = true, extraEnv = {}, input } = {}) {
  const cmd = [WR, ...args.map(quote)].join(" ");
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, env: { ...ENV, ...extraEnv }, encoding: "utf8", stdio: capture ? ["pipe", "pipe", "pipe"] : "inherit", input, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout || "", err: r.stderr || "", all: (r.stdout || "") + (r.stderr || "") };
}
function findWrangler() {
  for (const cand of [path.join(ROOT, "node_modules", ".bin", IS_WIN ? "wrangler.cmd" : "wrangler"), "wrangler", "npx --yes wrangler@4"]) {
    if (cand.includes(path.sep) && !fs.existsSync(cand)) continue;
    WR = cand.includes(" ") && fs.existsSync(cand) ? `"${cand}"` : cand;
    const r = run(["--version"]);
    const v = (r.out.match(/(\d+)\.(\d+)\.(\d+)/) || [])[0];
    if (r.code === 0 && v) return v;
  }
  return null;
}
const jsonFrom = (text, open = "[") => {
  const close = open === "[" ? "]" : "}";
  const i = text.indexOf(open), j = text.lastIndexOf(close);
  if (i < 0 || j < i) return null;
  try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; }
};
const stripJsonc = s => s.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || "").replace(/,(\s*[}\]])/g, "$1");

/* ---------- 主流程 ---------- */
async function main() {
  console.log(c.b("\n✦ 星彩绘图台 · 一键部署到 Cloudflare\n"));
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) fail(`Node.js 版本太旧（${process.versions.node}），请到 https://nodejs.org 安装 LTS 版本后重试`);

  step(1, "检查 wrangler");
  const ver = findWrangler();
  if (!ver) fail("找不到 wrangler，也无法通过 npx 下载。请先运行：npm install -g wrangler");
  const [wmaj] = ver.split(".").map(Number);
  if (wmaj < 4) warn(`wrangler 版本较旧（${ver}），建议 npm install -g wrangler 升级到 4.x`);
  info(`wrangler ${ver}  ${c.d(WR)}`);

  step(2, "检查 Cloudflare 登录");
  let who = jsonFrom(run(["whoami", "--json"]).out, "{");
  if (!who?.loggedIn) {
    info("还没登录，接下来会打开浏览器，请在页面上点「Allow」授权…");
    if (run(["login"], { capture: false }).code !== 0) fail("登录没有完成，请重新运行");
    who = jsonFrom(run(["whoami", "--json"]).out, "{");
    if (!who?.loggedIn) fail("登录后仍无法读取账号信息，请重新运行");
  }
  info(`已登录：${who.email || who.authType || "Cloudflare"}`);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  let cfg = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) : null;
  const accounts = Array.isArray(who.accounts) ? who.accounts : [];
  if (!cfg?.accountId || !accounts.some(a => a.id === cfg.accountId)) {
    if (!accounts.length) fail("这个登录下没有可用的 Cloudflare 账号");
    const idx = accounts.length === 1 ? 0 : await choose("你的登录下有多个 Cloudflare 账号，部署到哪一个？", accounts.map(a => `${a.name}  ${c.d(a.id)}`));
    cfg = { ...(cfg || {}), accountId: accounts[idx].id, accountName: accounts[idx].name };
  }
  ENV.CLOUDFLARE_ACCOUNT_ID = cfg.accountId;
  info(`账号：${cfg.accountName || cfg.accountId}`);

  const firstTime = !cfg.worker || ARGS.has("--reconfigure");
  if (!firstTime && !AUTO) {
    step(3, "上次的部署配置");
    showConfig(cfg);
    if (await confirm("要修改配置吗？（直接回车 = 不改，按上次配置更新部署）", false)) Object.assign(cfg, await configure(cfg));
  } else if (firstTime) {
    step(3, "部署配置（只需选一次，之后会记住）");
    if (AUTO) fail("还没有部署配置，请先不带 --yes 运行一次");
    Object.assign(cfg, await configure(cfg));
  } else step(3, "使用上次的部署配置"), showConfig(cfg);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));

  step(4, "准备数据库与存储桶");
  const dbs = listD1();
  let db = dbs.find(d => d.name === cfg.d1Name);
  let dbIsNew = false;
  if (!db) {
    info(`创建 D1 数据库 ${cfg.d1Name} …`);
    const r = run(["d1", "create", cfg.d1Name]);
    if (r.code !== 0 && !/already exists/i.test(r.all)) fail("创建 D1 数据库失败：\n" + r.all.slice(-1500));
    db = listD1().find(d => d.name === cfg.d1Name);
    if (!db) fail("数据库创建后没有找到，请稍后重试");
    dbIsNew = true;
  }
  cfg.d1Id = db.uuid || db.id || db.database_id;
  info(`D1：${cfg.d1Name}  ${c.d(cfg.d1Id)}${dbIsNew ? c.g("（新建）") : ""}`);
  if (!listR2().includes(cfg.r2Bucket)) {
    info(`创建 R2 存储桶 ${cfg.r2Bucket} …`);
    const r = run(["r2", "bucket", "create", cfg.r2Bucket]);
    if (r.code !== 0 && !/already (exists|owned)/i.test(r.all)) {
      if (/enable R2|R2 is not enabled|10042/i.test(r.all)) fail("你的账号还没开通 R2：请在 Cloudflare 后台左侧「R2 对象存储」里点一次「开始使用」（免费额度无需付费），然后重新运行");
      fail("创建 R2 存储桶失败：\n" + r.all.slice(-1500));
    }
    info(c.g("已创建"));
  } else info(`R2：${cfg.r2Bucket}`);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));

  step(5, "生成部署配置");
  writeGeneratedConfig(cfg);
  info(`${GENERATED} ${c.d("（由脚本生成，已在 .gitignore 中，不影响仓库里的 wrangler.jsonc）")}`);

  if (!dbIsNew) {
    step(6, "备份线上数据库");
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    const out = path.join(".deploy", "backups", `${cfg.d1Name}-${stamp}.sql`);
    fs.mkdirSync(path.join(ROOT, ".deploy", "backups"), { recursive: true });
    const r = run(["d1", "export", cfg.d1Name, "--remote", "--output", out, "-c", GENERATED]);
    if (r.code === 0 && fs.existsSync(path.join(ROOT, out))) info(c.g("已备份到 " + out));
    else {
      warn("备份失败：" + (r.all.split("\n").filter(Boolean).slice(-3).join(" ") || "未知原因"));
      if (!(await confirm("不备份继续部署吗？", false))) fail("已取消。可以稍后重试");
    }
  } else step(6, "新数据库，无需备份");

  step(7, "更新数据库结构（迁移）");
  const mig = run(["d1", "migrations", "apply", cfg.d1Name, "--remote", "-c", GENERATED], { extraEnv: { CI: "true" } });
  if (mig.code !== 0) {
    console.log(c.d(mig.all.split("\n").slice(-25).join("\n")));
    if (/duplicate column|already exists/i.test(mig.all))
      fail("迁移失败：这个数据库的结构和迁移记录对不上（常见于以前用别的版本建的库）。\n  数据已经备份在 .deploy/backups。可以新建一个数据库重新部署（node tools/deploy.mjs --reconfigure 选「新建」），\n  或把上面的报错发给维护者处理。");
    fail("迁移失败，详见上面的输出");
  }
  const applied = (mig.all.match(/\d{4}_[\w-]+\.sql/g) || []);
  info(applied.length ? c.g(`已执行 ${new Set(applied).size} 个迁移`) : "数据库已是最新");

  step(8, "访问密钥（APP_ACCESS_KEY）");
  const secrets = listSecrets(cfg.worker);
  let newKey = null;
  if (secrets.includes("APP_ACCESS_KEY")) info("线上已设置，保持不变" + (fs.existsSync(KEY_FILE) ? c.d(`（本机记录：.deploy/APP_ACCESS_KEY.txt）`) : ""));
  else {
    newKey = crypto.randomBytes(18).toString("base64url");
    const own = await ask("还没有访问密钥。直接回车自动生成一个，或输入你想用的密钥", "");
    if (own) newKey = own;
    fs.writeFileSync(KEY_FILE, newKey + "\n");
    info(c.g("已生成，并保存在 .deploy/APP_ACCESS_KEY.txt"));
  }

  step(9, "发布");
  const deployArgs = ["deploy", "-c", GENERATED];
  let secretsFile = null;
  if (newKey) {
    secretsFile = path.join(STATE_DIR, `secrets-${process.pid}.json`);
    fs.writeFileSync(secretsFile, JSON.stringify({ APP_ACCESS_KEY: newKey }));
    deployArgs.push("--secrets-file", path.relative(ROOT, secretsFile));   // 密钥随版本一起上传，不会出现"已上线但还没设密钥"的空窗
  }
  if (cfg.domain) deployArgs.push("--domain", cfg.domain);
  const dep = run(deployArgs);
  if (secretsFile) fs.rmSync(secretsFile, { force: true });
  console.log(c.d(dep.all.split("\n").filter(l => /Uploaded|Deployed|https?:\/\/|Current Version|Total Upload|error|✘/i.test(l)).slice(-12).map(l => "    " + l.trim()).join("\n")));
  if (dep.code !== 0) {
    if (/already (in use|has externally managed|associated)|custom domain/i.test(dep.all) && cfg.domain)
      fail(`域名 ${cfg.domain} 发布失败：它可能已绑定在另一个 Worker 上。请在 Cloudflare 后台「Workers 和 Pages」里把旧 Worker 的这个自定义域名删掉，或把配置里的 Worker 名改成旧 Worker 的名字（node tools/deploy.mjs --reconfigure）`);
    fail("发布失败，详见上面的输出");
  }
  const urls = [...new Set(dep.all.match(/https:\/\/[\w.-]+\.workers\.dev/g) || [])];
  const site = cfg.domain ? `https://${cfg.domain}` : urls[0];
  const checkSite = process.env.YESNAI_DEPLOY_CHECK_URL || site;   // 仅用于本地测试时把自检指向别的地址

  step(10, "上线自检");
  const key = newKey || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, "utf8").trim() : "");
  await selfCheck(checkSite, key);

  console.log("\n" + c.g(c.b("✓ 部署完成")));
  if (site) info(`网址：${c.b(site)}${cfg.domain && urls[0] ? c.d(`  （也可用 ${urls[0]}）`) : ""}`);
  if (newKey) {
    info(`访问密钥：${c.b(newKey)}`);
    info(c.d("已保存在 .deploy/APP_ACCESS_KEY.txt。打开网址 → 右上角「设置」→ 填入这个密钥，然后添加账号即可开始使用。"));
  }
  info(c.d("以后更新代码：再双击一次 deploy.bat（或运行 node tools/deploy.mjs --yes）。"));
}

/* ---------- 交互配置 ---------- */
function showConfig(cfg) {
  info(`Worker：${cfg.worker}`);
  info(`D1 数据库：${cfg.d1Name}`);
  info(`R2 存储桶：${cfg.r2Bucket}`);
  info(`自定义域名：${cfg.domain || c.d("（无，用 workers.dev 地址）")}`);
  info(`上游站点：${cfg.upstream}`);
}
async function configure(cfg) {
  const out = {};
  while (true) {
    out.worker = (await ask("Worker 名称（已有线上 Worker 就填它的名字，会原地更新）", cfg.worker || "yesnai-studio")).toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(out.worker)) break;
    warn("Worker 名称只能用小写字母、数字和 -");
    if (eof) fail("Worker 名称不合法");
  }
  const dbs = listD1();
  // 已有线上 Worker：读它当前绑定的数据库 / 存储桶 / 上游，直接作为默认选项，避免一路回车选成「新建」导致数据"消失"
  const live = detectLive(out.worker);
  if (live.exists) {
    const dName = dbs.find(d => d.uuid === live.d1Id)?.name;
    info(c.g(`检测到线上已有 Worker「${out.worker}」`) + (dName || live.r2 ? c.d(`，正在使用：${[dName && "数据库 " + dName, live.r2 && "存储桶 " + live.r2].filter(Boolean).join("、")}`) : ""));
    if (!dName && !live.r2) warn("没读到它当前绑定的数据库，请务必选它原来用的那个，否则网页里的账号和画廊会看不到");
  }
  const preferDb = dbs.find(d => d.uuid === live.d1Id)?.name || cfg.d1Name || (live.exists ? dbs[0]?.name : out.worker);
  const dbItems = [...dbs.map(d => `${d.name}  ${c.d(`${d.num_tables ?? "?"} 张表 · 建于 ${String(d.created_at || "").slice(0, 10)}`)}${d.uuid === live.d1Id ? c.g("  ← 线上正在用") : ""}`), c.g("新建一个数据库")];
  const dbDef = dbs.findIndex(d => d.name === preferDb);
  const di = await choose("选择 D1 数据库（已有线上数据就选原来那个）：", dbItems, dbDef >= 0 ? dbDef : dbs.length);
  if (di < dbs.length) out.d1Name = dbs[di].name;
  else {
    while (true) {
      out.d1Name = await ask("新数据库名称", dbs.some(d => d.name === out.worker) ? `${out.worker}-db` : out.worker);
      if (/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(out.d1Name) && !dbs.some(d => d.name === out.d1Name)) break;
      warn(dbs.some(d => d.name === out.d1Name) ? "这个名字已存在，请换一个或回到上一步直接选它" : "名称只能用字母、数字、- 和 _");
      if (eof) fail("数据库名称不合法");
    }
  }
  const buckets = listR2();
  const bItems = [...buckets.map(b => b + (b === live.r2 ? c.g("  ← 线上正在用") : "")), c.g("新建一个存储桶")];
  const bDefName = live.r2 || cfg.r2Bucket || "yesnai-gallery";
  const bi = await choose("选择 R2 存储桶（存画廊图片）：", bItems, buckets.includes(bDefName) ? buckets.indexOf(bDefName) : buckets.length);
  if (bi < buckets.length) out.r2Bucket = buckets[bi];
  else {
    while (true) {
      out.r2Bucket = await ask("新存储桶名称（3-63 位小写字母、数字、-）", buckets.includes(bDefName) ? `${out.worker}-gallery` : bDefName);
      if (/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(out.r2Bucket) && !buckets.includes(out.r2Bucket)) break;
      warn(buckets.includes(out.r2Bucket) ? "这个名字已存在，请换一个" : "名称不合法");
      if (AUTO || eof) fail("存储桶名称不合法");
    }
  }
  while (true) {
    out.domain = (await ask(cfg.domain ? "自定义域名（输入 - 表示不用自定义域名）" : "自定义域名（可选，例如 yesnai.example.com，需已托管在这个 Cloudflare 账号；不用就直接回车）", cfg.domain || "")).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (out.domain === "-") out.domain = "";
    if (!out.domain || /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(out.domain)) break;
    warn("域名格式不对，例如 yesnai.example.com");
    if (eof) fail("域名格式不对");
  }
  while (true) {
    out.upstream = (await ask("上游站点", cfg.upstream || live.upstream || "https://nai.rinko.ai")).replace(/\/+$/, "");
    if (/^https?:\/\/[^\s/]+$/.test(out.upstream)) break;
    warn("上游站点要写完整地址，例如 https://nai.rinko.ai");
    if (eof) fail("上游站点格式不对");
  }
  return out;
}

/* ---------- 资源查询 ---------- */
function listD1() {
  const r = run(["d1", "list", "--json"]);
  const list = jsonFrom(r.out, "[");
  if (!Array.isArray(list)) fail("读取 D1 数据库列表失败：\n" + r.all.slice(-1200));
  return list;
}
function listR2() {
  const r = run(["r2", "bucket", "list"]);
  if (r.code !== 0) {
    if (/enable R2|not enabled|10042/i.test(r.all)) fail("你的账号还没开通 R2：请在 Cloudflare 后台左侧「R2 对象存储」里点一次「开始使用」（免费额度无需付费），然后重新运行");
    fail("读取 R2 存储桶列表失败：\n" + r.all.slice(-1200));
  }
  return [...r.out.replace(/\x1b\[[0-9;]*m/g, "").matchAll(/^\s*name:\s+(\S+)/gm)].map(m => m[1]);
}
// 读线上 Worker 最新版本的绑定（D1 id、R2 桶名、YESNAI_BASE），读不到就当没有
function detectLive(worker) {
  const lv = run(["versions", "list", "--name", worker, "--json"]);
  const versions = jsonFrom(lv.out, "[");
  if (lv.code !== 0 || !Array.isArray(versions) || !versions.length) return { exists: false };
  const latest = versions.slice().sort((x, y) => String(y.metadata?.created_on || y.created_on || "").localeCompare(String(x.metadata?.created_on || x.created_on || "")))[0];
  const vv = jsonFrom(run(["versions", "view", latest.id, "--name", worker, "--json"]).out, "{");
  const b = vv?.resources?.bindings || [];
  return { exists: true, d1Id: b.find(x => x.type === "d1")?.id || b.find(x => x.type === "d1")?.database_id, r2: b.find(x => x.type === "r2_bucket")?.bucket_name, upstream: b.find(x => x.name === "YESNAI_BASE")?.text, bases: b.find(x => x.name === "YESNAI_BASES")?.text };
}
function listSecrets(worker) {
  const r = run(["secret", "list", "--name", worker, "--format", "json"]);
  const list = jsonFrom(r.out, "[");
  return Array.isArray(list) ? list.map(s => s.name) : [];   // Worker 还不存在时为空
}
function writeGeneratedConfig(cfg) {
  const base = JSON.parse(stripJsonc(fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8")));
  base.name = cfg.worker;
  base.d1_databases = [{ ...(base.d1_databases?.[0] || {}), binding: "DB", database_name: cfg.d1Name, database_id: cfg.d1Id, migrations_dir: "migrations" }];
  base.r2_buckets = [{ ...(base.r2_buckets?.[0] || {}), binding: "R2", bucket_name: cfg.r2Bucket }];
  base.vars = { ...(base.vars || {}), YESNAI_BASE: cfg.upstream };
  // 出口节点池（YESNAI_BASES）若是在 Cloudflare 后台设置的，wrangler.jsonc 里没有，部署时沿用线上的值，免得一更新就被清掉
  if (!base.vars.YESNAI_BASES) { const live = detectLive(cfg.worker); if (live.bases) base.vars.YESNAI_BASES = live.bases; }
  delete base.routes;
  fs.writeFileSync(path.join(ROOT, GENERATED), "// 由 tools/deploy.mjs 生成，请勿手改；改配置请运行 node tools/deploy.mjs --reconfigure\n" + JSON.stringify(base, null, 2) + "\n");
}
async function selfCheck(site, key) {
  if (!site) return warn("没拿到网址，跳过自检");
  let s = null;
  for (let i = 0; i < 6 && !s; i++) {
    try { const r = await fetch(site + "/api/session", { signal: AbortSignal.timeout(10000) }); if (r.ok) s = await r.json(); } catch {}
    if (!s) await new Promise(r => setTimeout(r, 3000));   // 新域名 / 新 Worker 生效可能要几秒
  }
  if (!s) return warn(`暂时访问不到 ${site}（新域名生效可能需要一两分钟；*.workers.dev 在部分网络需代理）`);
  info(c.g("网站已响应") + c.d(`  · 访问密钥${s.access_key_required ? "已启用" : c.y("未启用")}`));
  if (!key) return;
  try {
    const r = await fetch(site + "/api/accounts", { headers: { "X-Access-Key": key }, signal: AbortSignal.timeout(10000) });
    if (r.status === 401) return warn("本机记录的访问密钥和线上不一致（线上的密钥以线上为准）");
    const j = await r.json();
    const items = j.items || [];
    info(`账号池：${items.length} 个账号`);
    // 旧版本在没配 Secret 时会插入一个没有任何凭据的「主账号（Secret）」，会让默认生图 / 签到失败
    const junk = items.filter(a => a.username === "secret" && !a.has_jwt && !a.has_password && !a.has_api_token);
    for (const a of junk) {
      if (await confirm(`发现旧版本留下的空账号「${a.label}」（没有任何凭据，会导致默认生图失败），删除它吗？`, true)) {
        const d = await fetch(`${site}/api/accounts/${a.id}`, { method: "DELETE", headers: { "X-Access-Key": key } });
        info(d.ok ? c.g("已删除") : c.y("删除失败，可在网页设置里手动删除"));
      }
    }
  } catch { warn("账号池检查失败（不影响使用）"); }
}

main().catch(e => fail(e?.stack || String(e))).finally(() => rl?.close());
