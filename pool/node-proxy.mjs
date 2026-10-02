// 星彩绘图台出口节点（Node 18+，可用于 Koyeb / Render / Glitch / 本机测试）。
// 环境变量：UPSTREAM（默认 https://nai.rinko.ai）、POOL_KEY（必填；未设时所有业务请求 fail-closed 返回 403）、PORT（默认 8787）。
import http from "node:http";

const UPSTREAM = (process.env.UPSTREAM || "https://nai.rinko.ai").replace(/\/+$/, "");
const POOL_KEY = (process.env.POOL_KEY || "").trim();
const PORT = Number(process.env.PORT || 8787);
const HOP_HEADERS = ["x-pool-key", "host", "content-length", "connection", "accept-encoding"];
// Node（undici）fetch 会自动解压 gzip/br，转发时必须剥掉编码与长度头，否则客户端二次解压报错
const DROP_RESPONSE_HEADERS = new Set(["connection", "transfer-encoding", "content-encoding", "content-length"]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  if (!POOL_KEY || req.headers["x-pool-key"] !== POOL_KEY) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: "pool key missing or wrong", code: "POOL_AUTH" } }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = { ...req.headers };
  for (const h of HOP_HEADERS) delete headers[h];
  try {
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
      redirect: "manual",
    });
    const outHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (!DROP_RESPONSE_HEADERS.has(key)) outHeaders[key] = value;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: "upstream unreachable: " + String(e), code: "UPSTREAM_UNAVAILABLE" } }));
  }
});

server.listen(PORT, () => console.log(`pool node listening on :${PORT} -> ${UPSTREAM}`));
