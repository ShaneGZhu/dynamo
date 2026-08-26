<!--
SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Agent harnesses through Dynamo

Dynamo can serve the model requests made by coding-agent harnesses that use its OpenAI- or Anthropic-compatible APIs. Start with a supported Kubernetes recipe, then configure the harness with the frontend URL and exact served model. Harness guides should not embed a cluster-specific deployment, storage class, namespace, or GPU allocation policy.

## Deploy a recipe first

Install the [Dynamo Kubernetes Platform](../../docs/fern/pages/kubernetes/getting-started/quickstart.mdx), choose a supported model and topology from the [recipe catalog](../../recipes/README.md), and follow that recipe until its `DynamoGraphDeployment` is ready and its frontend is reachable.

Record the two inputs shared by every harness:

```bash
export DYNAMO_BASE_URL=http://127.0.0.1:8000
export DYNAMO_MODEL=your-recipe-served-model
curl -fsS "$DYNAMO_BASE_URL/v1/models" | jq -e --arg model "$DYNAMO_MODEL" '.data[]? | select(.id == $model)'
```

When the endpoint requires authentication, export `DYNAMO_API_KEY` and add `-H "Authorization: Bearer $DYNAMO_API_KEY"` to the readiness request. Keep the recipe deployment running while the harness is active.

## Choose a harness

Follow the public [Agent Harnesses guide](https://github.com/ai-dynamo/dynamo/blob/main/docs/fern/pages/use-cases/agents/agent-harnesses.mdx) for wire-protocol and configuration details. Use a harness-specific runbook when it provides a persistent driver, dependency pins, permission controls, or lifecycle cleanup that the interactive CLI does not expose directly.

## Validate the path

- Run from a clean, narrowly scoped worktree and start with read-only or verification permissions.
- Send at least two prompts when the path claims persistence and confirm that the harness retains one session identity.
- Verify tool permissions and material claims independently; model output is not proof that a tool ran or a file stayed unchanged.
- Preserve redacted request traces only when needed for diagnosis. Do not commit prompts, credentials, cluster snapshots, or dated qualification output to an upstream guide.
- Treat ThunderAgent terminal signaling as an explicit opt-in. Do not send lifecycle controls to a stock frontend or KV router.
- Close the harness normally and verify that it leaves no child process or invocation-owned temporary state.

Deployment benchmarking, routing comparisons, GPU telemetry, and failure injection are separate qualification activities. Keep their manifests and evidence outside the upstream harness guide unless they become a maintained, cluster-agnostic public example.
