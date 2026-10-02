// 星彩绘图台出口节点（Deno Deploy / Deno 运行时）。
// 职责：校验池密钥 → 流式转发到 UPSTREAM。请求体整体缓冲（生图/上传体量小），响应保持流式（生图结果数 MB）。
// 环境变量：UPSTREAM（默认 https://nai.rinko.ai）、POOL_KEY（必填；未设时所有业务请求 fail-closed 返回 403）。
const UPSTREAM = (Deno.env.get("UPSTREAM") || "https://nai.rinko.ai").replace(/\/+$/, "");
const POOL_KEY = (Deno.env.get("POOL_KEY") || "").trim();
const HOP_HEADERS = ["x-pool-key", "host", "content-length", "connection", "accept-encoding"];

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/healthz") {
    return new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (!POOL_KEY || req.headers.get("x-pool-key") !== POOL_KEY) {
    return new Response(JSON.stringify({ error: { message: "pool key missing or wrong", code: "POOL_AUTH" } }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const headers = new Headers(req.headers);
  for (const h of HOP_HEADERS) headers.delete(h);
  try {
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer();
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: "upstream unreachable: " + String(e), code: "UPSTREAM_UNAVAILABLE" } }), {
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
});
