# DuMate gateway

Adds local OpenAI-compatible model services to DeepSeek Harness, starting with the DuMate desktop app.

## What it does

Once installed, the bundle registers a `gateway` provider route on the harness LLM service. The
route advertises the models it can serve, so they appear in the model selector, and streams replies
through the standard harness chunk protocol.

## Current state

- Registers a `gateway` provider route whose catalog is the live DuMate model table, curated to chat
  models by default (43 raw rows collapse to 17 on the author's install), so those models appear in
  the model selector with their real context windows.
- Forwards chat completions to the DuMate proxy with true streaming: reasoning and text arrive as
  separate blocks, usage is reported before the finish chunk.
- Exposes a thinking level (Off / On) for the models that support it, mapped onto DuMate's single
  `thinking: {type: 'disabled' | 'enabled'}` switch rather than onto `reasoning_effort`, which the
  proxy accepts and ignores (see "Thinking control" below).
- Reads the proxy address from the file DuMate writes on every launch, so a moving port needs no
  configuration.
- When DuMate is not running at all, the catalog falls back to a single placeholder model that
  explains how to start the app instead of failing silently.
- A loopback HTTP gateway on `127.0.0.1:7321` exposes the same upstream as OpenAI
  (`/v1/models`, `/v1/chat/completions` with SSE) and minimal Anthropic (`/v1/messages`), so curl,
  scripts and Claude Code can use it without DSH.
- A right-sidebar panel shows the upstream status and the model list, with click-to-copy model ids
  and a ready-to-paste curl example; it refreshes every 15 seconds and explains what to do when
  DuMate is offline.
- Optional headless mode: starts DuMate's two background binaries (`dumate-base-proxy` and
  `dumate-main-server`) without the Electron window. Two processes and about 59 MB instead of
  fourteen and about 1 GB, with identical streaming. It reuses the account already stored in
  `auth.json`, generates the per-launch nonce the backend expects, and does nothing while the
  desktop app is running.

## Headless mode

The desktop app is a shell around two binaries. Starting those two directly is enough for this
gateway — verified on DuMate 1.0.92 with the app fully closed: non-streaming and streaming
completions both answer, two processes, ~59 MB resident.

Four details decide whether it works, and `src/upstream/headless.js` handles all of them:

1. the backend refuses to start without a login context (`loginMode is required`), which is rebuilt
   from `auth.json`;
2. `DUMATE_INAPP_KEY` is a per-launch shared nonce, not a secret, so a fresh one is generated — and
   one nonce per start, used by both processes, because the base proxy takes it as an HTTP proxy
   password while the backend sends it as `X-Dumate-Inapp-Key`;
3. the backend resolves its data directory relative to the process working directory, which must be
   `%APPDATA%\qianfan-desktop-app`;
4. **the backend must be given the shell's proxy environment.** The Electron shell does not only
   pass `DUMATE_*`; it also sets `HTTP(S)_PROXY` to
   `http://proxy:<nonce>@127.0.0.1:<base proxy port>`, so the backend reaches the gateway *through
   the base proxy*, which resolves the hostname itself. Started without that, the backend uses the
   machine's own resolver, and an intermittent one shows up as a failed run in the harness —
   `failed to forward request to upstream` in the UI, `dial tcp: lookup dumate-svc.baidu.com: no
   such host` in `Main.log`, repeated for every retry. This was a real, reported outage on
   2026-11-18 21:06 and 21:16; the same minute buckets in the log hold 15 and 8 resolver failures,
   while the headless gateway logged **924 `status=200` and zero upstream failures** in that window,
   which is why the failure looked like the harness's own forwarding and not the backend's DNS.

   The login and nonce alone are not enough, and the symptom is misleading: everything looks
   healthy (`/health` reports `online: true`, models list fine) until a request needs the upstream
   and the resolver happens to fail.

The plugin never starts anything by itself: `headless.enabled` adds the capability, `autoStart`
(default `false`) is the only way to opt into load-time starts, and `stopOnUnload` defaults to
false so a DSH restart does not kill the backend you are using.

Two safety rules keep it from doing damage:

- `stop()` kills a pid only after `Get-Process -Id <pid>` reports an image name containing
  `dumate-main-server` or `dumate-base-proxy`. Windows recycles pids, and killing an unrelated
  process tree is worse than leaving one behind; a pid that is already gone counts as a match so
  the `taskkill` fails harmlessly.
- **the pid worth killing is the listener, not the launcher.** Both binaries start through a
  one-line `cmd /c` wrapper (the wrapper is what carries the per-launch environment), and that
  wrapper exits as soon as it has handed off, so the pid `Win32_Process.Create` returns is already
  dead a moment later. `stop()` therefore also resolves whoever is listening on the two configured
  ports through `netstat -ano`, still gated on the image name, and the state file records the
  listening pid when one is visible. Fixed in 0.0.6, after a real run reported `stop` succeeded
  while both processes were still up — 2 processes and ~59 MB that the panel said were gone.
- the desktop app and these two processes share one data directory, and nobody has verified what
  DuMate does when both are up. `status()` therefore reports `desktopBaseURL` when the app's own
  endpoint answers (probed at the URL the app wrote to its state file, not at the headless
  override), and the panel shows a warning. It never stops one of them on its own.

`readCatalog()` returns both `baseURL` (what requests go to, which headless may override) and
`fileBaseURL` (what the app last wrote); only the latter can tell whether the app itself is
serving.

## Tool calls

`tools` are forwarded unchanged and `tool_calls` come back, but DuMate's proxy does not keep one
call on one index: the chunk that carries `id` and `name` is `index: 0`, while the argument JSON
pieces that follow are `index: 1`, `1`, … with no id and no name. A client that groups deltas by
index (the OpenAI SDKs, and DSH's own streaming parser) would see several nameless calls and lose
the arguments, so `src/upstream/openai-client.js` folds the fragments back into one event per call
before anything else sees them. Two real calls stay two: a fragment that carries an id starts a new
call. `test/tool-calls.mjs` pins the behaviour against a fake upstream, and the same merge is
verified against the real backend.

## Images

The harness never puts image bytes on the wire: an `image` block carries an opaque
`ImageAttachmentRef` (`attachmentId`, `mediaType`, dimensions) and the durable binary lives in the
`attachments` service. The adapter therefore asks the host for a `data:` URL per block
(`ctx.get('attachments').readImage(ref)`), and `src/messages.js` places the result next to the text
as an OpenAI `image_url` part. Any failure — no service, an offloaded block, bytes over 4 MB, a
storage error — degrades to the `[image attachment]` placeholder instead of failing the turn.

Only models that declare the `image` input modality receive pictures; the picker already reflects
DuMate's own `modalities.input`. Verified against the real backend: a 76 KB screenshot goes through
as one image part and the model describes its contents (`prompt_tokens` 1022 for that request).

## Thinking control

DuMate has exactly one thinking switch, and it is not the one the OpenAI API documents. Measured
against the live proxy with `reasoning_tokens` as the observable (`deepseek-v41-flash`, 24-token
budgets and a fixed prompt unless noted):

| Attempted control | Result |
| --- | --- |
| `reasoning_effort: "high"` vs `"low"` | accepted, ignored — 19 reasoning tokens either way |
| `enable_thinking` | ignored |
| `thinking_budget`, `thinking_budget_tokens`, `thinking_token_budget` | ignored |
| `chat_template_kwargs` | ignored |
| `thinking: {type: "enabled", budget_tokens: 256}` vs `16384` | budget ignored — ~130 reasoning tokens both ways, and the direction is not even consistent across models (deepseek-v41-flash 136/129, glm-53 116/136, deepseek-v4-pro 193/116, qwen3.8-max 163/61) |
| **`thinking: {type: "disabled"}`** | **works** — no `reasoning_content`, `completion_tokens` 21 → 2 |
| `thinking: {type: "enabled"}` | works, and matches the no-field default |

So the adapter offers two levels, never a ladder: `Off` sends `{type: 'disabled'}`, `On` sends
`{type: 'enabled'}`, and an untouched selector sends no field at all. `src/reasoning.js` owns the
mapping; `resolveModel()` exposes the list to the picker through the harness's
`LlmModelReasoningInfo`, and the HTTP gateway translates `reasoning_effort` (OpenAI) and
`thinking` (Anthropic) onto the same two values.

**No `defaultEffort` is declared on purpose.** The harness materializes a declared default into
every request, so declaring `on` would add a `thinking` field to every call — including sessions
where nobody has ever opened the picker — changing existing behaviour to gain nothing, because the
upstream already thinks by default. Leaving it absent keeps "nothing selected" meaning "nothing
sent".

Per-model behaviour, all 17 curated models probed with `{type: 'disabled'}`:

- **obeys**: `deepseek-v4-flash-0731`, `deepseek-v4-pro`, `deepseek-v41-flash`, `doubao-seed-2-0-pro`,
  `ernie-4.5-turbo-vl-32k`, `qwen2.5-vl-32b-instruct`, `qwen3.5-27b`, `qwen3.5-35b-a3b` (which had
  no reasoning to begin with), `qwen3.5-397b-a17b`, `qwen3.8-max`, `qwen38-flash`, `qwen4-max`,
  `model-text`;
- **partly obeys** — still emits a little reasoning: `glm-53`, `glm-53-flash`, `kimi-k31` (32–41
  reasoning tokens with a non-empty `reasoning_content`); their Off text says so;
- **refuses** `Off`: `kimi-k3`, reproducible 400 `invalid temperature: only 0.6 is allowed for this
  model` (the backend forwards that error from `tp.sdns.baidu.com`), which pinning
  `temperature: 0.6` did not fix — so that model shows a single `On` level instead of a broken
  option.

`{type: 'enabled'}` is accepted by every model.

## Requirements

- DeepSeek Harness 0.2.2 or newer.
- Node.js 22 or newer on the host.
- The DuMate desktop app installed and running on the same machine (or installed, signed in once, and
  used through headless mode).

## Limits

- Talks only to the loopback DuMate proxy; never exposes the gateway beyond the local machine.
- Sends no credentials: the loopback chat endpoint needs none, and the in-app key is neither read nor stored.
- DuMate rate-limits rapid repeated requests; a burst of test calls can surface `RATE_LIMIT`.
- Headless mode cannot run on a machine that has never signed in to DuMate: it reuses the stored
  account rather than asking for one.

### Usage numbers and the host's own statistics

The ledger splits the prompt into three disjoint buckets, exactly like the host's
`TokenUsage`: `input_tokens` is uncached input only, and `cache_read_tokens` /
`cache_write_tokens` are counted separately. The panel's total adds all three plus
output, which is what Settings → Usage prints; a panel that showed only uncached
input would read about thirty times smaller than that page once prompt caching
kicks in.

Two processes share `~/.dsh/dumate-gateway/usage.json` (the host plugin and the
loopback HTTP gateway), so each write re-reads the file when its mtime changed and
merges counters with `max` rather than clobbering the other writer's rows.

Rows written before 0.0.3 lack the cache keys and read as zero. They can be
recovered from the DSH session logs, which record the full per-call usage
attributed to the provider:

```bash
node tools/backfill-cache.mjs           # dry run: shows each day's before/after
node tools/backfill-cache.mjs --write   # writes usage-recovered.json
```

The recovery lands in `~/.dsh/dumate-gateway/usage-recovered.json`, not in
`usage.json`, and the usage module folds it in on every read. That separation is
deliberate: a host process still running a pre-0.0.3 release rewrites
`usage.json` from its own memory on each request, so anything written to that
file from outside disappears on the next call. A file the old code never heard of
survives until the process is restarted.

### Signing in once is enough

Headless mode reads the account the desktop app stored in
`%APPDATA%\qianfan-desktop-app\auth.json` (an `accountProfiles` entry plus the
session cookies the app keeps beside it). Two consequences:

- You sign in **once** in the desktop app; after that the window can stay closed.
  The background backend refreshes those cookies itself — on this machine
  `auth.json` was rewritten while only the two headless processes were running.
- Open the desktop app again only if the session actually lapses (the panel shows
  `signedIn: false`), you switch accounts, or the app data directory is removed.
  A machine that has never signed in cannot use headless mode at all.
