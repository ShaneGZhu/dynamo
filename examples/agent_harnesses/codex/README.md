<!--
SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Codex through Dynamo

This runbook drives one persistent Codex session through an existing Dynamo endpoint by using the pinned Codex ACP adapter. It defaults to read-only verification and stock Dynamo semantics. ThunderAgent lifecycle finalization is a separate opt-in operation. It does not deploy Dynamo or prescribe a Kubernetes topology.

## Dependencies

| Component | Pin |
| --- | --- |
| ACP Python client | `agent-client-protocol==0.12.0` |
| Codex ACP adapter | `@agentclientprotocol/codex-acp@1.1.14` |
| Required runtime | Python 3.11+, Node.js 22+, and `uv` |

The driver owns the ACP client and adapter pins in [drive_harness.py](https://github.com/ai-dynamo/dynamo/blob/main/.agents/skills/dynamo-agent-harness/scripts/drive_harness.py). Update a pin only after repeating the deterministic tests and a two-turn live smoke test.

## Before you begin

Complete the shared [agent-harness prerequisites](../README.md), including deployment of a supported Dynamo recipe. This runbook assumes `DYNAMO_BASE_URL` and `DYNAMO_MODEL` identify that recipe's reachable frontend and exact served model.

- Use a clean, narrowly scoped worktree for `--cwd`.
- Export `DYNAMO_API_KEY` only when the endpoint requires authentication. The driver uses `dummy` when it is unset.
- Keep `--capability verify` unless edits or tool execution were explicitly authorized.

```bash
export CODEX_WORKTREE=/absolute/worktree
```

## Stock Dynamo path

This is the default command for a standard frontend or KV router. It does not send a terminal lifecycle envelope.

```bash
.agents/skills/dynamo-agent-harness/scripts/drive_harness.py \
  --harness codex \
  --base-url "$DYNAMO_BASE_URL" \
  --model "$DYNAMO_MODEL" \
  --cwd "$CODEX_WORKTREE" \
  --capability verify
```

Run the command in a TTY. After its `ready` record, send one JSON object per line:

```json
{"prompt":"Inspect one named file and verify its highest-risk invariant. Do not edit files."}
{"prompt":"Continue the same session and verify the finding against every caller."}
{"close":true}
```

Every response must use the `ready.session_id` value. For Codex, this is the actual Codex thread ID that Dynamo receives in the `thread-id` header.

## ThunderAgent-only path

> [!WARNING]
> Use `--session-final` only when the endpoint is explicitly running ThunderAgent. Do not use it against a stock frontend or KV router; an endpoint that does not recognize the lifecycle header can treat the terminal envelope as ordinary model work.

```bash
.agents/skills/dynamo-agent-harness/scripts/drive_harness.py \
  --harness codex \
  --base-url "$DYNAMO_BASE_URL" \
  --model "$DYNAMO_MODEL" \
  --cwd "$CODEX_WORKTREE" \
  --capability verify \
  --session-final
```

After the ACP process closes, the driver sends exactly one terminal request for the created Codex thread. It does this after normal close, a failed turn, or interruption. It does not attempt finalization before a nonempty session ID exists. A failed terminal request emits `{"type":"session_final","ok":false,...}` and fails an otherwise successful run; if the session already failed, that original failure stays primary and records the finalization failure as an exception note.

## Environment boundary

The child receives an explicit allowlist: `PATH`, `HOME`, temporary-directory variables, `XDG_RUNTIME_DIR`, locale variables, the selected Dynamo API-key variable, and fresh harness-owned configuration. The driver does not inherit ambient cloud, source-control, Kubernetes, registry, proxy, or pre-existing Codex configuration variables. If the runtime requires another variable, add it deliberately and cover it with a non-leakage test rather than restoring full environment inheritance.

## Verify

Run the focused suite from the repository root:

```bash
uv run --no-project --with agent-client-protocol==0.12.0 \
  python -m unittest discover -v \
  -s .agents/skills/dynamo-agent-harness/scripts \
  -p 'test_drive_harness.py'

python3 -m py_compile \
  .agents/skills/dynamo-agent-harness/scripts/drive_harness.py \
  .agents/skills/dynamo-agent-harness/scripts/test_drive_harness.py

git diff --check
```

For a live verification, retain the local JSONL output and a redacted request trace outside the repository. Confirm two prompts retain one session ID, Responses API requests carry the expected model and bearer credential, tool permissions match the requested capability, and no child process remains after close. For ThunderAgent, also require exactly one successful `session_final` record and verify the program is gone using that deployment's lifecycle observability.

When request tracing is enabled, inspect the normalized session and trigger sequence:

```bash
jq -r '[.agent_context.session_id, .agent_context.input_trigger] | @tsv' request-trace.jsonl
```

## Cleanup

- Send `{"close":true}` for a normal exit. The driver closes ACP before returning.
- Press Ctrl-C once when a turn must be interrupted. If ThunderAgent finalization is enabled and a thread exists, cleanup still runs before the driver returns exit code 130.
- Remove only local output files and temporary worktrees created for the run. This client path creates no Kubernetes resources.

## Known limitations

- `--session-final` is qualified only for Codex through ThunderAgent; it is intentionally absent from the stock path.
- The terminal lifecycle request uses ThunderAgent's Chat Completions control surface even though Codex model traffic uses the Responses API.
- An active pinned ThunderAgent program does not transparently recover from every worker-loss scenario. Finalize the stale program and start a new session when continuation fails after backend recovery.
- Preserving `HOME` is required by the harness runtime. The environment is minimized, but operators must still use a scoped worktree and the read-only capability when they do not authorize edits.
