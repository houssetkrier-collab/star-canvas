# 出口节点池（按账号固定出口 IP）

给星彩绘图台 Worker 加一层自托管中转：Worker 按账号把上游请求路由到池中固定节点，每个节点一个独立出口 IP，实现"每个账号固定不同 IP"。节点不落盘任何数据，只做校验 + 转发。

```
绘图台 Worker（按账号 sticky 路由）
   ├─ 节点 A（Deno Deploy）────┐
   ├─ 节点 B（Vercel Edge）────┼──→ nai.rinko.ai
   └─ 节点 C（Koyeb Node）─────┘
```

## 路由规则

- Worker 读取 `YESNAI_BASES`（逗号分隔节点 URL，顺序即编号），账号分配规则为 **账号 id % 节点数**。
- 同一账号的登录 / 签到 / 钱包 / 图包 / 生图 / 图片工具全部走同一节点；生图失败转移换账号时自动随账号换节点。
- 没有账号上下文的请求（如 `/v1/models` 模型列表）走第一个节点。
- **节点数 ≥ 账号数**才能每账号完全隔离；增减节点会改变所有账号的分配（rinko 看到的 IP 变化）。
- 未配置 `YESNAI_BASES` 时保持旧行为：全部请求直连 `YESNAI_BASE`（默认 rinko）。

## 第一步：生成池密钥

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 第二步：部署节点（至少 N = 账号数 个，且分属不同平台才有不同出口 IP）

所有节点共用两个环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `POOL_KEY` | 是 | 第一步生成的密钥；未设置时节点对所有业务请求返回 403（fail-closed） |
| `UPSTREAM` | 否 | 固定填 `https://nai.rinko.ai`（默认值即此） |

### 方式 A：Deno Deploy（推荐，流式原生）

1. Fork / 上传本仓库，或直接用 Dashboard "Paste" 模式贴入 `pool/deno-proxy.ts`。
2. 环境变量里设置 `POOL_KEY`（和 `UPSTREAM`）。
3. 得到 `https://<项目名>.deno.dev`。

### 方式 B：Vercel Edge

新建 `api/proxy.ts`（本仓库 pool/ 目录同级建一个最小 Vercel 项目即可）：

```ts
export const config = { runtime: "edge" };
const UPSTREAM = (process.env.UPSTREAM || "https://nai.rinko.ai").replace(/\/+$/, "");
const POOL_KEY = (process.env.POOL_KEY || "").trim();
export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/healthz") return new Response("ok");
  if (!POOL_KEY || req.headers.get("x-pool-key") !== POOL_KEY) return new Response("forbidden", { status: 403 });
  const headers = new Headers(req.headers);
  for (const h of ["x-pool-key", "host", "content-length", "connection", "accept-encoding"]) headers.delete(h);
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer();
  try {
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, { method: req.method, headers, body, redirect: "manual" });
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: { message: String(e) } }), { status: 502, headers: { "content-type": "application/json" } });
  }
}
```

`vercel env add POOL_KEY` 后 `vercel deploy --prod`，得到 `https://<项目>.vercel.app`。

### 方式 C：Koyeb / Render / 任意 Node 托管

直接跑 `node pool/node-proxy.mjs`，环境变量 `POOL_KEY`、`PORT`（平台自动注入），得到平台分配的域名。

## 第三步：Worker 侧启用

```bash
cd <本仓库根目录>
npx wrangler secret put UPSTREAM_POOL_KEY   # 粘贴第一步生成的密钥
```

在 `wrangler.jsonc` 的 `vars` 里加入（顺序即节点编号）：

```jsonc
"vars": {
  "YESNAI_BASE": "https://nai.rinko.ai",
  "YESNAI_BASES": "https://节点A.deno.dev,https://节点B.vercel.app,https://节点C.koyeb.app"
}
```

`YESNAI_BASES` 中**可以**包含原 `YESNAI_BASE`（直连 rinko）——直连请求不会带池密钥头，走池节点的请求才会带。然后 `npx wrangler deploy`。

> 部署/变更线上属于高影响操作，执行前与使用者确认。

## 第四步：验证

```bash
# 1) 节点存活
curl https://节点A.deno.dev/healthz                      # 期望 ok
# 2) 鉴权生效
curl https://节点A.deno.dev/v1/models                    # 期望 403 POOL_AUTH
# 3) 带密钥转发
curl -H "x-pool-key: <密钥>" https://节点A.deno.dev/v1/models   # 期望 rinko 的模型列表 JSON
```

绘图台侧：网页发一次生图，统计页请求日志正常记录即为链路通。若要确认某账号走了哪个节点，看该请求耗时与直连时的差异，或在节点平台看请求日志计数。

## 边界与已知限制

- 免费平台的出口是各平台数据中心 IP 段（非住宅 IP），"池"的意义是**每账号出口稳定且彼此不同**，不是高匿住宅代理。
- rinko 签到接口本就有 Cloudflare Turnstile 人机验证（绘图台已将该状态标记为 `manual_required` 交人工处理）；换出口不能消除此类风控。
- 节点代码不记录请求体与 Authorization 头；`POOL_KEY` 只存在于 Worker secret 与节点环境变量。
- 本机自测节点时 `UPSTREAM` 可指向本地 mock 上游，避免真实请求。
