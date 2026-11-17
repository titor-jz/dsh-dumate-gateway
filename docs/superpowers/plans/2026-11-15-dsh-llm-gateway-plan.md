# dsh-llm-gateway 实施计划

- 日期：2026-11-15
- 状态：**P1–P6 代码全部就位 + 模型列表已筛选 + 面板图表版重设计已实测**（2026-11-16 14:55）——插件可装；A 面转发与真流式经真机 e2e 通过；P5 网关有离线测试；P6 面板走 host 同源路由，并在浏览器里真实点击验证（16 models、试聊 `first token 1.8 s / total 2.4 s / in 36 / out 64`、用量行同步 +1）。P0 探针 3/3 真机闭环，结论见 `docs/superpowers/notes/2026-11-15-probes.md`；进度见 §12（P1–P4）、§13（P5）、§14（P6）、§15（筛选）、§16（面板增强）、§17（图表版重设计）
- 设计依据：`docs/superpowers/specs/2026-11-15-dsh-llm-gateway-design.md`
- 执行前提：用户 2026-11-15 22:16 回「继续」后开工，此后按「继续推进」处理

## 0. 计划总览

| 阶段 | 产出 | 依赖 | 预计 |
|---|---|---|---|
| P0 探针 | 三个不确定点的实测答案 | 无 | 0.5 天 |
| P1 骨架 | 能装、能显示 1 个真模型、能对话 | P0-V1 | 0.5 天 |
| P2 发现 | 自动扫到本机 OpenAI 兼容服务，元数据正确 | P1 | 1 天 |
| P3 转发 | 流式对话 e2e 通 | P2 | 0.5 天 |
| P4 DuMate | A 面 1:1 代理 + 真流式 | P3 + 已装 DuMate（启动即可） | 0.5 天 |
| P5 HTTP 网关 | curl / Claude Code 可用 | P3 | 0.5 天 |
| P6 侧栏 | 面板可视化 | P2 | 1 天 |
| P7 发布 | README/GIF/npm | P4-P6 | 0.5 天 |

每个阶段结束都要能被用户「看得见」地验证一次，不能憋到最后一起来。

## 1. 阶段 P0：三个探针（先验证，再承诺）

这三件事决定 M2 是否要改设计，必须在写实现前拿到答案。每个探针都是一次性脚本，放在 `_research/probes/`，不进仓库。

- **V1：DSH client 插件的侧栏注册方式**（决定 P6 是否可做）
  - 读 `D:\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-client-ui-sidebar-right\README.md` 与 `lib/index.d.ts`。
  - 写一个 20 行的空面板插件，装进 profile，确认 Web GUI 右侧出现入口。
  - 失败退路：v1 不做侧栏，改在设置页加只读状态区块。
- **V2：DuMate 是否提供 `/event` 流式**（决定「真流式」还是「伪流式」）
  - 前置：DuMate 1.0.92 已装（`D:\DuMate`），启动即可（见 §7.1）；B 面需 `DUMATE_INAPP_KEY`。
  - 建 session → 发消息 → 同时 `GET /event` 观察是否收到增量事件；记录事件形状。
  - 失败退路：伪流式（设计 7.2 已写），README 如实标注。
- **V3：DuMate 是否支持按 modelID 选模型**
  - 在 `/session/{id}/message` 的 body 里试 `model:{providerID:'QianfanPersonalQuota', modelID:'glm-5'}`，对比不加时的实际模型。
  - 判据：返回的 message 里是否带真实 model 字段，或行为是否随 modelID 改变。
  - 失败退路：降级 3 档（L0/L1/L2）+ badge「3档」。

**P0 出口**：三个答案写进 `docs/superpowers/notes/2026-11-15-probes.md`，若结论与设计冲突，先改 spec 再继续。

**P0 实际结果（2026-11-15 晚，全部真机闭环）**：V1 **通过**（侧栏契约由 4 个自带包 client.js 实证，回填 spec §10.1）；V2/V3 **真机确认**（DuMate 1.0.92 启动后实测：A 面真 SSE、chat 无需 key、`glm-5`/`model-text` 均可用、`/models` 404）。另有两项外部变化：npm 名 `dsh-llm-gateway` 已被占用（改 `dsh-dumate-gateway`）、ZCode 反代被上游风控封锁。**代码仍未开始。**

## 2. 阶段 P1：骨架（M1 第一步）

目标：`npx --yes dsh-dumate-gateway install` 后重启 DSH，模型选择器里出现 `gateway/hello`，发消息能拿到一句固定回复。

- **T1.1 仓库骨架**
  - 文件：`package.json`、`cordis.patch.yml`、`index.js`、`src/adapter.js`、`src/settings.js`、`README.md`、`LICENSE`。
  - `package.json`：`name: dsh-dumate-gateway`（用户要求名字带 DuMate；2026-11-15 查 npm 与 npmmirror 均 404 可用；原 `dsh-llm-gateway` 已被第三方 0.0.1 占用）、`type: module`、`engines.node >= 22`、`dsh.bundle.patch: ./cordis.patch.yml`、`bin: {dsh-dumate-gateway: ./cli.js}`、**零 dependencies**；client 半区另需 `dsh.client = {platform:'web', inject:['@deepseek-ai/dsh-client-ui-sidebar-right']}` 与 `exports['./client']`（契约见 spec §10.1）。
  - `cordis.patch.yml`：只 `insert` 自己的插件，禁止 `disabled: true` 别的插件。
  - 验证：`node -e "import('./index.js')"` 能加载。
- **T1.2 最小 adapter**
  - `LlmAdapter` 子类：`listModels('gateway')` 返回 1 个假模型；`resolveModel` 返回 `{contextWindow: 131072, defaultMaxTokens: 8192}`；`stream()` 产出 3 个 chunk + `finish`。
  - 验证：单元测试断言 chunk 序列与终止 chunk。
- **T1.3 install 命令**
  - `cli.js install`：把当前包目录作为 bundle 注册进 `$DSH_HOME/profiles/<profile>/`（复用 `plugin_manager` 的 install_bundle 语义；先读 `plugin-development.md` 确认写 profile 的正确方式，不要手改 package.json）。
  - 验证：装完重启 → 选择器出现 `gateway/hello` → 发「1+1」收到流式输出。
- **P1 出口**：用户亲眼看到选择器里的新模型并收到流式回复。

**P1 进展（2026-11-15 深夜）**：T1.1/T1.2 完成（`package.json` + `cordis.patch.yml` + `index.js` + `src/adapter.js`，零依赖、鸭子类型 adapter、node 冒烟通过）；T1.3 的 `cli.js install` **不做**——`dsh-doc` 的 `plugin-development.md` 明确禁止手写 profile，受支持路径是 GUI「Plugins → Add plugin」或 `plugin_manager install_bundle`，已用后者装进 desktop profile（`restart-required`）。等重启后做 P1 出口验证。

## 3. 阶段 P2：发现

- **T2.1 registry**（纯函数，先测后接网络）
  - `src/registry.js`：上游增删、模型 id 生成 `<upstream>/<model>`、冲突检测（同名不同上游后缀 `-2`）、变更事件。
  - 测试：模型 id 唯一性、重复发现去重、删除上游连带模型。
- **T2.2 discovery**
  - `src/discovery.js`：端口表 → 并发 TCP 探测（8 路，300 ms）→ `GET /v1/models`（1.5 s，不带凭据）→ 指纹判定 → 命名（端口映射表 → Server 头 → `local-<port>`）。
  - 测试：用 `node:http` 起假上游覆盖 200/畸形 JSON/500/超时/非 JSON；断言超时不会挂住整体扫描。
- **T2.3 元数据合并**
  - `src/catalog/known-models.json`：内置 glm/deepseek/qwen/kimi/doubao 的窗口与输出上限（数据来源标注在文件注释）。
  - `src/model-meta.js`：按优先级合并，缺省不猜。
  - 测试：三组用例（探测有字段 / 探测无字段但命中表 / 都没有 → 保守默认）。
- **T2.4 健康轮询**
  - `src/health.js`：30 s 一轮、2 s 超时、连续 2 次失败 offline、一次成功 online 并记延迟；状态迁移时 `emit('llm/models-updated','gateway')`（事件名按 DSH 0.2.2 实际 API 校准）。
  - 测试：假上游先 200 后 500 两次，断言状态与事件次数。
- **T2.5 接进 adapter**
  - `listModels` 来自 registry（带 badge：offline→`{text:'离线',tone:'warning'}`）；`resolveModel` 来自合并后的元数据。
  - **P2 出口**：本机在跑的 OpenAI 兼容服务被自动发现（假上游 + Ollama 11434；**不再用 8080 的 ZCode**，它已被风控封锁），选择器出现对应 `gateway/<upstream>/<model>`，元数据与手写 provider 一致。

## 4. 阶段 P3：转发（假上游 + Ollama）

- **T3.1 openai upstream**
  - `src/upstreams/openai.js`：`chat()` 转发 `/v1/chat/completions`，`stream:true` 解析 SSE（跨 chunk 分包、`[DONE]`、`usage`、tool_calls 原样透传）。
  - 测试：SSE 解析器单测（含一行被拆成三段的情况）+ 假上游集成测试。
- **T3.2 router**
  - `src/router.js`：model id → upstream；错误分类映射到 `LlmError` 码（401/403→AUTH、429→RATE_LIMIT、超时→HTTP_504、连不上→NO_ADAPTER）。
  - 测试：错误映射表逐条断言。
- **T3.3 e2e**
  - 先对假上游（可控 SSE，逐字延迟 50 ms）跑通，再选本机 Ollama 一类真实条目发一句话，观察 token 增量出现（不是最后一坨）。**不请求 ZCode。**
  - **P3 出口**：流式可见、取消可用（点停止后上游请求被中断，日志里能看到 abort）。

## 5. 阶段 P4：DuMate 接入（A 面 1:1 代理，0.5 天）

**2026-11-15 晚重写**：DuMate 1.0.92 已装在 `D:\DuMate`，其内置后端 `dumate-main-server.exe` 直接提供 OpenAI 兼容的 `/api/qianfanproxy/v1/chat/completions`（含 SSE），所以 P4 从「会话映射 + 伪流式」缩成「发现端口/key + 1:1 转发」。原 B 面（opencode `/session/*`）整体移出 v1。

- **T4.0 真机复验（✅ 2026-11-15 22:10 已跑完，原始证据见 notes）**
  - 结论：后端 `:52912`（由 live opencode.json 的 baseURL 得到）；chat **真 SSE**（8 chunk/434 ms，`delta.reasoning_content`→`delta.content`，末帧 `usage`，`[DONE]`）；非流式标准 `chat.completion`；`glm-5` 与 `model-text` 都 200、provider 前缀 404 `invalid_model`；**chat 无需 inapp key**（回环放行）；`/global/health` 带 key 仍 401；`/api/qianfanproxy/v1/models` 404。
  - 因此 T4.3/T4.4 不再有分支，按下面直接实现。
- **T4.1 地址 / key 发现**
  - `src/upstreams/dumate/auth.js`：**主源** = live `%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\*\config\opencode\opencode.json` 的 `baseURL`（DuMate 启动时写入真实端口，本次 `:52912`）；`DUMATE_HOST_URL` 覆盖；`config.yml` 默认 8980 兜底；**不用 52795**。
  - key **可选**（chat 实测不需要）：`process.env.DUMATE_INAPP_KEY` → `%APPDATA%\qianfan-desktop-app\log\electron.log` 的 `DUMATE_INAPP_KEY: '<hex>'` → 进程 PEB（PowerShell + P/Invoke，超时 3 s、静默失败）；拿到才带 `X-Dumate-Inapp-Key`，拿不到照常转发。
  - 在线判定：**TCP connect 到 backendPort**（不要打 `/global/health`）。
  - 测试：mock 文件层与进程层，验证优先级、文件缺失回退、缓存过期。
- **T4.2 client（A 面）**
  - `src/upstreams/dumate/proxy.js`：`POST {baseURL}/chat/completions`（`baseURL` 已含 `/v1`），body 原样透传（`model`/`messages`/`stream`/`max_tokens`/tools）；有 key 才加 `X-Dumate-Inapp-Key` 与 `X-Dumate-Prd-Source: personal`。
  - `stream:true` → 把上游 SSE 字节流交给 T3.1 解析器（**必须兼容 `delta.reasoning_content`、空 `content:""` 帧与 `[DONE]`**），不重写解析。
  - 取消：`AbortSignal` → 关连接；README 标注「后端是否停止生成未证」。
  - 错误：`404 {"error":{"code":"invalid_model"}}` → `MODEL_NOT_FOUND`；其余按 spec §7.6 映射；`credits_exhausted` / `user.quota.exhausted` → `QUOTA`（未触发，按文案兜底）。
- **T4.3 模型元数据**
  - 读同一份 opencode.json 的 `provider.QianfanPersonalQuota.models`：窗口 `limit.input ?? limit.context`、输出 `limit.output`、模态 `modalities.input`；**对外 id 用 `id`，请求时发裸键或裸 id（实测都 200）**，绝不带 `QianfanPersonalQuota/` 前缀；本机 43 条、无凭据（`apiKey: "nokey"`）。
  - **没有 `/models` 端点**（实测 404），静态表就是唯一来源；读不到才退化 3 档（badge「3档」）。
  - 测试：真实文件快照做夹具（无凭据，仍走脱敏流程）。
- **T4.4 流式**
  - 实测真 SSE → 直接透传；仅当 `content-type` 不是 `text/event-stream` 时才退化为伪流式（版本漂移兜底），README 标注。
- **P4 出口**：DuMate 在线时选择器出现真实模型名（含窗口/输出上限）、发消息 token 逐字出现、杀进程后该上游变「离线 · 未检测到 DuMate」且不影响其它上游。

## 6. 阶段 P5：本地 HTTP 网关

- **T5.1 server**：`node:http`，只绑 `127.0.0.1`，端口占用顺延 +1…+19，`/health` + `/v1/models`。
- **T5.2 chat**：`/v1/chat/completions` 非流式 + SSE；复用 router，不重复实现上游逻辑。
- **T5.3 messages**：最小 Anthropic 形状（`content[].text`、`stream`、`stop_reason`）。
- **T5.4 鉴权**：`gatewayToken` 非空时校验 `Authorization: Bearer`。
- **P5 出口**：`curl -N` 三个端点通；Claude Code 指到 `http://127.0.0.1:7321` 完成一轮对话。

## 7. 阶段 P6：侧栏面板

- **T6.1 client 骨架**：按 P0-V1 结论注册 slot（`dsh-client-ui-sidebar-right`），只渲染一段文字先跑通。
- **T6.2 面板**：上游列表（名称/地址/在线点/延迟/模型数/刷新）、模型分组（窗口 + 模态 + 点击复制 id）、底部（端口 + curl 示例 + 版本）。
- **T6.3 状态**：订阅 registry 变更；离线置灰；空态给三条建议。
- **T6.4 i18n**：`locale/zh.json`、`locale/en.json`。
- **P6 出口**：面板能看到 DuMate 与一个假上游（或 Ollama）的实时状态，点刷新生效。

## 8. 阶段 P7：发布

- `README.md` / `README.zh.md`：一句话定位 → GIF → 30 秒安装 → 三个场景（发现 Ollama / 接 DuMate / 给 Claude Code 用）→ 与 llm-pi-ai、dsh-llm-dumate、dumate2api 的区别 → 配置 → 已知限制 → 排错。
- `docs/DETAIL.md`：插件详情页文案（DSH 市场用）。
- `docs/demo.gif`：录 15 秒（装 → 选择器出现 → 对话）。
- `LICENSE`：MIT，作者 titor-jz。
- 发布：`npm publish --access public`（包名 `dsh-dumate-gateway`），`gh repo create titor-jz/dsh-dumate-gateway --public`，打 `v0.1.0` tag。
- **P7 出口**：别人 `npx --yes dsh-dumate-gateway@latest install` 能装成功。

## 9. 测试与质量门

- 单测覆盖率目标：`src/**` 行覆盖 ≥ 80%（`node --test`，不引测试框架）。
- 每个 PR 必须：单测绿 + 手工验证记录（贴一句实际输出）。
- 提交前跑 `node --test` 与一次真实上游 e2e（假上游 / Ollama / DuMate 任选；**不用 ZCode**）。
- 不引入 ESLint/Prettier 配置争议（用 Node 内建 `--check` 与 2 空格风格即可）。

## 10. 风险与回退

| 风险 | 触发信号 | 回退 |
|---|---|---|
| 侧栏 API 不可用 | P0-V1 失败 | ~~已排除~~（V1 通过） |
| DuMate A 面没有 SSE | 真机已排除 | ~~已排除~~（真 SSE 确认） |
| DuMate `model` 字段不吃三候选 | 真机已排除 | ~~已排除~~（裸 key / 裸 id 均 200，只有 provider 前缀 404） |
| DuMate 打不开 / 未登录 | TCP 连不上 backendPort | 先发 M1+M3（发现 + HTTP 网关），DuMate 标记实验特性 |
| A 面聊天回环无鉴权 | 任意本机进程可调 | README 与面板如实写明「仅回环、无鉴权」；不暴露到 0.0.0.0 |
| 端口每次启动变 | 上一次端口连不上 | 以 live opencode.json 为唯一主源 + TCP 失败自动重读 |
| inapp key 出现在 electron.log | 日志泄露面 | 不读取、不打印、不落盘；只在需要时顺手取用 |
| install 命令与 DSH profile 格式不匹配 | 装完不生效 | 改为文档指导手动装，同时提 issue 给 DSH |

## 11. 需要用户拍板的点（执行前）

1. ~~DuMate 桌面版是否愿意装回来~~ → **已装 1.0.92 且 2026-11-15 22:10 已完成 6 项真机复验**（结论见 notes），此项关闭；
2. ~~npm 包名是否用 `dsh-llm-gateway`~~ → **已定：`dsh-dumate-gateway`**（用户要求名字带 DuMate；原 `dsh-llm-gateway` 已被第三方 0.0.1 占用；新名在 npm/npmmirror 均 404，2026-11-15 实测）；
3. 仓库是否公开、是否用 MIT；
4. 是否接受 v1 只做 DuMate 一个反代通道（千问/TRAE/Qoder 与 DuMate 的 opencode 会话 API 都推到 v2）；
5. **新增**：ZCode 反代已被封锁，M1/M3 验收改用假上游 + Ollama，是否接受（不接受则需要用户提供一个可用的真实上游）。

## 12. 实现进度（2026-11-15 深夜）

**已落地文件**（项目根 `dsh-llm-gateway/`，零依赖、无构建）：

| 文件 | 职责 |
|---|---|
| `package.json` | `name: dsh-dumate-gateway`、`type: module`、`dsh.bundle.patch`、零 dependencies |
| `cordis.patch.yml` | 单条 `insert`，只装自己 |
| `index.js` | `inject = ['llm']` + `ctx.effect(() => ctx.llm.registerAdapter(...))` |
| `src/adapter.js` | `GatewayAdapter`：目录/解析/prepareCall/stream；块状态机把上游事件投影成 `StreamChunk`；无上游时给 `hello` 占位模型解释怎么启动 DuMate |
| `src/messages.js` | DSH 消息与工具 schema → OpenAI 形状；图片/文件投影成文本占位 |
| `src/failure.js` | 上游错误 → `LLM_FAILURE_CODES`（`invalid_model → UNKNOWN_MODEL`、429 → `RATE_LIMIT` 等） |
| `src/upstream/discovery.js` | 读 live `opencode.json` → `baseURL`/`apiKey`/43 个模型；2 s 缓存、id 门面去重、模态过滤 |
| `src/upstream/health.js` | 600 ms TCP 探活（不花额度） |
| `src/upstream/openai-client.js` | A 面 `POST /chat/completions` SSE → 语义事件（text/reasoning/tool-call/usage/finish） |
| `test/e2e.mjs` | 真机 e2e（目录、流式、未知模型、取消）+ `--offline` 占位与取消路径 |
| `icon.svg`、`locale/{en,zh}.json`、`docs/DETAIL.md`、`README.md` | 包元数据与详情页文案 |

**真机 e2e 结果（2026-11-15，DuMate 1.0.92 运行中）**：

- 目录：43 个模型，`baseURL = http://127.0.0.1:52912/api/qianfanproxy/v1`；
- 流式：`deepseek-v4-flash-0731` 回答 `2`（1.4–2.2 s，reasoning 65–110 字），先 reasoning 块再 text 块；
- 未知模型：`UNKNOWN_MODEL`（上游 `invalid_model` 原文进 message）；
- 取消：`--offline` 路径下 `aborted` / `ABORTED` 断言通过；
- 协议不变量全部断言：`block-end` 文本等于 delta 拼接、`usage` 在 `finish` 前、`finish` 后无 chunk。

**遗留**：重启 DSH 后做一次肉眼验证（P1 出口）；真机 e2e 期间遇到上游 `429 user_rate_limit_exceeded`（短时间连打触发），测试脚本已对限流做跳过处理，后续真机测试仍按「一次跑完、不连打」；P5/P6 未开始。

## 13. P5 进度（2026-11-15 深夜）

**已落地**：`src/gateway/server.js`（`startGateway({port, token, version, readCatalog, isReachable, streamChatCompletion})`，只绑 `127.0.0.1`，端口占用顺延 +1…+19，测试可传 `port:0` 取随机口）；`index.js` 在 `ctx.effect` 里启动网关、卸载时关闭（`http.enabled === false` 可关）。

| 任务 | 状态 |
|---|---|
| T5.1 server + `/health` + `/v1/models` | 完成 |
| T5.2 `/v1/chat/completions` 非流式 + SSE | 完成（复用 `streamChatCompletion` 语义事件，不重复实现上游） |
| T5.3 `/v1/messages` Anthropic 最小兼容 | 完成（含流式事件序列） |
| T5.4 `gatewayToken` 鉴权 | 完成（`http.token` → `Bearer` 或 `x-api-key`） |
| 额外 | `OPTIONS` CORS 只回显回环源；错误按 `failure.js` 映射成 401/402/404/429/499/502/503 |

**验证**：`node test/http-gateway.mjs` 用注入假上游跑 10 组断言全过（health / models / 非流式 / 流式 + `[DONE]` / 未知模型 404 / Anthropic 非流式 / Anthropic 流式 / CORS 预检 / 鉴权 401+两种头 / tool_calls）。
**真机**：`node test/http-gateway-live.mjs` 中 `/health` 与 `/v1/models` 通过，chat 撞上游 `429 user_rate_limit_exceeded`（本轮之前连续请求所致），网关按设计映射成 HTTP 429 且**不重试**；脚本已把 429 记为跳过项。

**P5 出口**：`curl` 三端点通（真机 chat 待一次空闲后补测）；Claude Code 指到 `http://127.0.0.1:7321` 尚未实测。

## 14. P6 进度（2026-11-15 深夜）

**已落地**：`client.js`（浏览器端，无构建）+ `package.json` 的 `dsh.client`（`platform:'web'`、`immediately:true`、`inject:['@deepseek-ai/dsh-client-ui-sidebar-right']`）与 `./client` export；`locale/*.json` 增加 `dumateGateway` 命名空间。

| 任务 | 状态 |
|---|---|
| T6.1 client 骨架（slot 注册，两段都在 `ctx.effect`） | 完成 |
| T6.2 面板（上游状态 + 模型列表 + 复制 id + 底部网关信息/curl） | 完成 |
| T6.3 状态（15 s 自动刷新、离线/错误空态、刷新按钮） | 完成（无 registry 订阅，用轮询） |
| T6.4 i18n | 部分：命名空间与键已备，面板文案仍为英文字面量 |

**数据通道（已定，2026-11-16 实测后改）**：页面直连 `127.0.0.1:7321` 在真实 GUI 里报 `Failed to fetch`（CORS 其实放行，是页面侧跨源策略拒），改用 host 同源 Fetch 路由 `GET /api/dumate-gateway/status`（`ctx.connection.fetch.register`，只答 owner peer），拿不到才回退 7321。**`path` 必须带 `/api` 前缀**（注册表按完整 pathname 索引）；host 半区改完用 `plugin_manager set_plugin`（`include:dumate-gateway` 关→开）热重载即可，不必重启 DSH。

**验证**：`node test/status-route.mjs`（payload / 离线 / 参数透传 / no-store / 路径形状）+ `node test/plugin-host.mjs`（apply 注册 adapter + 路由、`http.enabled:false` 不启网关、disposer 可调用）+ `node test/client-plugin.mjs`（含「guide 的 title/description 必须是函数」断言）全绿；浏览器直接打开 `http://127.0.0.1:<gui>/api/dumate-gateway/status` 返回 `ok:true`、`online:true`、`models:16`（已实测）。

## 15. 模型筛选进度（2026-11-15 深夜）

**起因**：重启后选择器显示 43 条，混着 `model-*` 内部能力模型、六个 `dm-auto-model/*` 档位、OCR/embedding/rerank/mock 等非对话端点。

**已落地**：`src/upstream/discovery.js` 拆出纯函数 `curateEntries(entries, {mode, exclude})`（可单测、与文件读取解耦），默认 `CURATED_HIDDEN` 隐藏管线模型；`models.mode: curated | all` 与 `models.exclude` 进入配置；`GatewayAdapter` 构造时读入并交给 `readCatalog`；筛选为空时回落完整表（不清空选择器）。隐藏 `model-text` 后 `glm-5` 别名接管该 id，选择器显示「GLM 5」而非两条同物。

| 任务 | 状态 |
|---|---|
| T15.1 discovery 拆分 + 规则表 | 完成 |
| T15.2 配置 `models.mode` / `models.exclude` | 完成 |
| T15.3 `test/curation.mjs`（合成 + live） | 完成（live：43 → 16） |
| T15.4 文档（spec §11、notes、README） | 完成 |

**验证**：`node test/curation.mjs` → `live 16 of 43 models shown`；其余离线测试（client-plugin / http-gateway 10 checks / e2e --offline）全绿。

**生效条件**：宿主已加载旧模块，需重启 DSH（或 HMR 重载）后选择器才会变成筛选后的 16 条。

## §16 面板增强（2026-11-16）

- **试聊**：新 `src/host/try-route.js`（`POST /api/dumate-gateway/try`），一次小补全（`prompt` ≤2000 字符、`max_tokens` 默认 64/上限 512、超时 60 s），返回文本 + `first_token_ms` / `total_ms` / usage；错误映射沿用网关的 `statusOf()`。
- **本地用量统计**：新 `src/usage.js`，`~/.dsh/dumate-gateway/usage.json`，7 天；每个 `streamChatCompletion` 调用记一行（`kind` = `dsh`/`http`/`try`）；面板 footer 显示 `today · N requests · in/out tokens · errors`。
- **面板**：模型过滤框、收藏 ★（localStorage）、试聊框、`state file` 诊断行、`read HH:MM:SS`。
- **测试**：`test/try-route.mjs`、`test/usage.mjs` 新增；`test/plugin-host.mjs` 断言两条路由与三个 effect 标签；全套 8 个测试全绿。
- **实测**：2026-11-16 13:44 面板内真实点击，回答正常、`in 36 / out 64`、用量行 `1 requests`；截图 `docs/assets/sidebar-try.png`。

## §17 面板图表版重设计（2026-11-16 14:37-14:55）

用户嫌旧面板「太丑」，要求图表化（m01790）；经 `/brainstorming` 定为 bounded 改动，设计获批准（m01803「行继续」）后实施。

**改动**
- `client.js` 重写为单列卡片：状态条 → 用量卡（Today 大数字 + in/out 拆分 + 7 日成对柱状图）→ 首字延迟卡（SVG sparkline + last/p50/samples）→ 试聊卡 → 快捷动作（Copy base URL / Copy curl）→ 两个折叠抽屉（`Models (N)`、`Details`）。
- 图表全部手写内联 SVG（零依赖、无构建、`currentColor` + 强调色 `#4a7dff`，跟随明暗主题）；数据来自 `usage`（`src/usage.js` 日桶）与 `localStorage['dsh.dumate-gateway.latency.v1']`（Send 成功才写、最多 12 点）。
- `src/host/try-route.js`：`DEFAULT_MAX_TOKENS` 64 → **256**（推理模型会把 64 全花在 thinking 上导致正文为空）；`client.js` 加 `shownAnswer()`，正文为空时展示 reasoning 并标注预算耗尽。
- `test/client-plugin.mjs` 重写断言：展开函数组件后必须渲染 1 个 `svg`（7 根 `rect`）、抽屉默认收起时只有 1 个 `input`（试聊框）、两个 disposer 可调用；`test/try-route.mjs` 默认值断言改 256。

**验证**：8 个测试全绿（client-plugin / status-route / try-route / usage / plugin-host / http-gateway(10) / e2e --offline / curation）；宿主热重载（Plugins 关→开）后浏览器实测：`Online · 16 models · v0.0.1`、`Today 314 tokens · 3 req · 0 err`、`last 1.2 s / p50 1.2 s / samples 2`、试聊回答 `我是一个乐于助人的AI助手，能为你解答问题、整理信息并提供建议。`（`first 1.2 s · total 2.0 s · 34 in / 80 out`）。截图存 `docs/assets/sidebar-panel.png`。

**未做（留到下一轮）**：明暗两主题分别截图；面板文案接 `locale` 的 `t()`；延迟历史按模型分组。
