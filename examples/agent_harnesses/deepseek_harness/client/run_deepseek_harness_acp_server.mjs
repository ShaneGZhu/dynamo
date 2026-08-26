#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Boot the published DSH ACP app and always dispose it when its stdio client closes. */

import { parseArgs } from 'node:util'

import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dynamo-dsh-acp-server'
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { short: 'c', type: 'string' } },
  strict: true,
})
if (values.config === undefined) throw new Error('--config is required')

let context
const uninstallFailLoud = installFailLoud(NAME, process, async () => context?.fiber.dispose())
try {
  context = await boot(NAME, resolveConfigPath(values.config, undefined))
} catch (error) {
  uninstallFailLoud()
  throw error
}

let closing = false
process.stdin.once('end', () => {
  if (closing) return
  closing = true
  void context.fiber.dispose().then(
    () => {
      uninstallFailLoud()
      process.exitCode = 0
    },
    error => {
      process.stderr.write(`${NAME}: shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
})
