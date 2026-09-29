# 更新日志

## 20260930 · 注册导入 / 钱包图包签到 / 多账号钱包 / 自动购买 / RP-Hub 联动

### 新增

- **注册新账号 · 一键导入**（设置面板）：直接向当前上游站点注册账号（邮箱验证码向导，60 秒重发冷却），注册成功自动登录、自动创建 API Token 并加入账户集合；已有账号可用「用户名 + 密码」一键导入。云端模式经 Worker 中转路由 `/api/nai/relay`，本地模式走 `serve.py` 反代直连。
- **钱包 · 图包 · 签到**（设置面板）：展示上游站点 Gems 余额、图包次数、图包单价与免费额度窗口；一键每日签到（奖励随机 1–5 Gems）；一键购买图包（1–10000 包，实时费用预估）。购买前本地预检余额，不足时禁用按钮并给出差额与补救提示；上游 402 原样透传。
- **钱包多账号**：钱包面板新增账号下拉（「当前会话」+ 账户池全部账号）。选中池内账号时由 Worker 用该账号托管凭据代登录上游（`X-Account-Id`），查余额 / 签到 / 购买均按所选账号执行，无需重复输入密码。
- **自动购买图包**（云端 · 默认关闭）：自动签到机每账号签到完成后，检查「图包次数 < 阈值（默认 8 张）且 Gems 足够一包价」则自动补购 1 包；开关与阈值在自动签到设置中配置，购买记录写入 `autocheckin_logs`（slot=`autobuy`）。迁移：`0011_auto_buy.sql`（`autocheckin_config` 增加 `autobuy_enabled` / `autobuy_threshold`）。
- **网关中转路由** `POST /api/nai/relay`（内部）：供前端注册 / 导入 / 钱包 / 签到调用上游业务 API。带路径白名单（`/api/ynai/*` 与 `/api/user/checkin`）、URL 规范化防 `../` 与百分号编码绕过、64KB 请求体双上限、方法白名单；支持 JWT 直传与 `X-Account-Id` 账号代登录两种模式。

### 修复

- **网关生图全 401 的存量 bug**：`yesnaiFetch` 使用 `{ ...(init.headers || {}) }` 展开 `RequestInit.headers`，当传入的是 `Headers` 实例（网关生成路径 `gatewayGenerate` 正是如此）时展开结果为空对象，转发给上游的请求丢失 `Authorization` 头，恒定 401。现对 `Headers` 实例做 `Object.fromEntries(entries())` 归一，网关生图链路实测恢复 200。此前该路径从未成功过。
- `wrangler.jsonc` 校正 D1 `database_id` 为当前账号实际资源。

### RP-Hub 魔改版联动（已实测打通）

RP-Hub（rph-r2 魔改版）的生图前端与代理原生识别 `YST-` 前缀密钥（provider `yst`），代理端以 OpenAI Images 兼容格式调用本工作台（`POST /v1/images/generations`，`b64_json`）。接入只需两步：

1. 本工作台「设置 → 分发密钥」创建一个 `yst-` 密钥，策略建议：
   - `parameter_mode: fixed` + `fixed_parameters: {"steps": 28}`——RP-Hub 生图默认 40 步，超出免费档（≤28 步）会按全价计费；服务端钉 28 后全程命中免费标准渲染（0 Gems）。
   - **不要同时设置 `limits.steps.max`**：策略限制在固定参数改写之前检查原始请求，RP-Hub 的 40 步会直接被拒（403）。
   - 模型白名单按需（如 `nai-diffusion-4-5-full` / `nai-diffusion-5-full`）。
2. RP-Hub 代理 `_worker.js` 中 `IMAGE_YESNAI_BASE` 指向本工作台地址，重新部署。

实测结论：`/api/rp-image`（provider=yst，模拟 RP-Hub 默认 40 步请求）→ 网关钉 28 → 账户池轮询 → rinko，返回 PNG、`cost_gems=0`（免费档）；同参数二次查询 `x-rp-image-cache: HIT`，固定生图缓存正常。RP-Hub 自动更新不受影响（`_worker.js` 在其更新保护清单内）。

### 注意

- 更换 `APP_ACCESS_KEY` 会使已存账号的加密凭据失效（凭据加密密钥由其派生），需重新导入账号或补填 API Token。
- 上游登录响应存在 `{access_token}` 与 `{message, data:{access_token}}` 两种形状，本版已做双形状兼容（登录 / 建Token / 图包 / 签到读取处）。
