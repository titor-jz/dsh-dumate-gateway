# DuMate gateway

Adds local OpenAI-compatible model services to DeepSeek Harness, starting with the DuMate desktop app.

## What it does

Once installed, the bundle registers a `gateway` provider route on the harness LLM service. The
route advertises the models it can serve, so they appear in the model selector, and streams replies
through the standard harness chunk protocol.

## Current state

- Registers a `gateway` provider route whose catalog is the live DuMate model table (43 models on the
  author's install), so those models appear in the model selector with their real context windows.
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

## Requirements

- DeepSeek Harness 0.2.2 or newer.
- Node.js 22 or newer on the host.
- The DuMate desktop app installed and running on the same machine.

## Limits

- Talks only to the loopback DuMate proxy; never exposes the gateway beyond the local machine.
- Sends no credentials: the loopback chat endpoint needs none, and the in-app key is neither read nor stored.
- DuMate rate-limits rapid repeated requests; a burst of test calls can surface `RATE_LIMIT`.
