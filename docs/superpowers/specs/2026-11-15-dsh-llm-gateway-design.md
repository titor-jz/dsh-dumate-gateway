# dsh-llm-gateway 设计文档

- 日期：2026-11-15
- 状态：待评审（只做计划，不写实现）
- 目标读者：项目作者（titor-jz）、后续贡献者

## 1. 背景与目标

### 1.1 问题

现在要在 DeepSeek Harness（DSH）里用上一个模型，路径是这样的：手动打开「设置 → 模型 → 添加提供商」，填 baseURL、选协议、填 API key、一个模型一个模型地填上下文窗口和输出上限，再声明视觉/思考档位。以本机接入 ZCode 反代为例，这份 YAML 是手写的：

```yaml
zcode:
  displayName: ZCode
  apiKeyEnv: ZCODE_API_KEY
  api: openai-completions
  baseURL: http://127.0.0.1:8080/v1
  models:
    - id: glm-5.3-flash
      contextWindow: 1000000
      maxTokens: 128000
      input: [text, image]
      reasoningEfforts: {low: low, high: high, max: max}
```

同时，用户机器上往往还跑着别的本地模型服务（Ollama、LM Studio、vLLM，以及各种反代），每一个都要重复一遍上面的手工活；而**只有桌面客户端才能用的模型**（首发是百度 DuMate 搭子），干脆接不进来——社区现有的 DSH 插件 `dsh-llm-dumate` 只暴露 3 个档位别名、不是真流式、所有对话共用一个上游会话。

### 1.2 目标

做一个 DSH 原生插件 `dsh-dumate-gateway`（中文名「DuMate 网关」；工作目录仍叫 `dsh-llm-gateway`，见 §15），解决两件事：

1. **发现**：自动扫描本机上的 OpenAI 兼容模型服务，零配置把它们作为 DSH 模型呈现出来，并带上真实的上下文窗口、输出上限、视觉能力、思考档位与在线状态。
2. **反代**：把只有桌面客户端/私有协议才能用的模型，翻译成 DSH 能直接调的模型（首发 DuMate 搭子），并且**真流式**、会话隔离、真实模型名。

再加一个副作用但很有用的能力：同一个端口同时提供 OpenAI / Anthropic 兼容 HTTP 端点，Claude Code、Codex CLI、curl 可以直接用。

### 1.3 目标用户与成功标准

- 用户：装了 DSH、机器上有多个本地/免费模型来源、厌倦了手写 provider 配置的人（首先是作者本人）。
- 成功标准（v1 发布）：
  - `npx --yes dsh-dumate-gateway install` 一条命令装进 DSH，重启后模型选择器里出现「网关」分组的模型；
  - 本机同时跑着本地模型服务（Ollama / LM Studio / 自建反代）时，插件自动发现并可用，**不需要任何配置文件**（原文写「ZCode 反代」，但该反代已于 2026-11-15 被上游风控封锁，见 §17 与 §19）；
  - DuMate 桌面版在运行时，能在 DSH 里选到它的真实模型名并发起流式对话；
  - `curl http://127.0.0.1:7321/v1/models` 与 `/v1/chat/completions` 可用；
  - GitHub 仓库有中英 README、安装 GIF、MIT LICENSE。

## 2. 非目标（v1 明确不做）

- 不接千问办公 / TRAE Work / Qoder / 其它云端逆向通道（这些属于 dumate2api 的领域，先做深一条）。
- 不做账号池、自动签到、积分套现、多账号轮换。
- 不做多上游故障切换与按额度选路（v2 候选）。
- 不做图片生成 / 视频生成端点。
- 不做 macOS / Linux 的 DuMate 反代（Windows 优先；发现功能跨平台）。
- 不做 Web 图形化配置向导（用 DSH 自带设置页 + 配置文件即可）。

## 3. 术语

| 术语 | 含义 |
|---|---|
| upstream | 一个上游模型来源：要么是可发现的 HTTP 端点，要么是一个协议适配器实例 |
| discovered upstream | 通过端口扫描 + `/v1/models` 探测发现的标准 OpenAI 兼容端点 |
| adapter upstream | 需要协议翻译的上游（v1 只有 DuMate） |
| model entry | 网关对外暴露的一个模型，`id` 全局唯一，形状如 `zcode/glm-5.3-flash`、`dumate/glm-5` |
| gateway route | DSH 侧注册的 provider 路由；v1 只注册一个：`gateway` |

## 4. 架构

```
┌──────────────────────── DSH Host 进程 ────────────────────────┐
│                                                                │
│  dsh-dumate-gateway (cordis 插件)                                │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐   │
│  │  discovery   │   │  registry    │   │  gateway-adapter │   │
│  │  端口扫描/探测 │──▶│  上游与模型表 │◀──│  LlmAdapter 实现  │   │
│  └──────────────┘   └──────┬───────┘   └────────┬─────────┘   │
│         │                  │                    │             │
│  ┌──────▼───────┐   ┌──────▼───────┐   ┌────────▼─────────┐   │
│  │ health poller│   │   router     │──▶│ upstream clients │   │
│  │  30s / 抖动   │   │ 模型→上游+降级 │   │ openai / dumate  │   │
│  └──────────────┘   └──────────────┘   └──────────────────┘   │
│                            │                                   │
│                     ┌──────▼───────┐    ┌──────────────────┐   │
│                     │ http gateway │    │  client 半区      │   │
│                     │ :7321 (可选)  │    │  侧栏面板 + 设置页 │   │
│                     └──────────────┘    └──────────────────┘   │
└────────────────────────────────────────────────────────────────┘
        ▲                    ▲                       ▲
   ctx.llm (DSH)      curl / Claude Code        Web GUI 侧栏
```

### 4.1 组件职责

| 模块 | 文件 | 职责 | 不负责 |
|---|---|---|---|
| `discovery` | `src/discovery.js` | 端口扫描、`/v1/models` 探测、端点指纹、结果去重 | 不持久化、不决定是否启用 |
| `registry` | `src/registry.js` | 上游与模型的唯一真相；增删改查；变更广播 | 不做网络 IO |
| `health` | `src/health.js` | 周期探活、延迟采样、状态迁移（unknown→online→offline） | 不修改模型列表 |
| `router` | `src/router.js` | 模型 id → 上游；同一模型多上游时的优先级与降级 | 不实现协议 |
| `upstream/openai` | `src/upstreams/openai.js` | 标准 OpenAI Chat Completions 流式转发 + 消息投影 | 不做鉴权流程 |
| `upstream/dumate` | `src/upstreams/dumate.js` | DuMate 桌面 opencode 协议 ↔ OpenAI 语义（会话、流式、取消） | 不解析 DSH 会话 |
| `adapter` | `src/adapter.js` | DSH `LlmAdapter` 实现，模型元数据与错误映射 | 不做 IO 细节 |
| `http gateway` | `src/http.js` | 本地 OpenAI/Anthropic 端点，复用 router | 不做 UI |
| `settings` | `src/settings.js` | 配置 schema、默认值、校验 | 不写业务状态 |
| `client` | `client/index.js` | 侧栏面板：上游/模型/状态/端口 | 不做模型调用 |

**边界规则**：`router` 只认识 `model entry → upstream id` 与错误分类，不认识任何协议细节；每个 `upstream` 暴露统一接口 `{ listModels(), chat(messages, opts): AsyncIterable<chunk>, health() }`。新增一种上游 = 新增一个实现文件 + 在 registry 注册，不改 router / adapter / http。

## 5. 数据模型

```js
// upstream（registry 内部）
{
  id: 'zcode',                 // 稳定标识，来自指纹或适配器名
  kind: 'discovered' | 'adapter',
  label: 'ZCode 反代',          // 展示名，可推断
  baseURL: 'http://127.0.0.1:8080/v1',
  protocol: 'openai-chat',
  credential: null,            // discovered 通常无 key；adapter 由适配器自管
  status: 'unknown' | 'online' | 'offline',
  latencyMs: 42,
  checkedAt: 1763...,
  models: [modelEntry],
}

// model entry（对外暴露）
{
  id: 'zcode/glm-5.3-flash',   // 全局唯一：<upstream>/<upstream model id>
  upstreamId: 'zcode',
  upstreamModel: 'glm-5.3-flash',
  name: 'GLM-5.3-Flash',
  contextWindow: 1000000,
  maxTokens: 128000,
  inputModalities: ['text', 'image'],
  reasoning: { efforts: [{id:'low', name:'Low'}, ...], defaultEffort: 'max' },
  source: 'probe' | 'known-table' | 'adapter' | 'catalog',
}
```

模型元数据的来源优先级（高→低）：适配器声明（DuMate）＞ 上游 `/v1/models` 返回的字段 ＞ 内置已知模型表 `src/catalog/known-models.json`（glm/deepseek/qwen/kimi/doubao 等前缀与精确名匹配）＞ 保守默认（contextWindow 131072、maxTokens 8192、仅文本）。**永远不猜不写**：拿不到就省略字段，让 DSH 用自己的默认值。

## 6. 发现流程

1. **候选端口**（默认）：`8980`（DuMate 后端 gin 默认端口，即 A 面入口）、`11434`（Ollama）、`1234`（LM Studio）、`8000`/`5000`（vLLM/常见自建）、`3000`、`18080`、`8080`（通用反代口；ZCode 已封，只当通用候选，不拿它做 e2e）。DuMate 真实端口是动态的（本机曾为 52867），**优先从 opencode.json 的 `baseURL` 读，扫到 8980 只是兜底**；`52795` 是社区常量，不作候选。可在配置里覆盖：`scanPorts: [8980, 11434]`。
2. **TCP 连通性**：并发 8 路，单端口 300 ms 超时；不通即跳过。
3. **指纹**：`GET {base}/v1/models`，1.5 s 超时。判定标准：HTTP 200 且 JSON 含 `data` 数组（OpenAI 形状）或 `models` 数组（Gemini 形状，v1 只记录不启用）。
4. **命名**：按端口已知映射（8080→ZCode、11434→Ollama、1234→LM Studio…）→ 否则用 `Host` 的 `Server` 头 → 否则 `local-<port>`。多个上游同指纹时以 `baseURL` 去重。
5. **模型展开**：`data[].id` 逐个变成 model entry；元数据走第 5 节优先级链。
6. **首次扫描时机**：插件启动后 1 s 延迟执行一次（避免和 DSH 启动争资源）；之后**只在**「用户点刷新」「设置页保存」「上游全部离线且距上次扫描 > 60 s」时重扫。不做常驻轮询扫描。
7. **健康轮询**：仅对已注册 upstream，每 30 s 一次 `GET /v1/models`（复用连接池），超时 2 s；连续 2 次失败置 `offline`，一次成功置 `online` 并记录 `latencyMs`。状态变化触发 `llm/models-updated('gateway')` 让选择器里的 badge 更新。

**反例与防护**：不做全网段扫描、只扫 `127.0.0.1`；不请求非 `/v1/models` 路径以免触发某些服务的 billing；探测请求不携带任何凭据。

## 7. DuMate 接入（2026-11-15 静态取证后重写）

### 7.1 安装形态与两个可接入面

DuMate **已安装**：版本 **1.0.92**，`D:\DuMate\DuMate.exe`（Electron 壳，`resources/app.asar` 99.9 MB），安装于 2026-11-15 10:4x；用户已于 2026-11-15 22:00 启动它完成真机复验，之后可随时退出。它是三层，不是单个进程：

| 层 | 路径 | 作用 |
|---|---|---|
| Electron 壳 | `D:\DuMate\DuMate.exe` | UI、cookie 加密（`resources/app.asar.unpacked/build-ts-electron/native/*.node`）、拉起后端 |
| 后端（Go gin） | `D:\DuMate\resources\extra-resource\backend\bin\dumate-main-server.exe`（60 MB） | 起 HTTP 服务、代理模型、管理 opencode 子进程 |
| opencode server | `D:\DuMate\resources\extra-resource\opencode\bin\dumate-opencode.exe`（143 MB，Bun 单文件） | 会话 / 工具 / 技能引擎，即社区工具对话的那个 API |

配置：`D:\DuMate\resources\config\desktop-main\config.yml`（gin 默认端口 `8980` 被注释、可 `--port` 覆盖；`opencode_base_url: "http://127.0.0.1:4096"`）；`D:\DuMate\resources\config\opencode\opencode.json`（模板 828 B：`baseURL: http://127.0.0.1:{{desk-main-port}}/api/qianfanproxy/v1`、`apiKey: "nokey"`、`model: "QianfanPersonalQuota/glm-5"`）。运行时 asar 把 `{{desk-main-port}}` 替换成真实 `backendPort`（日志前缀 `[Dumate-agt]`），并导出 `env.DUMATE_QIANFAN_PROXY = http://127.0.0.1:${backendPort}/api/qianfanproxy/`。**该端口每次启动都可能变**（2026-11-15 22:00 启动后实测：后端 `dumate-main-server.exe` 听 `52912`、opencode 听 `52161`、router `52776`、base-proxy `52829`），所以只能读 live 文件，不能写死。

**两个可接入面，v1 只用 A：**

- **A 面（v1 默认）：OpenAI 兼容模型代理。** `POST http://127.0.0.1:<backendPort>/api/qianfanproxy/v1/chat/completions`，标准 OpenAI 请求/响应；后端二进制含 `qianfanproxy/v1/chat/completions`、`/v1/chat/completions`、`/api/qianfanproxy/*proxyPath`、`text/event-stream`、`X-Accel-Buffering`、`completion_tokens`、`reasoning_content`。→ **v1 不需要会话映射，基本是 1:1 转发 + 模型表映射。**
- **B 面（v2 可选）：opencode server API。** `/session/{id}/message`（GET 列历史 / POST prompt）、`/session/{id}/message/{msgID}`、`/session/{id}/prompt_async`、`/global/event`（SSE，GET）、`/global/health`、`/global/dispose`。社区 4 个参考仓库走的是这一面，所以看起来「没有 SSE、没有 model 字段」——是抄窄了，不是产品缺失。

### 7.2 地址与鉴权发现（2026-11-15 22:10 真机修正）

1. **首选**：读 `%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\<账号>\config\opencode\opencode.json` 的 `baseURL`。DuMate 启动时会用真实 `backendPort` 重写它（本次 `127.0.0.1:52912`，文件 mtime 正好是启动时刻）——这是唯一可靠来源。
2. 其次：`DUMATE_HOST_URL` 环境变量（用户手填覆盖）。
3. 再其次：gin 默认 `8980`（`config.yml` 里 `#port: 8980`），再 `OPENCODE_SERVER_PORT`。
4. **不要用 `52795`**：社区参考实现的兜底常量，`dumate-main-server.exe` 里 0 命中。

**鉴权（真机结论：A 面聊天不需要 key）**：`POST /api/qianfanproxy/v1/chat/completions` 不带任何请求头即 200（仅回环可达）；`/global/health` 与 `/v1/models` 无 key 时 401。所以 v1 **不阻塞于 key**：

- 能拿到 key 就带上 `X-Dumate-Inapp-Key` + `X-Dumate-Prd-Source: personal`，为未来版本收紧留余地。来源链：`process.env.DUMATE_INAPP_KEY` → `%APPDATA%\qianfan-desktop-app\log\electron.log` 里的 `DUMATE_INAPP_KEY: '<64 hex>'`（实测存在，比 PEB 简单）→ 承载进程 PEB（Windows，PowerShell + P/Invoke，超时 3 s、失败静默）。缓存 30 s。
- 拿不到 key 也照常转发（实测 keyless 可用）。
- **在线判定用 TCP connect 到 backendPort**，不要用 `/global/health`：带 log 里的 key 仍 401；opencode 端口 `:52161/global/health` 才返回 `{"healthy":true,"version":"local"}`（B 面用）。

### 7.3 A 面协议映射（OpenAI 兼容，v1 默认）

| DSH 语义 | A 面 | 备注 |
|---|---|---|
| 列模型 | 静态表：opencode.json 的 `provider.QianfanPersonalQuota.models` | **没有 `/models` 端点**（实测 404 `dumate api not registered`），静态表是唯一来源 |
| 流式 | `POST /api/qianfanproxy/v1/chat/completions` body `stream:true` → `content-type: text/event-stream`；chunk 里 `delta.reasoning_content`（思考）与 `delta.content`（正文）交替，末帧带 `usage`，结束 `data: [DONE]` | **实测真流式**：8 chunk / 434 ms |
| 非流式 | 同端点 `stream:false` → 标准 `chat.completion`，`usage.completion_tokens_details.reasoning_tokens` 可选 | 兜底 |
| 取消 | 关上游连接（`AbortSignal` → socket close） | 后端是否停止生成/计费仍未验，README 如实写 |
| 模型名 | **裸 key（`glm-5`）或裸 id（`model-text`）都 200**；`QianfanPersonalQuota/glm-5` → 404 `invalid_model` | 永远不带 provider 前缀 |
| 目录唯一化 | DSH 要求模型 id 全局唯一，而上游 `glm-5` 与 `model-text` 两个键都指向 id `model-text`（实测 43 键 / 42 唯一 id） | 自名项保留 id，别名项改用其键名（键同样被上游接受），43 条一条不丢 |
| 模态 | 上游 `modalities.input` 可出现 `video`；DSH 的 `ModelModality` 只有 `text` / `image` | 过滤 `video`，避免声明 DSH 无法投递的能力 |
| 限流 | 短时间连续请求 → `429 {"error":{"code":"user_rate_limit_exceeded","message":"user_rate_limit_exceeded. 用户级限流"}}` | 映射 `RATE_LIMIT`；真机测试一次跑完，不连打 |

### 7.4 B 面协议映射（opencode session，v2 才做）

| 语义 | 形状 |
|---|---|
| 会话 | `POST /session {title, directory}` → 返回 `id`（opencode 原生字段；仍防御式取 `id` \| `session_id`） |
| 发送 | `POST /session/{id}/message {parts:[{type:'text',text}], model?:{providerID,modelID}}`，同步阻塞到整轮结束 |
| 取回复 | `GET /session/{id}/message`，倒序找最后一条 assistant 的 `content`（字符串或 `[{type:'text',text}]`） |
| 流式 | `GET /global/event`（SSE，事件名如 `message.part.updated`）——opencode 原生支持 |
| 档位 | body 内 `headers: {'X-Dumate-AutoModel-Level': 'L0'\|'L1'\|'L2'}`（社区实现） |
| 取消 | 无 abort 端点，只能本地放弃等待 |

v1 **不实现** B 面；它只在「需要 DuMate 会话历史 / 工具调用」时才有价值，列 v2。

### 7.5 模型元数据

读 `%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\<账号>\config\opencode\opencode.json` 的 `provider.QianfanPersonalQuota.models`。窗口与输出上限的键名**两种都出现过**：安装目录模板用 `limit.context` / `limit.output`，本机残留文件用 `limit.input` / `limit.output` ——**两个都兼容**（`context ?? input`）。另有 `modalities.input`、`thinking.mode`；**键名与 `id` 可能不同**（本机 `glm-5` 的 `id` 是 `model-text`），对外 id 用 `id`。本机读到 **43 个**模型（全部 `thinking.mode:"never"`，无 reasoning 档位）；**文件里没有凭据**（`apiKey` 是字面量 `nokey`），凭据只有 inapp key。清单随账号/客户端版本漂移（另一台机器记录到 45 条），不做硬编码。

积分：v1 不显示。后端字符串里有 `credits_exhausted`、`user.quota.exhausted`、`completion_tokens`，用于错误映射与用量字段。

**真机复验（2026-11-15 22:10 已全部跑完，原始证据见 notes）**：

| # | 项 | 结果 |
|---|---|---|
| 1 | `GET /global/health`（后端 `:52912`，带 key） | **401 unauthorized** → 在线判定改用 TCP connect |
| 2 | 非流式形状 | 200 `chat.completion`，`usage.{prompt_tokens, completion_tokens, completion_tokens_details.reasoning_tokens, total_tokens}` |
| 3 | 流式 | **200 `text/event-stream`，逐块增量** |
| 4 | `model` 候选 | `glm-5` ✅ / `model-text` ✅ / `QianfanPersonalQuota/glm-5` ❌ 404 |
| 5 | 无 inapp key | chat 200（回环放行）；`/v1/models`、`/global/health` 401 |
| 6 | `GET /api/qianfanproxy/v1/models` | **404** → 只用静态表 |

模型表实测口径（43 条，live 文件用 `limit.input`，安装模板用 `limit.context`，两者都兼容）：`glm-5` 键→`id:"model-text"`、1M/128k、纯文本；`deepseek-v41-flash` 1M/384k、文本+图；`dm-auto-model/text.L1` 1048576/1048576、文本+图+视频；`qwen3.8-max` 983k/128k、文本+图+视频。

### 7.6 错误映射

| 上游现象 | DSH 错误码 |
|---|---|
| 桌面版未启动 / 端口不通 | `NO_ADAPTER`（消息提示启动 DuMate） |
| key 缺失或失效 | `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL`（A 面实际不需要 key，保留给未来版本） |
| 上游 401/403 | `AUTH` |
| 404 `invalid_model`（`model \`X\` does not exist`） | `MODEL_NOT_FOUND`（枚举名按 DSH 实际 API 校准） |
| 429 或「今日额度用尽」文案（`credits_exhausted` / `user.quota.exhausted`） | `RATE_LIMIT` / `QUOTA`（未触发，待验） |
| 超时 | `HTTP_504` |
| 其它 | `TRANSPORT` |

## 8. DSH 集成契约

- 实现 `LlmAdapter` 子类，注册一个 provider 路由 `gateway`：
  - `listModels('gateway')` 返回所有 model entry（名称带上游前缀 + 状态 badge）；
  - `resolveModel('gateway', id)` 返回 contextWindow / defaultMaxTokens / inputModalities / reasoning；
  - `stream(options)` 由 router 选上游并转发，最后必须发终止 `finish` chunk；
  - `prepareCall` 用默认实现即可（v1 无动态连接切换）。
- `badge`：`online` → 无 badge；`offline` → `{text:'离线', tone:'warning'}`；`unknown` → `{text:'探测中', tone:'neutral'}`；DuMate 降级 3 档时 `{text:'3档', tone:'info'}`。
- 状态变化后调用 `ctx.emit('llm/models-updated', 'gateway')`（实现时确认事件名）。
- **与 llm-pi-ai 共存**：`cordis.patch.yml` 只 `insert`，**绝不** `disabled: true` llm-pi-ai（现有 DuMate 插件就干了这个，装完 ZCode provider 会消失）。这一点写进 README 的「为什么不用 XX」。
- 设置页：`registerConfigurableProviders` 可选（v1 不做图形化配置），但提供 `registerModelDiscovery` 让「添加提供商 → 探测模型」认得出 `gateway` 命名空间（v1.1）。

## 9. 本地 HTTP 网关（2026-11-15 P5 已实现）

- 只绑定 `127.0.0.1`（不监听 `0.0.0.0`），默认端口 `7321`，被占用时顺延 `+1…+19`；实际端口写进日志与 `/health`。
- 端点（`src/gateway/server.js`）：
  - `GET /health` → `{ok, gateway:{version,upstream}, upstream:{name, baseURL, online, models}}`，`online` 用 600 ms TCP 探活；
  - `GET /v1/models` → OpenAI 形状 `{object:'list', data:[{id, object:'model', owned_by:'dumate', context_window, max_tokens, input_modalities}]}`；**单上游时 `id` 直接是模型目录里的 id，不加前缀**（v1.1 多上游再引入 `<upstream>/<model>`）；
  - `POST /v1/chat/completions` → 支持 `stream:true`（SSE `data: {...}` + `data: [DONE]`，`reasoning_content` 与 `content` 分帧，`usage` 帧在 finish 前）；非流式一次返回完整 `chat.completion`；`tool_calls` 透传；请求里的 `system` 会并入首条 system 消息；
  - `POST /v1/messages` → 最小 Anthropic 兼容：`system`/`content[].text`/`image`→`[image]` 占位、`stop_sequences`、`stream`（`message_start` → `content_block_start/delta/stop` → `message_delta` → `message_stop`）；
  - `OPTIONS *` → CORS 只回显回环源（`127.0.0.1`/`localhost`/`::1`），其它源回 `null`，供侧栏面板直连用。
- 错误：模型不在目录 → 404 `model_not_found`；DuMate 未运行 → 503 `upstream_unavailable`；上游错误按 `src/failure.js` 映射成对应 HTTP 状态（`AUTH` 401、`QUOTA` 402、`RATE_LIMIT` 429、`ABORTED` 499、其它 502）。
- 鉴权：默认无（回环 + 单用户）；配置 `http.token` 后要求 `Authorization: Bearer` 或 `x-api-key`，CORS 预检不校验。
- 不做 Responses API、不做 `/v1beta`（Gemini）——写进 README 的「已知限制」。

## 10. 侧栏 UI（`dsh-client-ui-sidebar-right`）

### 10.1 入口与生命周期（P0-V1 实测结论，2026-11-15）

右侧栏是**会话作用域**的：没有选中会话时右侧栏不存在（官方 Known Limitation，state 按 `dsh.sidebar-right.v1.<sessionId>` 存 localStorage）。所以面板不是「装上就常驻」，而是：

- **类型**：`ctx.sidebarRightTabs.register({ id, kind:'llmGateway', priority:'extension', keepMounted:true, title, guide:[…] })`；`id` 用包名（全局唯一，重复注册 throw）；
- **入口**：guide 卡片（`guide:[{id,order,title,description,icon}]`，出现在右侧栏引导页）+ 一个按钮（`sidebar.footer.action` 或 `conversation.session.header.utilities`）调 `ctx.sidebarRight.openTab('llmGateway')`，可选再挂 `ctx.shortcuts.register`；
- **渲染体**：`ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name:'sidebar.right.pane.tab', key:包名, locale, store, inject }, Body))`，标题位同 key 注册 `sidebar.right.pane.tab.title`；Body 内用 `useTabInfo()` 拿 `{sidebar, panel, tab}`；
- **必须放在 `ctx.effect(...)` 里**（生命周期跟随插件）；面板展开/收起用 `ctx.layout.openRightbar(track, fullscreen)` / `closeRightbar()`；
- **两类 inject 都要写**：`package.json` 的 `dsh.client.inject` 列**包 id**（本例只需 `@deepseek-ai/dsh-client-ui-sidebar-right`），`lib/client.js` 的 `exports.inject` 列**服务键**（`['slots','locale','sidebarRight','sidebarRightTabs']`）。

无会话时也要看状态 → 另在 `main` 面板或设置页给只读区块（v1.1；侧栏不承担这个场景）。完整可照抄骨架见 `docs/superpowers/notes/2026-11-15-probes.md` 的「V1」节。

### 10.2 面板内容（2026-11-16 图表版重设计）

单列卡片，自上而下——目标是「一眼看清健康度与用量」，细节收进抽屉：

1. **状态条**：绿/红/灰点 + `Online`/`Offline`/`Probing` + `N models` 胶囊 + 版本 + `Refresh`。
2. **用量卡**：`Today` 大数字（in+out tokens）+ `req · err`；大数字下面一条**占比条**（全宽 6px 圆角：浅色 = input、实色 = output，带 `role="img"` 与 aria-label），再一行图例 `● in N  ● out N … last 7 days`；**7 日成对柱状图**（内联 SVG，viewBox `0 0 320 88`，input/output 各一根渐变圆角柱；顶部虚线标出 7 日峰值并在左上角标数值；空天只画基线上的 2px tick；今天用淡色圆角带框住柱子与数值标签，星期标签加粗）。全空时显示空态文案而不是空坐标系。
3. **首字延迟卡**：**sparkline**（内联 SVG，viewBox `0 0 120 28`，最多 12 个点）+ `last` / `p50` / `samples`；数据存本机 `localStorage['dsh.dumate-gateway.latency.v1']`，本面板 Send 或 Probe 成功时写入（Probe 测的是同一条路径的首字延迟，所以没有真实消息时也有样本）。
4. **试聊卡**：标题右侧 **Probe** 按钮（16 token 的 ping，一次点击回答「现在连得上吗」，成功显示 `✓ Connected · <model> · first … · total …`，失败显示具体原因；离线时用状态路由已知的 `online:false` 直接给「DuMate 没在运行」，不发请求）+ 输入框（Enter 或 Send）+ `Model` 下拉（`Auto (first model)` 或具体模型，选择持久化在 `localStorage['dsh.dumate-gateway.model.v1']`）+ 回答 + `model · first · total · in/out` + 「one short completion (max 256 tokens)，只有这个按钮花额度」。回答为空但有 reasoning 时展示 thinking 文本并标注「token 预算先用完了」。
5. **快捷动作**：`Copy base URL` / `Copy curl`，复制后在原处显示 `copied …`。
6. **折叠抽屉**：`Models (N)`（默认收起，展开后有过滤框、`☆` 收藏、`id · 窗口 · 模态`、点击复制 id）与 `Details`（默认收起：upstream / gateway / models+mode / state file / reason / today 用量）。

**图表为什么手写 SVG**：零依赖、无构建、跟随明暗主题（全部 `currentColor` + 一个强调色 `#4a7dff`），也不需要给插件加图表库。卡片视觉对齐宿主「上下文洞察」页：10px 圆角、1px 半透明描边、10.5px 大写字距标签、22px 大数字、等宽只用于 id/路径。

### 10.3 数据通道（已定：host 同源 Fetch 路由）

**实测结论（2026-11-16）**：候选 A（页面直接 `fetch('http://127.0.0.1:7321/health')`）在真实 GUI 里报 `Failed to fetch`——网关侧 CORS 对 loopback 源是放行的（`access-control-allow-origin` 回显、`vary: origin`、OPTIONS 204 都验过），所以问题在页面侧跨源策略（或 GUI 并非由 loopback 页面直连）。插件面板不能依赖跨源请求。

**采用**：`ctx.connection.fetch.register({ path, methods, requestBody, fetch })`（host 的 `connection` 服务）。面板改为同源 `GET /api/dumate-gateway/status`，一次拿到 `{ gateway, upstream, models[] }`；拿不到时才回退直连 `127.0.0.1:7321`（老宿主 / 独立浏览器调试用）。

- **`path` 必须带 `/api` 前缀**：注册表按完整 pathname 索引（`fetchRoutes.get(url.pathname)`），且 `assertFetchRoute` 用 `endpointFromPath('/api', path)` 校验；参考实现 `dsh-deepseek-chat-import` 的常量就是 `/api/deepseek-chat-import/archive`。写成 `/dumate-gateway/status` 会注册失败、面板继续 `Failed to fetch`。
- 优点：无 CSP/CORS 变量、带 owner-peer 鉴权（浏览器用 `dsh-auth-*` cookie 自动鉴权，curl 无 cookie 得 401）。
- 实现：`src/host/status-route.js`（`createStatusReader` + `statusResponse` + `STATUS_PATH='/api/dumate-gateway/status'`）、`src/host/try-route.js`（`createTryHandler` + `TRY_PATH='/api/dumate-gateway/try'`）、`index.js` 里 `ctx.inject(['connection'], …)` 注册两条路由、`client.js` 的 `load()` 同源优先。
- 迭代方式：host 半区改完**不必重启 DSH**，用 `plugin_manager set_plugin` 把 `include:dumate-gateway` 先后置 `false` / `true` 即热重载（`application: "applied"`）；客户端半区刷新页面即可。


## 11. 配置 schema（默认值）

插件行的 config 就是这一份（`index.js` 里读 `settings.http` / `settings.requireReachable`）：

```yaml
http:
  enabled: true
  port: 7321
  token: null            # null = 不校验；非空时要求 Bearer / x-api-key
requireReachable: true   # false = 即使 DuMate 探活失败也照常转发（调试用）
models:
  mode: curated          # curated = 只列对话模型（默认）；all = 原样列出 43 条
  exclude: []            # 额外的隐藏规则：按 key 做大小写不敏感的子串匹配
```

**`models.mode` 的语义**（2026-11-15 深夜新增，起因是用户看到选择器里混着一堆 DuMate 内部模型）：
- `curated`（默认）隐藏三类：`model-*` 内部能力模型（routing / aiassist / validate / gui-use / mm / tm-* / wiki…）、`dm-auto-model/*` 六个自动路由档位、非对话端点（`qianfan-ocr`、`qwen3-embedding-*`、`qwen3-reranker-*`、`dumate-image*`、`llm-mock`）。本机实测 **43 → 16**。
- 隐藏是「不展示」而非「不可用」：手动指定被隐藏的 id 仍能正常转发（`resolveModel` 对未知 id 原样透传）。
- 隐藏 `model-text` 这个自名键后，别名 `glm-5` 会接管 `model-text` 这个 id，于是选择器里显示为「GLM 5」——这是单条最自然的呈现。
- 兜底：若筛选后为空，回落到完整表，不会把选择器清空。
- `all` 模式用于排错或想用内部模型时。

计划中的发现/健康轮询旋钮（`discovery.*`、`health.*`、`dumate.*`）v1 未做成配置项：DuMate 地址只从 live `opencode.json` 读（`DUMATE_OPENCODE_CONFIG` / `DUMATE_HOST_URL` 可覆盖），探活是每请求 600 ms TCP，没有后台轮询。未知字段忽略（前向兼容）。

校验：端口 1–65535（`0` 仅测试用，取随机口）；`http.token` 非字符串视为未设置。

## 12. 错误处理与降级矩阵

| 场景 | 行为 |
|---|---|
| 扫描全空 | 面板空态 + 提示，插件不报错 |
| 端口开着但不是模型服务 | 指纹失败，仅在调试日志记录 |
| `/v1/models` 200 但字段畸形 | 保留原 id，元数据走默认，标记 `source:'probe'` |
| 上游中途掉线 | 本次请求 `TRANSPORT`/`HTTP_502`，健康轮询置 offline，模型仍可选（badge 离线） |
| DuMate 未装 | 适配器不注册模型，面板提示如何装 |
| 网关端口被占用 | 顺延到 +1…+19，日志写明实际端口；面板显示真实端口 |
| DSH 重启 | registry 从 `state.json` 恢复上次上游快照，立即显示（状态 unknown），1 s 后开始探测 |

## 13. 安全与隐私

- 只绑定 `127.0.0.1`，不监听 `0.0.0.0`。
- 不落盘任何上游凭据；`state.json` 只存上游地址、标签与既定模型 id。
- DuMate 的 inapp key 只在内存中缓存 30 s。
- 日志脱敏：任何 key/token 只打印前 4 位。
- 不做遥测。

## 14. 测试策略

- **单元**：端口表解析、模型 id 生成与冲突、元数据优先级链、错误映射、配置校验、SSE 解析器（含跨 chunk 的分包）。
- **集成**：用 `node:http` 起假上游（正常/畸形/500/慢响应/断流），验证发现、健康状态迁移、流式转发、取消。
- **DSH 内 e2e**：装进 profile → 模型选择器出现模型 → 发一句话拿到流式回复。真实上游用**假上游 + Ollama（若已装）**，**不再用 ZCode 反代**（已封，红线）。
- **DuMate e2e**：DuMate 1.0.92 已装且 **6 项真机复验已于 2026-11-15 22:10 跑完**（§7.5）；启动 DuMate 后直接验模型名、真流式、取消。B 面（会话历史/隔离）v1 不做。
- **手工**：curl 三个端点；Claude Code 指向网关跑一轮；重启 DSH 后状态恢复。

## 15. 发布形态

- 仓库：`github.com/titor-jz/dsh-dumate-gateway`，MIT。
- npm：**定名 `dsh-dumate-gateway`**（用户要求「主要名字要带 DuMate」）。2026-11-15 实测：`registry.npmjs.org` 与 `registry.npmmirror.com` 对该名均 **404（可用）**；同在 DuMate 语义下的 `dumate-gateway`、`dumate-llm-gateway`、`dumate-llm-proxy`、`dsh-dumate`、`@titor-jz/dsh-dumate-gateway` 也都 404，可作备选；`dsh-llm-dumate` 已被社区插件占用（200），不要用。原定名 `dsh-llm-gateway` 已于 2026-10-07 被第三方发布 0.0.1（自称 "alias of dsh-ai-gateway"），不可用。包内含 `install` 子命令，写 profile 的 bundle 配置，参考 dsh-llm-dumate 的 CLI。
- 本地工作目录保留 `dsh-llm-gateway/`（只影响路径，不影响发布名），仓库与 npm 用新名。
- 目录：

```
dsh-dumate-gateway/
  package.json          # dsh.bundle.patch + dsh.client + bin
  cordis.patch.yml      # insert only，不禁用 llm-pi-ai
  index.js              # 插件入口（Host）
  client/               # 侧栏面板
  src/                  # 见 4.1
  locale/zh.json en.json
  docs/DETAIL.md        # 插件详情页（DSH 市场）
  docs/demo.gif
  README.md README.zh.md
  LICENSE
```

- README 结构：一句话定位 → GIF → 30 秒安装 → 3 个使用场景（发现 Ollama / 接 DuMate / 给 Claude Code 用）→ 与 llm-pi-ai、dsh-llm-dumate、dumate2api 的区别 → 配置 → 已知限制 → 排错。

## 16. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 骨架 + 发现 | 插件能装；扫到本机模型服务（假上游 / Ollama）；模型进选择器；能对话 | 选择器出现真实条目（如 `local-11434/llama3.2`、假上游模型），发消息有流式回复 |
| M2 DuMate 反代 | A 面适配器 + 流式 | DuMate 在线时可选真实模型并流式回复；离线时准确降级不报错 |
| M3 HTTP 网关 + 侧栏 + 发布 | `/v1/*` 三个端点；侧栏面板；README/GIF/npm | curl 通；Claude Code 跑通；`npx` 安装成功 |

依赖：M2 的 e2e 需要**启动已安装的 DuMate 1.0.92**（`D:\DuMate`，当前未运行、无需重装）。M1/M3 **不再依赖 ZCode 反代**——该上游已于 2026-11-15 被风控封锁（`405 code=3012`），按红线不得再请求，验收改用假上游 + Ollama。

## 17. 风险与待验证项

1. **DuMate A 面的 `model` 字段接受哪个值**（`glm-5` / `model-text` / `QianfanPersonalQuota/glm-5`）——三个都试一次；都失败才退到 B 面的 L0/L1/L2 档位。
2. **A 面 `stream:true` 是否真 SSE**——后端二进制有 `text/event-stream` / `X-Accel-Buffering`，仍需真机确认逐块；不成立才退回伪流式（§7.3）。
3. ~~**DSH 0.2.2-rc.1 的 client 插件 API 细节**（侧栏 slot 注册方式）~~ —— **已关闭（2026-11-15 P0-V1）**：两段式注册（`sidebarRightTabs.register` + keyed slot `sidebar.right.pane.tab`）已由 4 个自带包的 `lib/client.js` 实证，契约见 §10.1 与 `docs/superpowers/notes/2026-11-15-probes.md`。
4. **进程环境变量注入的稳定性**（PowerShell 依赖、杀软误报）——失败时退化到「手动填地址+key」。
5. **反代的法律/条款风险**：DuMate 属逆向接口，README 需写明「仅供个人学习，可能违反服务条款，账号风险自负」，且默认关闭（配置里 `dumate.enabled` 默认 true 但 README 强调）。
6. **ZCode 反代被上游封锁**：`405 {"code":3012,"msg":"request has been blocked due to unusual activity."}`、`retryable=false`。P2/P3 的验收不能再用它，改用假上游 + Ollama；**不得重试、不得换入口探测**（`~/.dsh/AGENTS.md` 红线）。
7. **侧栏的 CSP / CORS**：面板直连 `127.0.0.1:7321` 是否被页面 CSP 的 `connect-src` 拦，尚未实测；被拦则退到 DSH client `remote` RPC（§10.3 候选 B）。
8. **社区参考实现抄窄了**：4 个仓库只走 B 面（同步 POST + 一次 GET），据此曾误判「无 SSE / 无 model 字段」；1.0.92 的安装目录证明 A 面是 OpenAI 兼容代理、B 面有 `/global/event` SSE 与 `model:{providerID,modelID}`。**教训：先读产品二进制，再信社区实现。**
9. **DuMate 端口是动态的**：`config.yml` 默认 8980、本机曾为 52867、社区常量 52795 在二进制里 0 命中 → 从 opencode.json 的 `baseURL` 读真实端口，面板显示并允许覆盖；扫 8980 只作兜底（§7.2）。
10. **取消语义未证**：A 面关连接是否让后端停止生成/计费未知，README 如实标注；B 面确认没有 abort 端点（§7.4）。

## 18. 决定记录

- **不做 provider 配置注入**（写成 llm-pi-ai 的 YAML）：模型列表静态、拿不到动态 badge、每次发现都要改配置并重载；DSH 的 adapter 契约本来就是给这种情况准备的。
- **不复用 dumate2api**：它是独立进程 + 管理端 + 四条通道，装进 DSH 还得再搭一层；但它的协议知识（模型表、输出上限、错误语义）直接借鉴。
- **零运行时依赖**：只需要 Node 内建 `fetch`、`node:http`、`node:fs`；SSE 解析自己写 30 行。避免 playwright-core 那种 100 MB 依赖。
- **不做多上游故障切换**：v1 先证明「发现 + 反代」两条腿，切换逻辑等有真实需求再加。

## 19. P0 结论与前提变更（2026-11-15 晚追加）

探针记录全文见 `docs/superpowers/notes/2026-11-15-probes.md`。本节每条都改动了上面某节的前提，读设计时**以本节为准**。

- **V1 通过**：右侧栏可做，注册契约已实测（补 §10.1），§17.3 关闭。P6 不再有可行性风险，只剩 §10.3 的数据通道待定（CSP 是唯一未知）。
- **V2 / V3 从「阻塞」→「静态已答」→「真机已验证」**：DuMate 1.0.92 已装（`D:\DuMate`），2026-11-15 22:10 启动后实测：A 面 `POST /api/qianfanproxy/v1/chat/completions` 是真 SSE（8 chunk/434 ms，`reasoning_content`→`content`），chat 端点无需 inapp key，`glm-5`/`model-text` 均可用，`/models` 与 `/global/health` 分别为 404/401。**v1 只做 A 面 1:1 代理转发**，会话映射降为 v2 → §7 已按实测重写。
- **架构简化**：DuMate 通道不再需要 session/message 映射与伪流式；「取消」变成关上游连接；端口从 opencode.json 的 `baseURL` 读而不靠猜测。
- **npm 包名被占**：原定 `dsh-llm-gateway` 已有第三方 0.0.1 → 已定名 `dsh-dumate-gateway`（两 registry 均 404 可用，§15）。
- **ZCode 反代被风控封锁**：不再作为发现/转发的验收上游（§1.3、§16 已改），P2/P3 用假上游 + Ollama。
- **plan 同步**：计划 §1（P0 出口）、§2（P2 出口）、§3（P3 e2e）、§11（待拍板项）已按本节更新。

### 10.4 P6 实现状态（2026-11-15 深夜）

已按 10.1/10.2 写好 `client.js`（未构建、未加依赖）：

- **类型**：`ctx.sidebarRightTabs.register({id:'dsh-dumate-gateway', kind:'dumateGateway', priority:'extension', keepMounted:true, title:()=>'DuMate', guide:[{id:'status', order:60, title:'DuMate gateway', description:'Upstream status and the models it offers'}]})`；
- **渲染体**：`ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({name:'sidebar.right.pane.tab', key:'dsh-dumate-gateway', locale:'dumateGateway'}, Panel))`；两处注册都在各自 `ctx.effect` 里；
- **数据通道**：候选 A（直连 `http://127.0.0.1:7321` 的 `/health` + `/v1/models`，15 s 自动刷新）。网关已对这些端点放行回环源 CORS；**CSP 的 `connect-src` 是否放行仍待重启后实测**，被拦则按 10.3 退到候选 B；
- **面板内容**（v1）：状态点 + 上游地址 + 模型总数、模型列表（id + 窗口 + 模态，点击复制 id）、离线/错误空态、底部网关地址 + 版本 + `curl` 示例；
- **未做**：文案仍未接 `locale` 服务的 `t()`（先用英文字面量，`locale/dumateGateway` 命名空间已备好键）、端口非 7321 时面板不会探测、无「添加提供商」图形配置。

**验证**：`node test/client-plugin.mjs` 用假 React + 记录型 ctx 跑通工厂注册与一次渲染（2 个注册、2 个 disposer）；浏览器内实际效果需重启 DSH 后在右侧栏确认。
