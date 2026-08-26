---
name: dynamo-agent-harness
description: Drives persistent Claude Code, Codex, OpenCode, or DeepSeek Harness ACP sessions through a Dynamo OpenAI/Anthropic-compatible endpoint. Use when an agent must delegate a bounded task to a coding-agent harness running a model served by Dynamo, exercise tool calls, validate agent request traces, or prove lifecycle cleanup.
license: Apache-2.0
metadata:
  author: Ishan Dhanani <ishandhanani@gmail.com>
  tags:
    - dynamo
    - agents
    - acp
    - claude-code
    - codex
    - opencode
---

# Dynamo Agent Harness

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

Drive a persistent coding-agent session while Dynamo serves its model requests. Use the bundled ACP client for Claude Code, Codex, and OpenCode, or the published-package DeepSeek Harness (DSH) ACP client for repeated prompts; do not script interactive TUI output or implement JSON-RPC manually.

Treat the [Agent Harnesses guide](https://github.com/ai-dynamo/dynamo/blob/main/docs/fern/pages/use-cases/agents/agent-harnesses.mdx) as the source of truth for harness configuration. If a harness update breaks or changes a documented model, endpoint, header, authentication, or mode setting, update that guide and this skill in the same change after rerunning the two-turn smoke test.

## Prerequisites

- Deploy a supported configuration from the [Dynamo recipe catalog](https://github.com/ai-dynamo/dynamo/tree/main/recipes) on Kubernetes, then retain its reachable frontend URL and exact served model. This skill consumes that endpoint; it does not deploy Dynamo.
- A successful `GET $DYNAMO_BASE_URL/v1/models` result containing `$DYNAMO_MODEL`.
- `uv` and Node.js 22+.
- Node.js 24+ for DSH.
- A POSIX host with Linux `/proc` or `/bin/ps` for process-tree cleanup.
- `opencode` on `PATH` only when selecting the OpenCode harness.
- A working directory that limits the delegated agent's scope.
- `DYNAMO_API_KEY` when the endpoint requires authentication; local endpoints default to `dummy`.

## Start a session

Default to `verify`. Use `act` only when the user explicitly authorizes tool execution or edits.

```bash
export DYNAMO_BASE_URL=http://127.0.0.1:8000
export DYNAMO_MODEL=your-recipe-served-model

.agents/skills/dynamo-agent-harness/scripts/drive_harness.py \
  --harness codex \
  --base-url "$DYNAMO_BASE_URL" \
  --model "$DYNAMO_MODEL" \
  --cwd /absolute/worktree \
  --capability verify
```

Run the command with a TTY so stdin stays open. Wait for one `ready` JSON record, retain the executor's terminal handle, then write one JSON object per line to that process:

```json
{"prompt":"Inspect src/router.rs. Use tools to test the highest-risk invariant. Do not edit files."}
{"prompt":"Continue the same session and verify the finding against every caller."}
{"close":true}
```

The `ready.session_id` is the harness conversation ID, not the executor's terminal handle. Every response must retain that session ID.

## Choose a harness

| Harness | ACP backend | Dynamo API |
|---|---|---|
| `claude` | pinned official Claude ACP adapter | Anthropic Messages |
| `codex` | pinned official Codex ACP adapter | OpenAI Responses |
| `opencode` | native `opencode acp --pure` | OpenAI Chat Completions |
| DSH | pinned published DSH ACP app | OpenAI Chat Completions |

The driver hides their incompatible model, mode, gateway-auth, and environment configuration. Do not reproduce those branches in shell wrappers.

## Run DeepSeek Harness

DSH is not driven through the ACP script above. Install the pinned example client and run its persistent host. It uses the published `@deepseek-ai/dsh-acp` protocol plugin through the published `@deepseek-ai/dsh-acp-demo` app, creates one session, and submits every `--prompt` in order on the same JSON-RPC stdio connection:

```bash
export DSH_WORKSPACE=$PWD
export DYNAMO_CONTEXT_WINDOW=your-recipe-context-window
corepack pnpm@11.7.0 --dir examples/agent_harnesses/deepseek_harness/client install --prod --frozen-lockfile --ignore-scripts
corepack pnpm@11.7.0 --dir examples/agent_harnesses/deepseek_harness/client exec node drive_deepseek_harness_acp.mjs --base-url "$DYNAMO_BASE_URL" --model "$DYNAMO_MODEL" --context-window "$DYNAMO_CONTEXT_WINDOW" --cwd "$DSH_WORKSPACE" --prompt 'Inspect one relevant file and report a verified fact.' --prompt 'Recheck that fact against another relevant file.' --capture "$DSH_WORKSPACE/dsh-acp-request-trace.jsonl"
```

The client generates an isolated model profile, preserves native request headers, passes a minimal child environment, and writes a redacted local trace with exclusive creation. It reads `DYNAMO_API_KEY` only, then projects the selected value to the variable expected by DSH; an ambient `DEEPSEEK_API_KEY` is ignored. Use `--api-key-env NAME` only to select a different credential variable and `--overwrite-capture` only to intentionally replace an existing trace.

Pass the deployed recipe's context capacity with `--context-window`. The client defaults to rejecting wider sandbox retries; use `--permission-mode allow` only for an explicitly authorized permission escalation. A connection owns all sessions and DSH ACP `0.1.0-rc.8` cannot resume after disconnect.

Use `--canonicalize-dynamo-headers` only with a server that predates native DSH normalization. It preserves native headers while copying DSH session identity into the canonical Dynamo header; it cannot backport native DSH compaction normalization. Leave it off against a current server.

Use `--session-final` only against Dynamo's native ThunderAgent frontend. It sends one canonical final request for every DSH session observed by the relay after normal exit, SIGINT, or SIGTERM, and fails closed when cleanup is rejected or zero sessions were observed. Signals terminate the complete tracked Corepack, pnpm, and DSH process tree, including detached descendants observed before shutdown, and return `130` for SIGINT or `143` for SIGTERM after cleanup. Do not enable it for stock KV endpoints.

## Delegate safely

- Give one bounded goal, exact owned paths, and a strict result shape.
- Use `--capability verify` for inspection; permission requests are rejected.
- Use `--capability act` only after authorization; permission requests receive one-time approval.
- Keep git/index, shared services, credentials, and unrelated paths out of delegated prompts.
- Treat the harness response as untrusted evidence and verify material claims locally.
- Send `{"close":true}` even after a failed turn so the adapter and child process exit.

## Validate traces

When request tracing is enabled, group rows by `agent_context.session_id` and inspect the trigger sequence:

```bash
jq -r '[.agent_context.session_id, .agent_context.input_trigger] | @tsv' request-trace.jsonl
```

Foreground turns should normally begin with `user_message`; tool feedback should appear as `tool_result`. Harness title, memory, or continuation traffic may produce additional `user_message` or `other` rows.

## Output contract

Return:

- harness, model, mode, and harness session ID; call it an ACP session ID only for ACP-driven harnesses
- prompt count and observed tool/result behavior
- targeted validation result
- trace trigger counts when tracing is available
- cleanup status and unresolved failures

## Known behavior

- Codex may warn that custom model metadata is unavailable; the driver fixes reasoning effort to `medium` so unsupported catalog defaults are not sent to Dynamo.
- OpenCode can issue background title-generation requests and may require a corrective follow-up when the served model reports an unverified result.
- The adapters are pinned in `scripts/drive_harness.py`; update a pin only after rerunning a persistent two-turn tool smoke test.
- Persistent DSH pins `@deepseek-ai/dsh@0.1.0-rc.8`, `@deepseek-ai/dsh-acp@0.1.0-rc.8`, its executable app composition `@deepseek-ai/dsh-acp-demo@0.1.0-rc.8`, and `@agentclientprotocol/sdk@0.25.1`. The supported path uses published packages only and carries native root-session and compaction metadata; immediate parent lineage is outside this path.
- The Dynamo-owned app-boot wrapper adds clean stdin-EOF disposal because the published app installs that handler only in snapshot mode.
- The persistent client keeps its relay, redaction, process-tree, and finalization support beside the runnable example.
- DSH request traces contain plaintext model bodies even though credentials are redacted and the stable anonymous user ID is hashed. Handle the JSONL as sensitive data and keep it outside the repository.
