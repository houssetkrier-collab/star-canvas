# 星彩绘图台 · 多账号 NAI 云端绘图工具

上游公益站（nai.rinko.ai）的个人绘图台：**多账号云端中转 + 持久画廊 + 全自动签到**。

- **云端**：Worker + D1 + R2 + Cron。多个上游账号在网页里添加（密码 AES-GCM 加密托管，JWT 过期自动重登续期），生图/余额/签到按顶栏所选账号走，全部账号共用一份签到时刻表、各自独立重试。
- **提示词生产工具**：画师串工作台支持本地画师补全、自建词库、未知/重复/权重状态提示、预设单画师追加、结构化 AI 建议与撤销；主提示词提供 TAG 流编辑器（分段、权重、句子、拖拽、撤销重做）；中文转换支持 NAI V5/V4.5 版本模式和替换/追加/复制/送入编辑器；PNG 导入支持元数据预览确认。

## 提示词工作台增强（2026-08-30）

本版吸收了公开提示词工具的可复用设计：画师串本地自动补全与自建词库、未知/重复/权重状态标记、预设单画师追加、结构化 AI 建议、主提示词 TAG 流编辑器、NAI V5/V4.5 版本选择、PNG 参数预览确认导入。AI 只提供可采纳建议，不会自动触发生成。详见 `THIRD_PARTY_NOTICES.md`。

## 启动（本地模式）

```
python serve.py
```

浏览器自动打开 http://127.0.0.1:8788 （换端口 `--port 9000`；不开浏览器 `--no-browser`）。

## 首次使用（本地）

1. 右上角「设置」→ 本地模式区块。
2. 填 **API Token**：nai.rinko.ai「控制台 → API Keys」创建，形如 `ynai-...`（生图必需）。
3. 余额 / 签到 / 报价需要**用户名密码登录**（本地仅保存登录令牌）。
4. 没有账号：[用邀请码注册立得 100 Gems](https://nai.rinko.ai/sign-up?aff=eImK)。

## 功能

- 生图：NAI 5 / 4.5 / v4 / v3 全模型（自动拉取 `/v1/models`），14 种采样器、噪声调度、种子固定像素级复现
- 高级：v4/v5 结构化提示词、v3 SMEA、附加 parameters JSON、图生图、局部重绘（自动切换 -inpainting 模型），全部参数（含高级项）持久化并可一键复现
- **持久画廊**：生成的图自动入库——云端存 R2（原图 + 前端生成缩略图，D1 只存元数据），本地存浏览器 IndexedDB；分页加载、放大、下载（按真实格式定扩展名）、删除、清空
- **多账号中转（云端）**：顶栏「👥 账户」打开**账户集合面板**（合计 Gems / 今日已签 X/Y / 每账号卡片操作）；支持**批量导入**（粘贴 `账号----密码` 列表，兼容 `:` `,` 空格分隔，一次 ≤30）；生图账号可选**自动（轮询）**——多账号额度集合，按次在启用且已配 Token 的账号间轮转分摊；JWT 过期自动用托管密码重登
- **注册新账号 · 一键导入**：设置面板内向当前上游站点直接注册账号（邮箱验证码人工输入），或用已有账号「用户名 + 密码」一键导入——自动登录、自动新建 API Token 并加入账户集合（云端）/ 本地账号；云端模式与手动添加账号一致（密码加密托管，JWT 过期自动续），本地模式密码仅本次请求使用不保存
- **钱包 · 图包 · 签到**：用站点账号（用户名或邮箱）登录后查询 Gems 余额，一键购买图包（1-10000 包，费用实时联动）、每日签到领宝石；登录凭证仅存页面内存（刷新即失效、不落盘），余额不足时禁用购买并提示补救路径（签到 / 兑换码 / 站长发放）
- **自动签到**：工作日/周末多时间槽 × 时区（IANA）；补签错过的槽；失败重试 30 分钟退避、每槽最多 1+4 次；401→自动重登→仍失败标 `jwt_expired`；Turnstile 标 `manual_required` 提示人工，绝不绕过
- 报价 / 余额 / 一键签到；历史记录只存参数（localStorage）
- **中文智能提示词**：输入中文画面描述后，在设置中配置 OpenAI 兼容 Prompt API，即可一键转换为英文 NovelAI/booru Tags；当前版本未配置外部 API 时不会自动使用内置词典回退。
- **对外接入（new-api 式）**：`POST /v1/images/generations`、`POST /v1/chat/completions`、`GET /v1/models`；支持 `yst-` 分发密钥、中文自动转 Tag 与账号池轮询

## 本地模式说明

前端启动探测 `/api/session`：serve.py 返回 404 → 自动切本地模式（`/p/*` 代理 + 本地登录 + IndexedDB 画廊）。本地签到配置在 `autocheckin.json`，本地中文提示词 API 配置在 `prompt_api.json`（两个文件都可能包含敏感凭据，勿分发）。设置中点击「中文转 NAI 提示词」即可调用已配置的 Prompt API；当前版本未配置时会提示尚未配置。

## 一键部署到 Cloudflare（推荐）

只需要装好 [Node.js](https://nodejs.org)（LTS 版）和一个 Cloudflare 账号：

- **Windows**：双击仓库里的 `deploy.bat`
- **macOS / Linux**：终端运行 `./deploy.sh`

脚本会一步步带你完成：登录 Cloudflare（自动打开浏览器授权）→ 选择或新建 D1 数据库和 R2 存储桶 → 备份线上数据库 → 执行数据库迁移 → 首次自动生成访问密钥 → 发布 → 自检。已有线上 Worker 时填它的名字，脚本会自动识别它正在用的数据库和存储桶并原地更新。

- 选择只需要做一次，之后**再双击一次 `deploy.bat` 就是更新**（或 `node tools/deploy.mjs --yes` 全程不提问）；要改 Worker 名、数据库、域名等用 `node tools/deploy.mjs --reconfigure`。
- 访问密钥首次生成后保存在 `.deploy/APP_ACCESS_KEY.txt`；每次更新前的数据库备份在 `.deploy/backups/`。`.deploy/` 和生成的 `wrangler.deploy.jsonc` 已加入 `.gitignore`。
- 第一次用 R2 需要先在 Cloudflare 后台「R2 对象存储」点一次「开始使用」（免费额度内不收费），脚本检测到没开通会提示。
- 自定义域名需要已托管在同一个 Cloudflare 账号；如果这个域名正被另一个 Worker 使用，先在后台把它从旧 Worker 上删掉。

### 一键更新（跟进原作者的新版本）

- **Windows**：双击 `update.bat`；**macOS / Linux**：`./update.sh`（需要装有 [Git](https://git-scm.com)）

它会：自动保存你改过的文件 → 从原作者 GitHub 拉取新版本 → 列出新提交让你确认 → 合并（保留本地的修改）→ 部署（新的数据库迁移会在备份后自动执行）。

- 合并前会打一个备份标签；**和本地修改冲突时自动放弃合并**，代码和线上都保持原样，把输出发给维护者处理即可。
- 更新后发现问题：`node tools/update.mjs --rollback` 回到更新前的代码并重新部署（数据库新加的表 / 字段会保留，不影响旧代码运行）。
- 国内访问 GitHub 失败时，给 git 配上代理：`git config --global http.proxy http://127.0.0.1:端口`。

下面是手动部署的步骤，供需要细节时参考。

## Cloudflare 部署（手动 · 多账号 + R2 画廊）

文件结构：`public/`（前端 + `_headers` 安全头）、`worker/index.ts`（路由/调度/加密）、`migrations/`（`0001`–`0014` 全部 D1 迁移）、`wrangler.jsonc`。

> `wrangler.jsonc` 里的 `database_id` 是原作者账号下的库，部署到你自己的账号前，先用第 1 步建库并替换成你的 ID。
>
> **已部署过、只是升级代码**：先 `npx wrangler d1 migrations apply yesnai-studio --remote`（会补上 `0012`–`0014` 等新迁移），再 `npx wrangler deploy`。

```bash
# 1. 建库与桶（database_id 填入 wrangler.jsonc）
npx wrangler d1 create yesnai-studio
npx wrangler r2 bucket create yesnai-gallery

# 2. 建表
npx wrangler d1 migrations apply yesnai-studio --remote

# 3. Secrets：YESNAI_JWT / YESNAI_API_TOKEN 会引导成第一个账号（主账号）；
#    之后在网页设置里添加其余账号即可。APP_ACCESS_KEY 必设——既是访问密钥，
#    也是账号凭据的加密密钥（不设则凭据明文落库）。
npx wrangler secret put YESNAI_JWT
npx wrangler secret put YESNAI_API_TOKEN
npx wrangler secret put APP_ACCESS_KEY

# 4. 发布
npx wrangler deploy
```

设置 `APP_ACCESS_KEY` 后，除 `GET /api/session` 外所有 API 都要求 `X-Access-Key` 头（网页设置里填同一密钥）。凭据（JWT/密码/API Token）AES-GCM 加密存 D1 `accounts` 表，密钥由 `APP_ACCESS_KEY` 派生，任何 API 响应都不返回明文。不要把凭据写进 `vars`、HTML、localStorage 或日志。

**日志保留**：Cron 每次运行会分批清理超过保留期的请求日志、重试记录、签到日志（默认 30 天，`wrangler.jsonc` 的 `vars` 里加 `"LOG_RETENTION_DAYS": "60"` 可调），每日用量至少保留 90 天。

**旧库重置**（曾部署过多用户版 / 旧单账号版时，先执行再 apply，否则签到接口会 500）：

```bash
npx wrangler d1 execute yesnai-studio --remote --command "DROP TABLE IF EXISTS accounts; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS credentials; DROP TABLE IF EXISTS autocheckin_settings; DROP TABLE IF EXISTS autocheckin_config; DROP TABLE IF EXISTS autocheckin_logs; DROP TABLE IF EXISTS gallery; DELETE FROM d1_migrations;"
npx wrangler d1 migrations apply yesnai-studio --remote
```

## 统一密钥外部网关（多账号 = 一个密钥）

Worker 对外提供 NAI 兼容接口，凭 **APP_ACCESS_KEY**（或 `yst-` 分发密钥）当"一个 NAI 账号"用；内部按轮询顺序在账号池里选号，401/402/429/5xx 自动换下一个候选直到试遍整个池，实际服务账号写在响应头 `X-Ynai-Account`（URL 编码，账号名可能是中文）：

```bash
BASE="https://<你的worker>.workers.dev"
KEY="<APP_ACCESS_KEY>"

# 模型列表（需 Gateway/访问密钥）
curl -H "Authorization: Bearer $KEY" $BASE/v1/models

# 生图（body 与 nai.rinko.ai /v1/nai/generate-image 完全一致）
curl -X POST $BASE/v1/nai/generate-image \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"nai-diffusion-4-5-curated","action":"generate","input":"1girl, smile","parameters":{"width":832,"height":1216,"steps":28,"n_samples":1,"scale":5,"seed":0,"sampler":"k_euler","noise_schedule":"karras"}}'

# 账号池余额总览
curl -H "Authorization: Bearer $KEY" $BASE/v1/balance
```

任何支持自定义 base URL 的工具把地址指到 Worker、密钥填 APP_ACCESS_KEY 即可。给别人用请发 `yst-` 分发密钥（可设模型白名单、参数上限、每日配额、并发），**不要发 APP_ACCESS_KEY**——它是站长全权密钥，也是账号凭据的加密密钥。`/v1/nai/generate-image`、`/v1/images/generations`、`/v1/chat/completions`、`GET /generate` 四个入口共用同一套密钥、策略、配额与用量日志。签到 Cron 已做错峰（账号顺序打散 + 每账号 3~8 秒随机间隔）。

## 免费计划（Workers Free）说明

项目按 Cloudflare 免费计划的限制设计，几个关键点：

- **每次调用最多 50 个子请求**（D1 查询、R2 操作、对外 fetch 合计）。实测每个账号签到约 5 个、加自动买图包约 8 个，所以定时签到每轮只处理 4~7 个账号，剩下的由 5 分钟后的下一轮继续（已签到的不会重复）；批量导入、刷新全部余额、全部立即测试也都分批执行，前端自动续传。账号再多也不会因为超限而在中途集体报错。
- **每次调用 10ms CPU**：网关生图不再整段解析几 MB 的图片 JSON 来读取 `cost_gems`，改为边转发边在字节流里扫描（2.7MB 响应约 1ms，原来约 4ms），扣费统计与日志放在响应发出后的后台任务里；`/generate` 直链用原生 `Uint8Array.fromBase64` 解码。
- **D1 每天 500 万行读取**：统计页读按天汇总表（迁移 `0014`），一个月 3 万条请求日志时打开统计页从约 18 万行降到约 500 行；日志、画廊、广场翻页不再每次数总数；广场「最热」排序走索引；广场列表在边缘缓存（需自定义域名，`workers.dev` 上不生效），发布 / 撤回 / 点赞会立刻刷新缓存，只有浏览数最多滞后 5 分钟。
- **R2 免费 10 GB**：画廊顶部显示已用空间。

## Worker API 一览

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/session` | GET | 模式探测：configured / 账号数 / 是否需要密钥（不鉴权、不触库） |
| `/api/accounts` | GET/POST | 账号列表 / 用账号密码登录并收录 |
| `/api/accounts/batch` | POST | 批量导入 `{items:[{username,password}]}`（逐个登录，单条失败不中断；每次最多处理 8 个，其余放在 `remaining` 里返回，再发一次即可） |
| `/api/accounts/{id}` | PATCH/DELETE | 改 label、启停、补填 api_token、更新密码并重登 / 删除 |
| `/api/accounts/{id}/balance` | GET | 单账号余额 |
| `/api/accounts/{id}/test` | POST | 单账号手动签到 |
| `/api/accounts/refresh_gems` | POST | 刷新全部余额（每次 15 个，`{offset}` 续传，返回 `next_offset`，为 null 表示刷完） |
| `/api/autocheckin/settings` | GET/PATCH | 签到时刻表（时区校验、非法 400） |
| `/api/autocheckin/test` | POST | 全账号手动签到（无到点槽也强制执行；每次 6 个，`{offset}` 续传，返回 `next_offset`） |
| `/api/yesnai/{models,generate,quote,balance,checkin}` | * | 按请求头 `X-Account-Id`（缺省第一个启用账号）代理上游 |
| `/api/gallery` | GET/POST | 画廊元数据分页（返回 `has_more`；`total` 与 `storage_bytes` 只在 offset=0 时给出）/ 上传（原图+缩略图+元数据） |
| `/api/gallery/i/{id}?t=img\|thumb` | GET | R2 图片输出（immutable 缓存） |
| `/api/gallery/{id}` | DELETE | 删图（R2 两对象 + D1 行） |
| `/api/gallery/clear` | POST | 清空（需 `{confirm:true}`） |
| `/api/stats` · `/api/logs` | GET | 统计（读按天汇总表）/ 请求日志（返回 `has_more`，`?total=1` 才数总数） |

除 `/api/session` 外全部要求 `X-Access-Key`；写操作另做 Origin 校验。

## 站点接口要点（详见 `_rev/api_docs_blocks.txt`，本地逆向产物不分发）

| 用途 | 端点 | 认证 |
|---|---|---|
| 生图 | `POST /v1/nai/generate-image` | API Token（`Authorization: Bearer ynai-...`） |
| 模型列表 | `GET /v1/models` | 无 |
| 报价 | `POST /api/ynai/playground/quote` | 登录 JWT |
| 余额 | `GET /api/ynai/user/balance` | 登录 JWT |
| 签到 | `POST /api/user/checkin` | 登录 JWT |
| 登录 | `POST /api/ynai/auth/login` | 用户名/密码 |

注意：文档页的 `/ai/generate-image/quote`（API Token 版报价）本站未启用（405），报价走登录 JWT 版。
