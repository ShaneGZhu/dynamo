<!--
SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# DeepSeek Harness with Dynamo

This package-only recipe drives one persistent DeepSeek Harness (DSH) ACP session against an existing Dynamo OpenAI-compatible Chat Completions endpoint. It sends repeated prompts through one connection-owned session, preserves DSH-native root-session and compaction metadata on the model-hidden transport, captures a redacted local request trace, and can send an explicit terminal signal to the native ThunderAgent router after normal or interrupted shutdown. The recipe does not deploy Dynamo or prescribe a Kubernetes topology.

## Dependencies

| Artifact | Revision |
| --- | --- |
| Published DSH client | `@deepseek-ai/dsh@0.1.0-rc.8` |
| Published DSH ACP transport plugin | `@deepseek-ai/dsh-acp@0.1.0-rc.8` |
| Published runnable DSH ACP app | `@deepseek-ai/dsh-acp-demo@0.1.0-rc.8` |
| Published ACP SDK | `@agentclientprotocol/sdk@0.25.1` |
| Client dependency graph | [`client/pnpm-lock.yaml`](client/pnpm-lock.yaml), installed by pnpm `11.7.0` with `--frozen-lockfile` |

No DSH source checkout or source patch is part of this path. Immediate parent lineage is not part of the contract because the published package does not emit it.

## Before you begin

Complete the shared [agent-harness prerequisites](../README.md), including deployment of a supported Dynamo recipe. This runbook assumes `DYNAMO_BASE_URL` and `DYNAMO_MODEL` identify that recipe's reachable frontend and exact served model. `DYNAMO_BASE_URL` may include `/v1`; the client normalizes either form. Export `DYNAMO_API_KEY` when the endpoint requires authentication.

## Run a persistent ACP session

Install the pinned client graph, retain the current workspace path, and pass at least two ordered prompts. The client keeps one JSON-RPC stdio connection, calls `session/new` exactly once, then calls `session/prompt` sequentially for the returned session ID. It writes one `ready`, one `turn` per prompt, and one `closed` JSON record to stdout. The default permission policy rejects wider sandbox retries; select `--permission-mode allow` only when a permission escalation is explicitly authorized.

```bash
export DSH_WORKSPACE=$PWD
export DYNAMO_CONTEXT_WINDOW=your-recipe-context-window
corepack pnpm@11.7.0 --dir examples/agent_harnesses/deepseek_harness/client install --prod --frozen-lockfile --ignore-scripts
corepack pnpm@11.7.0 --dir examples/agent_harnesses/deepseek_harness/client exec node drive_deepseek_harness_acp.mjs --base-url "$DYNAMO_BASE_URL" --model "$DYNAMO_MODEL" --context-window "$DYNAMO_CONTEXT_WINDOW" --cwd "$DSH_WORKSPACE" --prompt 'Inspect this workspace and report one verified fact.' --prompt 'Recheck that fact against another relevant file.' --capture "$DSH_WORKSPACE/dsh-acp-request-trace.jsonl"
```

Pass the context capacity exposed by the deployed recipe with `--context-window`; DSH uses that value to calculate compaction pressure independently of the per-request `--max-tokens` output cap. The capture path uses exclusive creation, so choose a new local path for each run. Add `--overwrite-capture` only when replacing that exact file is intentional.

`@deepseek-ai/dsh-acp` is the published Cordis protocol plugin that implements the ACP server and owns fresh DSH agents. It is not an executable. `@deepseek-ai/dsh-acp-demo` is the published runnable app composition that embeds that plugin with the agent spine and persistence services. The Dynamo-owned client launches that app while pinning both packages. Its generated deployment composition adds the published Dynamo model adapter, workspace sandbox, approval policy, tools, token meter, and compaction plugin. Every plugin path is resolved from the pinned installation before the isolated DSH home starts; no DSH checkout is searched.

The published app installs its explicit stdin-EOF disposer only in snapshot mode. This recipe therefore uses a small lifecycle wrapper around the public `@deepseek-ai/dsh-app-boot` API so ordinary runs dispose and flush the same published app on EOF. This is Dynamo-owned launch glue, not a DSH source patch. Startup and session creation default to 30 seconds, each prompt to 120 seconds, and shutdown to five seconds. A prompt timeout sends `session/cancel`; normal completion closes stdin and waits for app disposal; a stuck process tree receives bounded SIGTERM and SIGKILL fallbacks and makes the run fail. SIGINT and SIGTERM retain exit codes `130` and `143` after cancellation and cleanup.

## Legacy Dynamo compatibility bridge

Add `--canonicalize-dynamo-headers` to the persistent client only when the selected recipe intentionally runs a legacy Dynamo release that predates native DSH normalization. The relay preserves the native DSH header and also copies its session value to `x-dynamo-session-id`. This restores identity and affinity on that older server, but it cannot add native DSH compaction normalization. Leave the option off for current deployments so the native mapping remains the contract under test.

## ThunderAgent terminal cleanup

Add `--session-final` to the persistent client only when the endpoint is the native ThunderAgent frontend. The relay records every observed DSH session, waits for DSH to flush and exit, then sends one model-hidden `x-dynamo-session-final: true` request per session. It does the same after SIGINT or SIGTERM, bounds each terminal call to five seconds by default, and exits nonzero if Dynamo rejects cleanup or if no DSH session reached Dynamo. SIGINT and SIGTERM terminate the complete tracked Corepack, pnpm, and DSH process tree, including detached descendants observed before shutdown, and retain conventional exit codes `130` and `143` after the bounded drain.

Do not use `--session-final` with a stock KV frontend. Stock KV has no program lifecycle to close, and a generic Chat Completions frontend could treat the terminal envelope as ordinary model work. ThunderAgent consumes it at the router before model forwarding.

## Verify

Run the focused checks from the repository root:

```bash
node --test examples/agent_harnesses/deepseek_harness/client/test_deepseek_harness_support.mjs
node --test examples/agent_harnesses/deepseek_harness/client/test_drive_deepseek_harness_acp.mjs
cargo test -p dynamo-llm --no-default-features agent_context_from_deepseek_harness_headers_preserves_compaction
```

The first suite covers the shared relay, environment, capture, process-tree, and lifecycle support imported by the persistent ACP client. The second covers the persistent ACP protocol and app-launch path. Set `DSH_ACP_PACKAGE_SMOKE=1` for an additional published-package smoke in the second suite. For a live tool run, retain the relay JSONL, Dynamo request trace, exact deployed recipe revision, DSH stdout and stderr, model identity, router logs, and worker telemetry outside the repository. Match the relay's native session value to Dynamo's normalized `agent_context.session_id`; for ThunderAgent, also prove the final request was handled without model forwarding and that no program remains live.

## Security and ownership boundary

The relay reads only `DYNAMO_API_KEY` by default, projects the selected value to DSH as `DEEPSEEK_API_KEY`, and never writes it to the local trace. The DSH process receives an isolated home plus an allowlist containing executable search path, locale, terminal, temporary-directory, timezone, and certificate settings; unrelated parent credentials and package-manager cache locations are not inherited. The relay records model request bodies in plaintext, hashes the stable anonymous DSH user ID, and creates the trace with owner-only permissions and exclusive creation by default. Treat the resulting file as sensitive because prompts, tool results, paths, and source excerpts can still be present. DSH owns its profiles, persistence, tools, sandbox, credentials, subagent behavior, and future native lifecycle hooks. Dynamo owns protocol normalization, affinity and routing, request tracing, and ThunderAgent program lifecycle. The relay is an integration shim, not a second DSH runtime or a public Web gateway.

## Known limitations

- This path carries root-session and compaction metadata only; immediate parent lineage is intentionally out of scope.
- The ACP session persists only while its one stdio connection remains live; `session/load`, resume after disconnect, and per-session close are not supported by DSH ACP `0.1.0-rc.8`.
- DSH ACP emits committed assistant messages rather than token deltas and intentionally keeps reasoning, tool progress, plans, titles, and usage off the ACP wire. Those details remain in DSH persistence and Dynamo traces.
- The published DSH ACP app requires a deployment-owned composition and does not cleanly dispose on ordinary stdin EOF by itself. The recipe generates that composition and uses the published app-boot API to add bounded EOF disposal.
- The terminal hook observes sessions at the relay. A DSH child that never reaches the model endpoint cannot be discovered or finalized by the shim.
- Input triggers are derived by Dynamo from the Chat Completions body, not emitted as a DSH-specific header. Validate `user_message` and `tool_result` in Dynamo request traces.
- The relay is loopback-only and intentionally minimal; it is not a multi-tenant authentication, rate-limit, or policy boundary.
- The legacy compatibility bridge preserves identity and affinity but cannot backport native DSH compaction normalization.
- Windows is not supported because the relay requires POSIX process-tree signaling.
