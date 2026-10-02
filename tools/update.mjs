#!/usr/bin/env node
// 星彩绘图台 · 一键更新：把原作者 GitHub 上的新版本合并进本地（保留本地的修改），然后部署
// 用法：Windows 双击 update.bat；macOS / Linux 运行 ./update.sh；或 node tools/update.mjs
//   node tools/update.mjs             拉取 → 合并 → 询问是否立即部署
//   node tools/update.mjs --yes       全程不提问（合并成功就直接部署）
//   node tools/update.mjs --rollback  撤销最近一次更新（回到更新前的代码并重新部署）
// 安全保证：合并前自动打一个备份标签；合并有冲突时自动放弃合并，代码和线上都保持原样。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_URL = process.env.YESNAI_UPSTREAM_URL || "https://github.com/houssetkrier-collab/star-canvas.git";
const UPSTREAM_MATCH = process.env.YESNAI_UPSTREAM_URL ? null : /houssetkrier-collab\/star-canvas(\.git)?\/?$/i;
const ARGS = new Set(process.argv.slice(2));
const AUTO = ARGS.has("--yes") || ARGS.has("-y");

const c = { b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` };
const step = (n, t) => console.log(`\n${c.b(`[${n}]`)} ${c.b(t)}`);
const info = t => console.log("    " + t);
const warn = t => console.log("    " + c.y("⚠ " + t));
const fail = (t, code = 1) => { console.log("\n" + c.r("✗ " + t)); process.exit(code); };

let rl = null; const lines = [], waiters = []; let eof = false;
function readLine(prompt) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", l => (waiters.length ? waiters.shift()(l) : lines.push(l)));
    rl.on("close", () => { eof = true; while (waiters.length) waiters.shift()(null); });
  }
  process.stdout.write(prompt);
  const done = l => { if (!process.stdin.isTTY) process.stdout.write((l ?? "") + "\n"); return l ?? ""; };
  return lines.length ? Promise.resolve(done(lines.shift())) : eof ? Promise.resolve(done(null)) : new Promise(r => waiters.push(l => r(done(l))));
}
async function confirm(q, def = true) {
  if (AUTO) return def;
  const a = (await readLine(`    ${q} ${c.d(def ? "[Y/n]" : "[y/N]")}：`)).trim().toLowerCase();
  return a ? a.startsWith("y") || a === "是" : def;
}

function git(args, { capture = true } = {}) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
  if (r.error) return { code: 127, out: "", err: String(r.error.message), all: String(r.error.message) };
  return { code: r.status ?? 1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), all: ((r.stdout || "") + (r.stderr || "")).trim() };
}
const must = (args, msg) => { const r = git(args); if (r.code !== 0) fail(`${msg}\n    ${c.d(r.all.split("\n").slice(-6).join("\n    "))}`); return r.out; };
function deploy() {
  // 已经部署过（有保存的配置）就不再提问；第一次则进入交互式部署
  const extra = existsSync(path.join(ROOT, ".deploy", "config.json")) ? ["--yes"] : [];
  const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "deploy.mjs"), ...extra], { cwd: ROOT, stdio: "inherit" });
  return r.status === 0;
}

async function main() {
  console.log(c.b("\n✦ 星彩绘图台 · 一键更新\n"));
  step(1, "检查 git");
  if (git(["--version"]).code !== 0) fail("没有找到 git。请先安装 Git（Windows：https://git-scm.com/download/win ，安装时一路下一步即可），然后重新运行");
  let inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (/dubious ownership/i.test(inside.all)) {
    // Windows 上仓库文件的所有者和当前用户不同时 git 会拒绝工作：把本仓库加入信任列表
    git(["config", "--global", "--add", "safe.directory", ROOT.replace(/\\/g, "/")]);
    inside = git(["rev-parse", "--is-inside-work-tree"]);
  }
  if (inside.out !== "true") fail("当前文件夹不是 git 仓库，无法自动更新。请用 git clone 下载的仓库运行");
  if (!git(["config", "user.email"]).out) { git(["config", "user.email", "local@star-canvas"]); git(["config", "user.name", "star-canvas local"]); }
  const branch = must(["rev-parse", "--abbrev-ref", "HEAD"], "读取当前分支失败");
  info(`当前分支：${branch}  ${c.d(must(["log", "-1", "--format=%h %s"], "读取提交失败"))}`);

  if (ARGS.has("--rollback")) return rollback();

  if (git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0) {
    warn("上次的合并没有完成，先把它撤销");
    must(["merge", "--abort"], "撤销未完成的合并失败");
  }
  const dirty = git(["status", "--porcelain"]).out;
  if (dirty) {
    step(2, "保存本地改动");
    info(c.d(dirty.split("\n").slice(0, 8).join("\n    ")) + (dirty.split("\n").length > 8 ? c.d("\n    …") : ""));
    if (!(await confirm("发现你改过的文件，先把它们保存为一次提交再更新吗？（选 n 则取消更新）", true))) fail("已取消，没有做任何改动", 0);
    must(["add", "-A"], "保存本地改动失败");
    must(["commit", "-q", "-m", `本地改动（更新前自动保存 ${new Date().toLocaleString("zh-CN")}）`], "保存本地改动失败");
    info(c.g("已保存"));
  }

  step(3, "获取原作者的最新版本");
  const remotes = git(["remote", "-v"]).out.split("\n").map(l => l.split(/\s+/)).filter(x => x[2] === "(fetch)");
  let remote = remotes.find(([, url]) => (UPSTREAM_MATCH ? UPSTREAM_MATCH.test(url) : url === UPSTREAM_URL))?.[0];
  if (!remote) {
    remote = remotes.some(([n]) => n === "upstream") ? "star-canvas-upstream" : "upstream";
    must(["remote", "add", remote, UPSTREAM_URL], "添加上游仓库地址失败");
    info(`已添加上游地址：${UPSTREAM_URL}`);
  }
  const f = git(["fetch", "--quiet", remote]);
  if (f.code !== 0) fail(`拉取失败，访问不了 GitHub？\n    ${c.d(f.all.split("\n").slice(-4).join("\n    "))}\n    国内网络可能需要先开代理；git 走代理可运行：git config --global http.proxy http://127.0.0.1:7890（端口换成你代理软件的）`);
  let up = git(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]).out;
  if (!up) up = ["main", "master"].map(b => `${remote}/${b}`).find(r => git(["rev-parse", "-q", "--verify", r]).code === 0);
  if (!up) fail("没找到上游的主分支");
  const incoming = git(["log", "--oneline", "--no-merges", `HEAD..${up}`]).out;
  if (!incoming) {
    info(c.g("已经是最新版本，不需要更新"));
    if (await confirm("仍然重新部署一次吗？", false)) process.exit(deploy() ? 0 : 1);
    return;
  }
  const list = incoming.split("\n");
  info(`原作者有 ${c.b(String(list.length))} 个新提交：`);
  list.slice(0, 15).forEach(l => info(c.d("  " + l)));
  if (list.length > 15) info(c.d(`  …以及另外 ${list.length - 15} 个`));
  if (!(await confirm("合并进来吗？", true))) fail("已取消，没有做任何改动", 0);

  step(4, "合并");
  const before = must(["rev-parse", "HEAD"], "读取当前提交失败");
  const tag = `backup/pre-update-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
  must(["tag", tag, before], "创建备份标签失败");
  info(c.d(`更新前的代码已备份为标签 ${tag}（可用 --rollback 回退）`));
  const m = git(["merge", "--no-edit", "-m", `合并原作者更新（${up}）`, up]);
  if (m.code !== 0) {
    const conflicts = git(["diff", "--name-only", "--diff-filter=U"]).out;
    git(["merge", "--abort"]);
    git(["tag", "-d", tag]);   // 什么都没变，备份标签也不需要了
    fail(`原作者的改动和本地的修改冲突，已自动放弃这次合并，代码和线上都保持原样，什么都没坏。\n` +
      (conflicts ? `    冲突文件：${conflicts.split("\n").join("、")}\n` : "") +
      `    这种情况需要人工合并：把这段输出发给 Claude（或熟悉 git 的朋友），让他在 ${branch} 分支上合并 ${up}。`);
  }
  info(c.g("合并成功") + c.d(`  ${git(["log", "-1", "--format=%h"]).out}`));
  const migs = git(["diff", "--name-only", "--diff-filter=A", before, "HEAD", "--", "migrations"]).out;
  if (migs) info(`包含新的数据库迁移：${migs.split("\n").map(x => path.basename(x)).join("、")}（部署时会自动执行，执行前会先备份）`);

  step(5, "部署");
  if (!(await confirm("现在就部署到 Cloudflare 吗？", true))) { info("已合并但还没部署。之后双击 deploy.bat 即可部署"); return; }
  if (deploy()) { console.log("\n" + c.g(c.b("✓ 更新完成"))); return; }
  warn("部署失败（线上仍是更新前的版本，部署失败不会影响正在运行的网站）");
  if (await confirm("要把代码也回退到更新前吗？", true)) { must(["reset", "--hard", tag], "回退失败"); info(c.g(`已回退到 ${tag}`)); }
  process.exit(1);
}

async function rollback() {
  step(2, "回退到最近一次更新之前");
  const tags = git(["tag", "--list", "backup/pre-update-*", "--sort=-creatordate"]).out.split("\n").filter(Boolean);
  if (!tags.length) fail("没有找到更新前的备份，无法回退");
  const tag = tags[0];
  info(`回退目标：${tag}  ${c.d(git(["log", "-1", "--format=%h %s", tag]).out)}`);
  if (git(["status", "--porcelain"]).out) warn("你有尚未保存的改动，回退会丢掉它们");
  if (!(await confirm("确定回退并重新部署吗？", true))) fail("已取消", 0);
  must(["reset", "--hard", tag], "回退失败");
  git(["tag", "-d", tag]);
  info(c.g("代码已回退"));
  warn("数据库不会回退：新版本加过的表 / 字段会留着（旧代码不使用它们，不影响运行）");
  process.exit(deploy() ? 0 : 1);
}

main().catch(e => fail(e?.stack || String(e))).finally(() => rl?.close());
