#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""YesNAI 星彩绘图台 - 本地启动器 + API 代理（零依赖，仅标准库）

用法:
    python serve.py                # 默认 http://127.0.0.1:8788 并自动打开浏览器
    python serve.py --port 9000    # 换端口
    python serve.py --no-browser   # 不自动开浏览器
    python serve.py --allow-host nai.example.com   # 额外允许代理的站点域名

站点 nai.rinko.ai 的 API 不返回 CORS 头，浏览器页面无法直连，
所以所有请求走本进程转发: 页面请求 /p/<path> + 头 X-Ynai-Target: https://<host>
仅允许代理到 https 且 host 在白名单内（默认 nai.rinko.ai 及 *.rinko.ai）。

本地模式为单账号；多账号中转请部署 Cloudflare Worker 版（README）。
签到语义与 Worker 对齐：工作日/周末多时间槽、每槽最多 1+4 次尝试、
失败 30 分钟退避、401/Turnstile 终态停止。
"""
import argparse
import datetime as dt
import json
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_SITE = "https://nai.rinko.ai"
STATE_FILE = ROOT / "autocheckin.json"
PROMPT_CONFIG_FILE = ROOT / "prompt_api.json"
HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
    "content-length", "accept-encoding",
}
CTX = ssl.create_default_context()
STATE_LOCK = threading.Lock()
RETRY_GAP_S = 30 * 60
RETRY_MAX = 4
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

def load_prompt_config():
    try:
        raw = json.loads(PROMPT_CONFIG_FILE.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        return {}


def save_prompt_config(config):
    PROMPT_CONFIG_FILE.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def prompt_base(value):
    value = str(value or "").strip().rstrip("/")
    value = re.sub(r"/(?:chat/completions|models)$", "", value, flags=re.I)
    return re.sub(r"/v1$", "", value, flags=re.I).rstrip("/")



def prompt_api_request(config, path, payload=None, timeout=60, overrides=None):
    config = {**config, **(overrides or {})}
    base = prompt_base(config.get("base"))
    key = str(config.get("key") or "").strip()
    model = str(config.get("model") or "").strip()
    if not base or not key or not model:
        return None, "本地未配置中文提示词 API"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(base + "/v1" + path, data=data, method="POST" if payload is not None else "GET", headers={"Accept":"application/json", "Authorization":"Bearer " + key, **({"Content-Type":"application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw or "{}"), None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        return None, f"中文提示词 API HTTP {e.code}：{body}"
    except Exception as e:
        return None, f"无法连接中文提示词 API：{e}"


def convert_prompt_local(text):
    text = str(text or "").strip()
    if not text:
        raise ValueError("请输入中文画面描述")
    if len(text) > 3000:
        raise ValueError("中文画面描述不能超过 3000 字")
    config = load_prompt_config()
    payload, error = prompt_api_request(config, "/chat/completions", {"model": str(config.get("model") or ""), "messages": [{"role":"system", "content":"You are a specialist at converting Chinese image requests into precise NovelAI Diffusion prompts.\n\nOUTPUT CONTRACT\n- Return exactly one line of English, comma-separated NovelAI/booru-style tags. Never return prose, headings, Markdown, Chinese, JSON or a negative-prompt section.\n- For an adult NSFW scene, the first tag must be nsfw.\n- Use concise visual tags, not sentences. Split compound ideas into concrete tags; for example, 月下 becomes moonlight, night.\n- Describe only people, objects, clothing, background, lighting, camera framing and physical actions that are objectively visible in the requested image. Never include thoughts, memories, metaphors, plans or story exposition.\n- Do not invent artist names, model settings, unrelated details or sexual content that the user did not request.\n\nTAG PRIORITY AND ORDER\n1. If this is a known copyrighted/fandom character, put the official English character tag or widely used canonical character tag first, followed immediately by its defining appearance. Never fabricate a character identity. For an original character, use original instead of its personal name.\n2. Subject count and identity: 1girl, 1boy, multiple girls, species, role or archetype; include age only when visually relevant or needed to establish an adult-only explicit scene.\n3. Defining appearance: hairstyle, hair color, eye color, skin, body type and distinctive accessories. These are the highest-priority consistency tags.\n4. Clothing and its exact current state: garment type, material and details, whether it is intact, lifted, open, torn, partially removed or absent.\n5. Main pose and action: standing, kneeling, walking, sleeping, cooking and other concrete actions.\n6. Fine action and interaction details: which hand does what, contact with self, another adult, a prop or the environment; distinguish one hand from both hands and use spatially precise tags.\n7. Visible expression and gaze: looking at viewer, looking away, smile, open mouth, blush, tears and other observable reactions.\n8. Camera and visible body region: from above, from below, from behind, upper body, lower body, full body, close-up, between legs, dutch angle and focal emphasis.\n9. Location, props, time, weather, lighting and atmosphere: bedroom, beach, indoors, morning, night, moonlight, rim lighting and other visible scene information.\n\nCONSISTENCY RULES\n- The latest explicit state in the request wins. Remove every conflicting tag instead of outputting both states.\n- Adapt features to what the camera can actually see. A lower-body-only frame must omit facial expression, eye color and other invisible upper-body details. A back view must omit invisible eye details; a covered face or blindfold must omit hidden eye details.\n- Convert dialogue or narrative claims into visible actions only when the request makes the action visually clear; for example, “showing underwear” becomes lifting skirt, panties.\n- Preserve exact relative positions, prop locations, clothing state, lighting and interaction partners. Never swap who performs or receives an action.\n- Use explicit absence tags such as no bra or no panties only when the absence is visually important and directly requested; otherwise omit the element.\n\nWEIGHTING\n- Emphasize only the most important stable traits or focal actions with NovelAI braces: {tag}, {{tag}}, {{{tag}}}. Prefer defining appearance, then action, clothing and expression. Avoid excessive weighting and never weight every tag.\n- De-emphasize minor background details with [tag] or [[tag]] only when needed.\n- Keep logically related tags adjacent and allocate more tags to the visual focal point than to minor background details.\n\nFor multiple characters, keep each character's appearance and actions unambiguous and adjacent. "}, {"role":"user", "content":text}], "temperature":0.35, "max_tokens":1000, "stream":False})
    if payload is not None:
        content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
        if isinstance(content, list):
            content = "".join(item if isinstance(item, str) else str(item.get("text") or "") for item in content)
        result = str(content or "").strip()
        result = re.sub(r"^```(?:\w+)?\s*", "", result, flags=re.I)
        result = re.sub(r"\s*```$", "", result)
        result = re.sub(r"^prompt\s*:\s*", "", result, flags=re.I)
        result = re.sub(r"^(\"|')|(\"|')$", "", result)
        result = re.sub(r"\s+", " ", result).strip()
        if result:
            return result
    raise ValueError(error or "中文提示词转换失败")

def artist_assist_local(payload):
    content = str(payload.get("content") or payload.get("artist") or "").strip()
    if not content:
        raise ValueError("请输入画师串")
    if len(content) > 12000:
        raise ValueError("画师串不能超过 12000 字")
    if str(__import__('os').environ.get("YESNAI_AI_FIXTURE") or "") == "1":
        return {"summary":"夹具建议：先清理重复，再平衡权重。", "ops":[
            {"id":"0","op":"remove","artist":"ask","reason":"与另一项重复"},
            {"id":"1","op":"add","artist":"Aeba Fuchi","weight":1.1,"reason":"补充细腻线稿质感"},
            {"id":"2","op":"weight","artist":"machi (7769)","weight":0.8,"reason":"降低过强权重"},
            {"id":"3","op":"keep","artist":"Vincent van Gogh","reason":"保留核心笔触锚点"},
            {"id":"4","op":"add","artist":"not-in-library","reason":"测试库外结果过滤"},
        ]}
    config = load_prompt_config()
    candidates = payload.get("candidates") if isinstance(payload.get("candidates"), list) else []
    system = """You are an assistant for editing NovelAI artist strings. Return JSON only: {\"summary\":string,\"ops\":[{\"id\":string,\"op\":\"remove\"|\"add\"|\"weight\"|\"keep\",\"artist\":string,\"weight\":number|null,\"reason\":string}]}. Never return prose or markdown. Only suggest removing existing artists, adding names from the supplied candidate list, changing weights between 0.2 and 2.0, or keeping an existing artist. Do not invent names."""
    prompt = {"content": content, "mode": payload.get("mode") or "optimize", "instruction": str(payload.get("instruction") or "")[:2000], "target_count": payload.get("target_count"), "tokens": payload.get("tokens") or [], "candidates": candidates[:160]}
    data, error = prompt_api_request(config, "/chat/completions", {"model": str(config.get("model") or ""), "messages":[{"role":"system","content":system},{"role":"user","content":json.dumps(prompt, ensure_ascii=False)}], "temperature":0.2, "max_tokens":1800, "stream":False})
    if error:
        raise RuntimeError(error)
    raw = data.get("choices", [{}])[0].get("message", {}).get("content", "") if isinstance(data, dict) else ""
    raw = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.I)
    result = json.loads(raw)
    if not isinstance(result, dict) or not isinstance(result.get("ops"), list):
        raise RuntimeError("AI 返回格式无效")
    allowed = {"remove", "add", "weight", "keep"}
    result["ops"] = [x for x in result["ops"][:100] if isinstance(x, dict) and x.get("op") in allowed and str(x.get("artist") or "").strip()]
    return result


def artist_optimize_local(payload):
    content = str(payload.get("content") or payload.get("artist") or "").strip()
    if not content:
        raise ValueError("请输入画师串")
    if len(content) > 12000:
        raise ValueError("画师串不能超过 12000 字")
    if str(__import__('os').environ.get("YESNAI_AI_FIXTURE") or "") == "1":
        return {"artist": "artist:ask, artist:ciloranko\nartist:ravenlake"}
    config = load_prompt_config()
    mode = str(payload.get("mode") or "optimize").strip().lower()
    if mode not in {"optimize", "merge", "slim"}:
        raise ValueError("mode 仅支持 optimize、merge 或 slim")
    prompt = {"mode": mode, "target_count": payload.get("target_count"), "artist": content, "instruction": str(payload.get("instruction") or "")[:2000], "extra": str(payload.get("extra") or "")[:4000]}
    system = "You optimize NovelAI artist strings. Return only the final artist string. Preserve artist: prefix, existing names, syntax, weighted groups, brackets and meaningful line breaks. Never invent, translate, or substitute names. Mode optimize improves intent, merge deduplicates, slim shortens while preserving useful existing names."
    data, error = prompt_api_request(config, "/chat/completions", {"model": str(config.get("model") or ""), "messages":[{"role":"system","content":system},{"role":"user","content":json.dumps(prompt, ensure_ascii=False)}], "temperature":0.2, "max_tokens":2000, "stream":False})
    if error:
        raise RuntimeError(error)
    raw = data.get("choices", [{}])[0].get("message", {}).get("content", "") if isinstance(data, dict) else ""
    raw = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)
    raw = re.sub(r"^```(?:[a-z0-9_-]+)?\s*|\s*```$", "", raw.strip(), flags=re.I)
    raw = re.sub(r"^(?:artist\s*(?:string|prompt)|画师串)[：:]\s*", "artist: ", raw, flags=re.I)
    if raw and not re.match(r"^artist\s*:", raw, flags=re.I):
        raw = "artist: " + raw
    if not raw.strip():
        raise RuntimeError("AI 没有返回画师串")
    return {"artist": re.sub(r"^artist\s*:", "artist:", raw.strip(), flags=re.I)}


def json_body(handler):
    length = int(handler.headers.get("Content-Length") or 0)
    try: value = json.loads(handler.rfile.read(length) or b"{}")
    except Exception: value = {}
    return value if isinstance(value, dict) else {}


DEFAULT_STATE = {
    "enabled": True, "timezone": "",            # 空 = 跟随系统时区
    "weekday_times": ["09:05"], "weekend_times": ["10:00"],
    "base": DEFAULT_SITE, "token": "",
    "last_attempt_slot": "", "last_success_slot": "", "last_attempt_at": "",
    "attempt_slots": [], "success_slots": [],   # 当天已尝试/已成功的槽集合（与 Worker 语义对齐）
    "status": "pending", "retry_count": 0, "last_msg": "尚未运行",
    "log": [],
}


# ---------------- 状态文件 ----------------
def load_state() -> dict:
    try:
        raw = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("state 不是对象")
    except FileNotFoundError:
        return dict(DEFAULT_STATE)
    except Exception as e:
        # 损坏则备份重建，绝不静默清空后继续写（那会丢掉已保存的令牌）
        bak = STATE_FILE.with_suffix(".json.bak")
        try:
            STATE_FILE.rename(bak)
            print(f"[autocheckin] 状态文件损坏（{e}），已备份到 {bak.name} 并重建")
        except Exception:
            pass
        return dict(DEFAULT_STATE)
    out = dict(DEFAULT_STATE)
    for k in out:
        if k in raw:
            out[k] = raw[k]
    # v1（单 time 字段）→ v2 迁移
    if "weekday_times" not in raw and raw.get("time"):
        out["weekday_times"] = [raw["time"]]
    if raw.get("last_ok"):
        out["last_success_slot"] = raw["last_ok"]
        if str(raw["last_ok"]) == dt.date.today().isoformat():
            # v1 今天已签：标记今天最后一个到点槽为完成，避免升级后重复尝试
            now = now_local(out)
            hit = [t for t in sorted(times_for(now, out)) if now.strftime("%H:%M") >= t]
            k = now.strftime("%Y-%m-%dT") + (hit[-1] if hit else "00:00")
            out["last_attempt_slot"] = out["last_success_slot"] = k
    out["weekday_times"] = clean_times(out.get("weekday_times"), ["09:05"])
    out["weekend_times"] = clean_times(out.get("weekend_times"), ["10:00"])
    return out


def save_state(st: dict):
    st["log"] = (st.get("log") or [])[:50]
    STATE_FILE.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")


def clean_times(values, fallback):
    out = []
    for v in values if isinstance(values, list) else []:
        v = str(v).strip()
        if TIME_RE.match(v) and v not in out:
            out.append(v)
    return sorted(out) or list(fallback)


# ---------------- 时间槽 ----------------
def get_zone(name: str):
    name = (name or "").strip()
    if not name:
        return None
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:
        return None


def now_local(st: dict) -> dt.datetime:
    tz = get_zone(st.get("timezone", ""))
    return dt.datetime.now(tz) if tz else dt.datetime.now()


def times_for(d: dt.datetime, st: dict):
    return st["weekend_times"] if d.weekday() >= 5 else st["weekday_times"]


def due_slot(d: dt.datetime, st: dict):
    """升序补签：优先今天最早一个未尝试的槽；全部试过则落到最新槽进入重试。"""
    due = [t for t in sorted(times_for(d, st)) if d.strftime("%H:%M") >= t]
    if not due:
        return None
    day = d.strftime("%Y-%m-%dT")
    # 槽状态按「当天集合」记录而非单值，避免多时间槽互相顶掉对方的已签记录导致整晚重复签到
    tried = set(st.get("attempt_slots") or []) | set(st.get("success_slots") or [])
    for t in due:
        k = day + t
        if k not in tried:
            return k
    return day + due[-1]


# ---------------- 签到 ----------------
def do_checkin(st: dict):
    """用保存的 JWT 调站点签到。返回 (ok, msg, status_code)。"""
    base = (st.get("base") or DEFAULT_SITE).rstrip("/")
    tok = st.get("token") or ""
    if not tok:
        return False, "没有登录令牌——打开绘图台登录一次即可自动同步", 0
    req = urllib.request.Request(
        base + "/api/user/checkin", data=b"", method="POST",
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60, context=CTX) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                data = json.loads(raw or "{}")
            except Exception:
                data = {"message": raw[:200]}
            gems = ""
            d = data.get("data") or {}
            for k in ("gems", "quota_awarded", "quota", "reward", "checkin_gems"):
                if isinstance(d, dict) and d.get(k) is not None:
                    gems = f"，获得 {d[k]} Gems"
                    break
            return True, (data.get("message") or "success") + gems, resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        if e.code == 401:
            return False, "登录令牌失效——打开绘图台重新登录一次即可", 401
        if "turnstile" in body.lower() or "need_turnstile" in body:
            return False, "站点签到开启了人机验证，自动签到无法通过，请手动到网页签到", e.code
        return False, f"HTTP {e.code}：{body or e.reason}", e.code
    except Exception as e:
        return False, f"请求失败：{e}", 0


def attempt(st: dict, slot=None, manual=False) -> dict:
    """执行一次签到并落状态。调用方需持有 STATE_LOCK。"""
    if slot is None:
        slot = due_slot(now_local(st), st)
        if slot is None:
            return {"ok": False, "skipped": True, "msg": "当前没有到点的签到时间"}
    ok, msg, code = do_checkin(st)
    is_new_slot = st.get("last_attempt_slot") != slot
    if code == 401:
        status = "jwt_expired"
    elif "turnstile" in msg.lower() or "人机验证" in msg:
        status = "manual_required"
    elif ok:
        status = "success"
    else:
        status = "retry"
    st["last_attempt_slot"] = slot
    if ok:
        st["last_success_slot"] = slot
    # 当天槽集合：每次尝试入 attempted，成功追加 success；按天剪枝防膨胀
    day_prefix = (slot.split("T")[0] + "T") if "T" in slot else dt.datetime.now().strftime("%Y-%m-%dT")
    st["attempt_slots"] = sorted({k for k in (st.get("attempt_slots") or []) if k.startswith(day_prefix)} | {slot})
    if ok:
        st["success_slots"] = sorted({k for k in (st.get("success_slots") or []) if k.startswith(day_prefix)} | {slot})
    if manual:
        st["status"] = "success" if ok else "retry"
        st["retry_count"] = 0 if ok else st.get("retry_count", 0)
    else:
        st["status"] = status
        st["retry_count"] = 0 if ok else (1 if is_new_slot else st.get("retry_count", 0) + 1)
    st["last_attempt_at"] = dt.datetime.now().isoformat(timespec="seconds")
    st["last_msg"] = ("✅ 成功 · " if ok else "❌ 失败 · ") + msg
    st["log"] = [{"t": st["last_attempt_at"], "ok": ok, "msg": msg}] + (st.get("log") or [])
    save_state(st)
    return {"ok": ok, "msg": msg, "status": st["status"], "slot": slot}


def scheduler_loop():
    """每 5 分钟醒一次：按时刻表对到点槽执行签到，失败按 30 分钟退避重试。"""
    while True:
        try:
            with STATE_LOCK:
                st = load_state()
                if st.get("enabled", True):
                    slot = due_slot(now_local(st), st)
                    if slot:
                        fresh = slot not in (st.get("attempt_slots") or [])   # 按当天集合判断，多槽互不误判
                        gap_ok = True
                        if st.get("last_attempt_at"):
                            try:
                                gap_ok = (dt.datetime.now() -
                                          dt.datetime.fromisoformat(st["last_attempt_at"])).total_seconds() >= RETRY_GAP_S
                            except Exception:
                                pass
                        retryable = (st.get("status") == "retry"
                                     and st.get("retry_count", 0) < RETRY_MAX and gap_ok)
                        if fresh or retryable:
                            r = attempt(st, slot)
                            print("[autocheckin]", slot, st["last_msg"])
                            _ = r
        except Exception as e:
            print("[autocheckin] 调度异常:", e)
        time.sleep(300)


def allowed(target: str, allow_hosts: list) -> bool:
    if not target.startswith("https://"):
        return False
    host = target[len("https://"):].split("/")[0].lower()
    return any(host == h or (h.startswith("*.") and host.endswith(h[1:])) for h in allow_hosts)


class Handler(BaseHTTPRequestHandler):
    server_version = "StarCanvas/1.2"
    allow_hosts: list = []
    default_site: str = DEFAULT_SITE
    protocol_version = "HTTP/1.1"

    def _same_origin_ok(self) -> bool:
        """本机服务只接受本机 Host；浏览器跨站请求必带 Origin，与 Host 不符一律拒。
        挡两类攻击：恶意网页 CSRF（含免预检的 text/plain JSON）与 DNS rebinding（Host 伪装）。"""
        host = (self.headers.get("Host") or "").split(":")[0].strip().lower()
        if host not in ("127.0.0.1", "localhost"):
            return False
        origin = self.headers.get("Origin")
        if origin:
            try:
                ohost = urllib.parse.urlsplit(origin).hostname or ""
            except Exception:
                return False
            if ohost.lower() != host:
                return False
        return True

    def _reject_origin(self):
        self._send(403, "application/json; charset=utf-8",
                   json.dumps({"error": {"message": "跨站请求被拒绝（本地服务仅接受 127.0.0.1/localhost 来源）",
                                         "code": "ORIGIN_REJECTED"}}, ensure_ascii=False).encode())

    # ---------- 静态 ----------
    def do_GET(self):
        if not self._same_origin_ok():
            self._reject_origin()
            return
        if self.path == "/api/session":
            # 本地服务不是云端 Worker；避免前端把本地模式误判成云端模式。
            self._send(200, "application/json; charset=utf-8", json.dumps({"local": True, "accounts": 0, "access_key_required": False}).encode())
            return
        if self.path == "/danbooru-tags.json":
            body = (ROOT / "public" / "danbooru-tags.json").read_bytes()
            self._send(200, "application/json; charset=utf-8", body)
            return
        if self.path == "/artist-library.json":
            body = (ROOT / "public" / "artist-library.json").read_bytes()
            self._send(200, "application/json; charset=utf-8", body)
        elif self.path == "/api/prompt/config":
            config = load_prompt_config()
            result = {"base": prompt_base(config.get("base")), "model": config.get("model", ""), "configured": bool(config.get("base") and config.get("key") and config.get("model")), "key_configured": bool(config.get("key"))}
            self._send(200, "application/json; charset=utf-8", json.dumps(result, ensure_ascii=False).encode())
        elif self.path == "/api/prompt/status":
            config = load_prompt_config()
            result = {"configured": bool(config.get("base") and config.get("key") and config.get("model")), "model": config.get("model", "")}
            self._send(200, "application/json; charset=utf-8", json.dumps(result, ensure_ascii=False).encode())
        elif self.path == "/reg" or self.path.startswith("/reg?"):
            with STATE_LOCK:
                st = load_state()
            pub = {k: v for k, v in st.items() if k != "token"}
            pub["has_token"] = bool(st.get("token"))
            pub["last_message"] = st.get("last_msg", "")
            pub["today"] = dt.datetime.now().strftime("%Y-%m-%d")
            self._send(200, "application/json; charset=utf-8",
                       json.dumps(pub, ensure_ascii=False).encode())
        elif self.path.startswith("/p/"):
            self._proxy()
        elif self.path == "/" or self.path.startswith("/?"):
            body = (ROOT / "public" / "index.html").read_bytes()
            self._send(200, "text/html; charset=utf-8", body)
        else:
            self._send(404, "text/plain; charset=utf-8", "404".encode())

    # ---------- 代理 / 本地管理 ----------
    def do_POST(self):
        if not self._same_origin_ok():
            self._reject_origin()
            return
        if self.path == "/api/prompt/artist-optimize":
            payload = json_body(self)
            try:
                result = artist_optimize_local(payload)
                self._send(200, "application/json; charset=utf-8", json.dumps(result, ensure_ascii=False).encode())
            except ValueError as e:
                self._send(400, "application/json; charset=utf-8", json.dumps({"error":{"message":str(e)}}, ensure_ascii=False).encode())
            except Exception as e:
                self._send(502, "application/json; charset=utf-8", json.dumps({"error":{"message":str(e)}}, ensure_ascii=False).encode())
            return
        if self.path == "/api/prompt/models":
            payload = json_body(self)
            config = load_prompt_config()
            overrides = {k: payload.get(k) for k in ("base", "key", "model") if payload.get(k)}
            data, error = prompt_api_request(config, "/models", None, timeout=15, overrides=overrides)
            if error:
                self._send(502, "application/json; charset=utf-8", json.dumps({"error": {"message": error, "code": "PROMPT_API_ERROR"}}, ensure_ascii=False).encode())
            else:
                source = data.get("data") if isinstance(data, dict) else []
                if not isinstance(source, list):
                    source = data.get("models", []) if isinstance(data, dict) else []
                models = sorted({str(x if isinstance(x, str) else x.get("id") or x.get("name") or "").strip() for x in source if str(x if isinstance(x, str) else x.get("id") or x.get("name") or "").strip()})
                self._send(200, "application/json; charset=utf-8", json.dumps({"models": models}, ensure_ascii=False).encode())
            return
        if self.path in ("/api/prompt/config", "/api/prompt/convert"):
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            if self.path == "/api/prompt/config":
                base = prompt_base(payload.get("base"))
                key = str(payload.get("key") or "").strip()
                model = str(payload.get("model") or "").strip()
                if not base or not key or not model:
                    self._send(400, "application/json; charset=utf-8", json.dumps({"error": {"message": "请填写 API 地址、API Key 和模型名"}}, ensure_ascii=False).encode())
                    return
                save_prompt_config({"base": base, "key": key, "model": model})
                self._send(200, "application/json; charset=utf-8", json.dumps({"configured": True, "model": model}, ensure_ascii=False).encode())
                return
            try:
                result = convert_prompt_local(payload.get("prompt"))
                self._send(200, "application/json; charset=utf-8", json.dumps({"prompt": result}, ensure_ascii=False).encode())
            except ValueError as e:
                self._send(400, "application/json; charset=utf-8", json.dumps({"error": {"message": str(e)}}, ensure_ascii=False).encode())
            except Exception as e:
                self._send(502, "application/json; charset=utf-8", json.dumps({"error": {"message": str(e)}}, ensure_ascii=False).encode())
            return
        if self.path == "/reg":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            with STATE_LOCK:
                st = load_state()
                if "enabled" in payload:
                    st["enabled"] = bool(payload["enabled"])
                if "timezone" in payload:
                    tz = str(payload["timezone"] or "").strip()
                    if tz and not get_zone(tz):
                        self._send(400, "application/json; charset=utf-8",
                                   json.dumps({"error": {"message": f"时区无效：{tz}", "code": "BAD_TIMEZONE"}},
                                              ensure_ascii=False).encode())
                        return
                    st["timezone"] = tz
                if "weekday_times" in payload:
                    st["weekday_times"] = clean_times(payload["weekday_times"], st["weekday_times"])
                if "weekend_times" in payload:
                    st["weekend_times"] = clean_times(payload["weekend_times"], st["weekend_times"])
                for k in ("base", "token"):
                    if k in payload:
                        # base 白名单：签到地址只允许默认上游站，防止被改成攻击者服务器后带走 JWT
                        if k == "base":
                            b = str(payload.get("base") or "").rstrip("/")
                            if b and b != DEFAULT_SITE.rstrip("/"):
                                self._send(400, "application/json; charset=utf-8",
                                           json.dumps({"error": {"message": f"base 仅允许默认上游站点 {DEFAULT_SITE}",
                                                                 "code": "BASE_NOT_ALLOWED"}},
                                                      ensure_ascii=False).encode())
                                return
                        st[k] = payload[k]
                test = None
                if payload.get("action") == "test":
                    test = attempt(st, None, manual=True)
                    print("[autocheckin][test]", st["last_msg"])
                save_state(st)
                pub = {k: v for k, v in st.items() if k != "token"}
                pub["has_token"] = bool(st.get("token"))
                pub["last_message"] = st.get("last_msg", "")
                pub["test"] = test
            self._send(200, "application/json; charset=utf-8",
                       json.dumps(pub, ensure_ascii=False).encode())
        else:
            self._proxy()

    def do_PUT(self):
        if not self._same_origin_ok():
            self._reject_origin()
            return
        if self.path == "/api/prompt/config":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            base = prompt_base(payload.get("base"))
            key = str(payload.get("key") or "").strip()
            model = str(payload.get("model") or "").strip()
            if not base or not key or not model:
                self._send(400, "application/json; charset=utf-8", json.dumps({"error": {"message": "请填写 API 地址、API Key 和模型名"}}, ensure_ascii=False).encode())
                return
            save_prompt_config({"base": base, "key": key, "model": model})
            self._send(200, "application/json; charset=utf-8", json.dumps({"configured": True, "model": model}, ensure_ascii=False).encode())
            return
        self._proxy()

    def do_DELETE(self):
        if not self._same_origin_ok():
            self._reject_origin()
            return
        self._proxy()

    def _proxy(self):
        if not self.path.startswith("/p/"):
            self._send(404, "text/plain; charset=utf-8", b"404")
            return
        sub = self.path[3:].split("?")[0]
        query = self.path[3:].split("?", 1)[1] if "?" in self.path[3:] else ""
        target = self.headers.get("X-Ynai-Target") or self.default_site
        target = target.rstrip("/")
        if not allowed(target, self.allow_hosts):
            self._send(403, "application/json; charset=utf-8",
                       json.dumps({"error": {"message": f"目标不在代理白名单: {target}",
                                             "code": "PROXY_HOST_DENIED"}}).encode())
            return
        url = f"{target}/{sub}" + (f"?{query}" if query else "")

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        fwd = {"Content-Type": "application/json"}
        for k, v in self.headers.items():
            if k.lower() in HOP_HEADERS or k.lower() == "x-ynai-target":
                continue
            fwd[k] = v
        req = urllib.request.Request(url, data=body, method=self.command, headers=fwd)
        try:
            with urllib.request.urlopen(req, timeout=600, context=CTX) as resp:
                data = resp.read()
                ctype = resp.headers.get("Content-Type", "application/json")
                self._send(resp.status, ctype, data)
        except urllib.error.HTTPError as e:
            data = e.read()
            ctype = e.headers.get("Content-Type", "application/json")
            if ctype.startswith("text/html"):
                ctype = "text/plain; charset=utf-8"
            self._send(e.code, ctype, data)
        except Exception as e:  # 超时 / DNS / TLS
            self._send(502, "application/json; charset=utf-8",
                       json.dumps({"error": {"message": f"代理请求失败: {e}",
                                             "type": "proxy_error"}}).encode())

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stdout.write("[studio] %s %s\n" % (self.address_string(), fmt % args))


def main():
    if sys.stdout and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description="YesNAI 星彩绘图台 本地服务")
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--site", default=DEFAULT_SITE, help="默认代理目标站点")
    ap.add_argument("--allow-host", action="append", default=[],
                    help="额外允许的代理域名，可多次；支持 *.example.com 通配")
    args = ap.parse_args()

    st = load_state()
    print(f"[autocheckin] 自动签到：{'开启' if st.get('enabled', True) else '关闭'} · "
          f"工作日 {','.join(st['weekday_times'])} / 周末 {','.join(st['weekend_times'])}"
          f"{' · 时区 ' + st['timezone'] if st.get('timezone') else ''} · "
          f"令牌：{'已保存' if st.get('token') else '未同步（登录后自动同步）'}")

    Handler.allow_hosts = ["nai.rinko.ai", "*.rinko.ai"] + args.allow_host
    Handler.default_site = args.site

    try:
        srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as e:
        print(f"[studio] 端口 {args.port} 无法绑定（{e}）——试试 python serve.py --port 8789")
        sys.exit(1)
    url = f"http://127.0.0.1:{args.port}"
    print(r"""
  ╭──────────────────────────────────────────────╮
  │   YesNAI 星彩绘图台 · 本地服务已启动          │
  │   地址   %s   │
  │   代理   %s (白名单: %s ) │
  ╰──────────────────────────────────────────────╯
""" % (url.ljust(27), args.site.ljust(28), ", ".join(Handler.allow_hosts)))
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    threading.Thread(target=scheduler_loop, daemon=True, name="autocheckin").start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[studio] 已退出")


if __name__ == "__main__":
    main()
