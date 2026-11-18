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

Three details decide whether it works, and `src/upstream/headless.js` handles all of them:

1. the backend refuses to start without a login context (`loginMode is required`), which is rebuilt
   from `auth.json`;
2. `DUMATE_INAPP_KEY` is a per-launch shared nonce, not a secret, so a fresh one is generated;
3. the backend resolves its data directory relative to the process working directory, which must be
   `%APPDATA%\qianfan-desktop-app`.

The plugin never starts anything by itself: `headless.enabled` adds the capability, `autoStart`
(default `false`) is the only way to opt into load-time starts, and `stopOnUnload` defaults to
false so a DSH restart does not kill the backend you are using.

Two safety rules keep it from doing damage:

- `stop()` kills a pid from the state file only after `Get-Process -Id <pid>` reports an image name
  containing `dumate-main-server` or `dumate-base-proxy`. Windows recycles pids, and killing an
  unrelated process tree is worse than leaving one behind; a pid that is already gone counts as a
  match so the `taskkill` fails harmlessly.
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
