# ✨ 星彩绘图台 · 全能工作台使用与部署指南

「星彩绘图台」是专为上游公益中转站（`nai.rinko.ai`）深度定制的 Web 绘图客户端、多账号中转与全自动签到系统。极光渐变与毛玻璃美学设计，本地零依赖极速启动，Cloudflare 云端免开机全自动托管。

---

## 目录

- [一、 核心特性](#一-核心特性)
- [二、 两种运行模式对比](#二-两种运行模式对比)
- [三、 快速上手指南](#三-快速上手指南)
- [四、 核心功能详解](#四-核心功能详解)
- [五、 多账号云端中转](#五-多账号云端中转)
- [六、 持久画廊（R2 / IndexedDB）](#六-持久画廊r2--indexeddb)
- [七、 全自动签到机制](#七-全自动签到机制)
- [八、 Cloudflare 云端部署与运维](#八-cloudflare-云端部署与运维)
- [九、 接口与底层代理协议](#九-接口与底层代理协议)
- [十、 常见问题与排错 (FAQ)](#十-常见问题与排错-faq)

---

## 一、 核心特性

* 🎨 **极光美学 UI**：多色流光背景、毛玻璃拟态、动态开场动画，纯原生前端零外部依赖。
* 🌐 **解决跨域痛点**：本地反向代理 / 云端 Worker 中转，透明转发无 CORS 头的 API，白名单防护。
* 🎯 **全模型与高级参数**：NAI 5 / 4.5 / v4 / v3 全系，14 种采样器、噪声调度、SMEA、v4/v5 结构化提示词、图生图、局部重绘、附加 JSON 参数。
* 🔒 **Seed 种子锁定**：像素级稳定复现，适合视觉小说表情差分、多动作立绘生成；高级参数（结构化开关/重绘幅度/附加 JSON）一并持久化与回填。
* 👥 **多账号云端中转**：一个 Worker 托管多个上游账号，凭据加密落库、JWT 过期自动重登，顶栏一键切换生图账号。
* 💰 **Gems 智能报价**：生成前预估消耗（免费模型显示 0），顶栏常驻余额，多账号余额一键汇总。
* ⏰ **双模全自动签到**：本地守护线程或云端 Cron，工作日/周末多时间槽 × 时区，错过的槽自动补签。
* 🖼️ **持久画廊**：云端 R2 / 本地 IndexedDB，缩略图分页浏览、原图放大、按真实格式下载、一键复现。

---

## 二、 两种运行模式对比

| 维度 | 本地模式 (`python serve.py`) | 云端模式 (`Cloudflare Worker`) |
| :--- | :--- | :--- |
| **启动方式** | 终端运行 `python serve.py` | 浏览器直接访问 Worker 地址 |
| **依赖环境** | Python 3 标准库（无需 pip） | Cloudflare 账号（Worker + D1 + R2） |
| **开机要求** | 签到需进程保持运行 | **无需开机**，云端 24h 自动 |
| **账号数量** | 单账号 | **多账号中转**（网页添加，加密托管） |
| **凭据存储** | 本机 `autocheckin.json` + 浏览器 localStorage | D1 `accounts` 表 AES-GCM 加密；Secret 仅作首账号引导 |
| **画廊存储** | 浏览器 IndexedDB | Cloudflare R2 + D1 元数据 |
| **多端访问** | 仅本机（绑定 127.0.0.1） | 任意设备（需访问密钥） |

---

## 三、 快速上手指南

### 1. 本地极简模式

```bash
cd <项目目录>
python serve.py
```

* 默认 `http://127.0.0.1:8788`，0.6s 后自动弹出浏览器。
* `--no-browser` 纯后台；`--port 9000` 换端口；`--allow-host x.com` 追加代理白名单。

### 2. 云端托管模式

任意设备浏览器打开你部署的 Worker 地址（形如 `https://<你的worker>.workers.dev`；该域名在部分网络需代理访问），在设置里填部署者提供的 **APP_ACCESS_KEY**。

### 3. 首次配置

**本地模式**（设置 → 本地模式区块）：
1. 填 **API Token**（nai.rinko.ai「控制台 → API Keys」，形如 `ynai-...`）——生图必需。
2. 用户名密码**登录**（余额/签到/报价用；仅保存登录令牌）。
3. 没有账号：[用邀请码注册立得 100 Gems](https://nai.rinko.ai/sign-up?aff=eImK)。

**云端模式**（设置 → 云端账号区块）：
1. 填访问密钥（APP_ACCESS_KEY）。
2. 「用户名 + 密码 → 添加并登录」收录账号，可加多个。
3. 给需要生图的账号点「填写生图Token」（ynai-…）。
4. 顶栏下拉切换当前生图账号。

---

## 四、 核心功能详解

### 1. 模型选择与免费档位
* 自动拉取模型列表：NAI 5 Full / NAI 5 Curated〔免费〕/ NAI 4.5〔免费〕/ v4 / v3。
* v3 模型自动显示 SMEA / SMEA DYN 开关；选 infill 自动切换 `-inpainting` 模型。

### 2. 参数控制与种子锁定（表情差分）
* 尺寸预设按 64 对齐；步数 / CFG / 张数 / 采样器 / 噪声调度。
* 固定 Seed + 相同参数 = 像素级一致；仅改表情词做差分立绘。
* **全部高级参数（结构化开关、SMEA、重绘幅度、附加 JSON）随历史/画廊一并保存与回填**。

### 3. 高级生图
* **v4/v5 结构化提示词**：包装为官方 Caption 结构。
* **图生图**：底图 + 重绘幅度（低=贴近原图）；可一键清除。
* **局部重绘**：底图 + 蒙版（白=重绘区）；与图生图同时存在时按局部重绘执行并提示。
* **附加 JSON**：直接合并进 parameters。

### 4. Gems 报价与余额
* 「报价」按当前账号预估本次消耗；免费模型显示 0。
* 顶栏宝石徽标 = 当前账号余额，点击刷新。

---

## 五、 多账号云端中转

* **添加账号**：设置 → 云端账号 → 用户名/密码 →「添加并登录」。Worker 用该密码登录站点取 JWT，密码与 JWT **AES-GCM 加密**存 D1（密钥由 APP_ACCESS_KEY 派生），任何 API 不回明文。
* **JWT 过期自动续**：签到遇 401 时用托管密码自动重登一次；仍失败标 `JWT过期`，在账号行更新密码即可恢复。
* **账号操作**：启/停用签到、刷新余额、补填/更换生图 Token、单账号测试签到、删除。
* **生图账号**：顶栏下拉选择；余额徽标、报价、一键签到都跟随当前账号。
* **汇总**：「刷新全部余额」显示每账号 Gems 与合计（多账号 = 多份每日签到收益）。

### 注册新账号 · 一键导入

设置面板的「注册新账号 · 一键导入」区块（本地模式与云端模式均可用），直接对当前上游站点操作：

* **注册新账号**：填写用户名（3-64 位字母数字 `._-`）与密码（至少 8 位）；站点开启邮箱验证时需填写邮箱并点「发送验证码」人工输入验证码（60 秒重发冷却）。点「注册并导入」后自动登录、新建一个 API Token（名为 `yesnai-studio-日期时间`，如 `yesnai-studio-202609291530`）并完成导入。
* **一键导入已有账号**：输入上游站点的用户名 + 密码，点「一键导入」——自动登录并新建 API Token；云端模式加入账户集合（走与手动「添加并登录」相同的 `/api/accounts`，密码 AES-GCM 加密托管、JWT 过期自动续期），本地模式写入本地账号（`localStorage` 的既有行为，密码仅本次请求使用不做保存）。新 Token 与手动在站点控制台创建的等价，可随时在上游站点吊销。
* **注意**：目标站点需开放注册（站点关闭注册时按钮禁用并提示）；公益站的注册规则与额度政策以站点公告为准。云端模式经 Worker 的 `/api/nai/relay` 中转访问上游站点 API（白名单仅放行 `/api/ynai/*` 与 `/api/user/checkin`），登录 JWT 仅本次请求内存透传，不落盘不打日志。

### 钱包 · 图包 · 签到

设置面板的「钱包 · 图包 · 签到」区块（本地模式与云端模式均可用），用上游站点账号（用户名或邮箱 + 密码）登录后查询余额、一键购买图包、每日签到领宝石：

* **登录态说明**：站点登录凭证（JWT）**仅保存在本页面内存中**，不写 localStorage、不落盘，页面刷新即失效，密码用后即弃不做保存。通过「一键导入」完成登录的账号会直接建立站点会话，无需重复登录；JWT 过期（上游返回 401）时自动回到登录态并提示重新登录。
* **多账号下拉**：区块顶部的「账号」下拉可选「当前会话（登录用户）」或账号池内任意账号。选择池账号时**无需站点登录**——云端 Worker 用该账号托管（AES-GCM 加密）的用户名密码向上游现登一次后代为查询/购买/签到（不缓存 JWT），账号缺少托管密码时会提示无法代登录；「当前会话」走上面的站点登录逻辑，两者互不影响。切换账号立即刷新余额、图包与签到状态。
* **购买图包**：填写包数（1-10000）后显示预计费用（共 N 包 · 预计 X Gems），点「一键购买图包」即从 Gems 余额扣除总价。购买成功后自动刷新余额与图包次数；余额不足（上游 402）或站点关闭图包时按钮禁用并给出提示。
* **余额不足的三条补救路径**（公益站不开放充值）：① 每日签到随机领 1-5 宝石；② 使用站点发放的兑换码；③ 联系站长发放。
* **图包适用范围**：图包次数用于**小尺寸文生图**；计费顺序为免费额度优先、图包次数其次，Gems 余额兜底。图生图（i2i）与局部重绘不走图包，按站点常规计费。
* **与自动签到的关系**：本区块是页面内的手动签到入口；云端 Cron 自动签到机（多账号时刻表、失败重试、JWT 自动续期）不受影响，两者相互独立。

---

## 六、 持久画廊（R2 / IndexedDB）

* 生成成功的图自动入库（设置里可关）：云端存 **R2**（`img/{id}` 原图 + `thumb/{id}` 前端 canvas 缩略图，D1 `gallery` 表只存元数据）；本地存 **IndexedDB**。刷新/换设备（云端）画廊都在。
* 缩略图网格分页加载（24/页，「加载更多」），点击看原图，支持下载（按上游真实格式 png/webp/jpeg 定扩展名）、「复现」完整参数、单张删除、「清空画廊」。
* 免费额度：R2 10GB 存储 + 图片走 Worker 中转不暴露桶。

---

## 七、 全自动签到机制

### 1. 时刻表（本地/云端一致）
* 工作日（周一~五）与周末（周六/日）各配多个时间槽，IANA 时区（默认 Asia/Shanghai）。
* Cron/守护线程每 5 分钟检查；**升序补签**——停机跨过的槽醒来后逐个补。
* 失败重试：30 分钟退避，**每槽最多 1+4 次**；换槽计数归零。
* 终态：401 → 自动重登（云端托管密码）→ 仍失败标 `jwt_expired` 停止；Turnstile 标 `manual_required` 提示去网页人工签，绝不绕过。

### 2. 本地模式
* `serve.py` 内置守护线程；配置与状态在 `autocheckin.json`（含登录令牌，仅本机；v1 旧格式自动迁移）。
* 「立即测试」无视时刻表立即签一次，成功才推进状态，不污染重试计数。

### 3. 云端模式
* 全部启用账号共用时刻表、各自独立签到/重试/状态；单账号故障不影响其余账号。
* 手动「立即测试」= 对全部启用账号各强制执行一次（带租约防并发）。

### 4. 自动购买图包（云端 · 默认关闭）
* 设置 → 自动签到里开启「自动购买图包」并设定阈值（1-10000 的整数，默认 8）。开启后，云端 Cron 每次对某账号签到完成（无论成功或失败）都会用该账号身份检查一次图包状态：**图包次数低于阈值且 Gems 余额足够 1 包**时，自动购买 1 个图包。
* 跳过与失败均记录原因、不做重试、不影响签到主流程：站点关闭图包 / 次数未低于阈值 / 余额不足 → 跳过；查询或购买请求失败 → 记录失败原因。
* 每次结果（买了/没买原因/失败原因）写入 D1 `autocheckin_logs`（`slot` 为 `autobuy`），可用 `SELECT * FROM autocheckin_logs WHERE slot='autobuy' ORDER BY id DESC LIMIT 20` 查看。

---

## 八、 Cloudflare 云端部署与运维

### 1. 核心文件
* `wrangler.jsonc`：Worker、D1、**R2（yesnai-gallery）**、Cron、静态 assets 绑定。
* `worker/index.ts`：路由 / 调度 / 凭据加密 / R2 画廊。
* `migrations/0001_single_account.sql`：accounts + 签到配置/日志 + gallery 元数据。
* `public/`：前端 + `_headers`（静态资源安全头）。

### 2. 部署命令
```bash
npx wrangler d1 create yesnai-studio      # database_id 填入 wrangler.jsonc
npx wrangler r2 bucket create yesnai-gallery
npx wrangler d1 migrations apply yesnai-studio --remote
npx wrangler secret put YESNAI_JWT         # 首账号引导（之后网页里加更多账号）
npx wrangler secret put YESNAI_API_TOKEN
npx wrangler secret put APP_ACCESS_KEY     # 必设：访问密钥 + 凭据加密密钥
npx wrangler deploy
```

曾部署过旧版本时先重置 D1（DROP 全表 + 清空 d1_migrations，命令见 README）再 apply。

### 3. 日常运维
```bash
npx wrangler d1 execute yesnai-studio --remote --command "SELECT id,label,status,last_message,gems_last FROM accounts"
npx wrangler d1 execute yesnai-studio --remote --command "SELECT * FROM autocheckin_logs ORDER BY id DESC LIMIT 10"
npx wrangler tail --format pretty          # 观察 cron 与 API 实时日志
npx wrangler deploy                        # 更新部署
```

---

## 九、 接口与底层代理协议

| 功能 | 本地代理路径 | 云端 Worker 路由 | 上游端点 | 鉴权 |
| :--- | :--- | :--- | :--- | :--- |
| 生图 | `/p/v1/nai/generate-image` | `/api/yesnai/generate` | `POST /v1/nai/generate-image` | API Token（Bearer） |
| 模型列表 | `/p/v1/models` | `/api/yesnai/models` | `GET /v1/models` | 无 |
| 报价 | `/p/api/ynai/playground/quote` | `/api/yesnai/quote` | `POST /api/ynai/playground/quote` | 登录 JWT |
| 余额 | `/p/api/ynai/user/balance` | `/api/yesnai/balance` | `GET /api/ynai/user/balance` | 登录 JWT |
| 签到 | `/p/api/user/checkin` | `/api/yesnai/checkin` | `POST /api/user/checkin` | 登录 JWT |
| 登录 | `/p/api/ynai/auth/login` | `/api/accounts`（收录） | `POST /api/ynai/auth/login` | 用户名/密码 |
| 画廊 | — | `/api/gallery*` | R2 / D1 | X-Access-Key |

云端另按 `X-Account-Id` 头选择账号（缺省第一个启用账号）。

---

## 十、 常见问题与排错 (FAQ)

#### Q1: 生图提示 Unauthorized？
> 本地：设置里换新 API Token。云端：该账号行「填写生图Token」（ynai-…），或切换到已配 Token 的账号。

#### Q2: 报价/余额失败？
> 走登录 JWT。本地重新登录；云端账号 JWT 过期会自动续，仍失败就在账号行更新一次密码。

#### Q3: 部分模型报价 0 Gems？
> NAI 4.5 系列与 NAI 5 Curated 有免费档，0 属正常。

#### Q4: 刷新网页后图片还在吗？
> 在。云端存 R2（换设备也在），本地存 IndexedDB（同浏览器同域）。

#### Q5: workers.dev 打不开？
> `*.workers.dev` 在部分网络被屏蔽，需代理访问；不影响 Cloudflare 侧 Cron 签到与生图中转。

#### Q6: 签到显示「需人工验证」？
> 站点对签到开了 Turnstile，自动签到无法通过；当天请到网页手动签，次日自动恢复。

#### Q7: 想让朋友用自己的账号？
> 在设置里为朋友单独创建一个 `yst-` 分发密钥（可限制模型、步数、每日 Gems），把 Worker 地址 + 分发密钥给对方即可。**不要把 APP_ACCESS_KEY 发给任何人**——它是管理员密钥（可通过中转接口以池内任意账号身份调用上游，包括新建 Token、购买图包），同时也是账号凭据的加密盐：一旦更换，已托管的所有账号密码将无法解密。
