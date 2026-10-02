// 假上游（tests/run.sh 使用）：模拟 nai.rinko.ai 的关键接口，记录收到的请求供断言
const http = require("http");
const log = [];
let costNext = 0, bigNext = 0;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
http.createServer((req, res) => {
  let body = ""; req.on("data", c => body += c); req.on("end", () => {
    const entry = { method: req.method, url: req.url, auth: req.headers.authorization || "", headers: req.headers, body };
    log.push(entry);
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/__log") return send(200, log);
    if (req.url === "/__reset") { log.length = 0; return send(200, {}); }
    if (req.url.startsWith("/__cost/")) { costNext = Number(req.url.split("/")[2]); return send(200, { costNext }); }
    if (req.url.startsWith("/__big/")) { bigNext = Number(req.url.split("/")[2]); return send(200, { bigNext }); }   // 下一次生图返回约 N MB 的图片（测流式扫描计费）
    if (req.url === "/v1/models") return send(200, { object: "list", data: ["nai-diffusion-3","nai-diffusion-4-5-full","nai-diffusion-4-5-curated","nai-diffusion-5-full","nai-diffusion-5-curated"].map(id => ({ id, object: "model" })) });
    if (req.url === "/api/ynai/auth/login") { const b = JSON.parse(body || "{}"); return b.password === "bad" ? send(401, { detail: "bad password" }) : send(200, { message: "ok", data: { access_token: "jwt-" + b.username, uid: 1 } }); }
    if (req.url === "/api/ynai/tokens") return send(200, { data: { token: "ynai-tok-" + Date.now() } });
    if (req.url.startsWith("/api/ai/generate-image/suggest-tags")) return send(200, { tags: [{ tag: "smile", confidence: 0.9 }] });
    if (req.url === "/api/user/checkin") return send(200, { message: "签到成功", data: { gems: 3 } });
    if (req.url === "/api/ynai/user/balance") return send(200, { data: { balance_gems: 100 } });
    if (req.url === "/v1/nai/generate-image") {
      let b = {}; try { b = JSON.parse(body); } catch {}
      if (!b.input) return send(422, { detail: [{ msg: "input required" }] });
      if (entry.auth === "Bearer ynai-bad") return send(401, { detail: "invalid api token" });
      const c = costNext, big = bigNext; costNext = 0; bigNext = 0;
      const img = big ? "A".repeat(Math.round(big * 1024 * 1024)) : PNG;
      return send(200, { images: [img], image_format: "png", job: { status: "done", cost_gems: c } });
    }
    send(404, { detail: "mock: not found " + req.url });
  });
}).listen(8790, "127.0.0.1", () => console.log("mock upstream on 8790"));
