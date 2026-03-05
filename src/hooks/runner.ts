import { MemoryCliHookClient, NoopMemoryHookClient, createRuntimeTaskHookClient } from './clients.js';
import { readHookInputFromStdin, writeHookError, writeHookOutput } from './io.js';

import type { HookDependencies, HookResult, RelayHookInput } from './types.js';

function createLogger(scope: string): (message: string, payload?: Record<string, unknown>) => void {
  return (message: string, payload?: Record<string, unknown>) => {
    const prefix = `[agentic-tasks/hooks:${scope}]`;
    if (!payload) {
      process.stderr.write(`${prefix} ${message}\n`);
      return;
    }

    process.stderr.write(`${prefix} ${message} ${JSON.stringify(payload)}\n`);
  };
}

function resolveMemoryClient() {
  const mode = process.env.AGENTIC_TASKS_HOOK_MEMORY_MODE ?? 'cli';
  if (mode === 'off' || mode === 'noop') {
    return new NoopMemoryHookClient();
  }

  return new MemoryCliHookClient();
}

export async function runHookHandler(
  scope: string,
  handler: (input: RelayHookInput, deps: HookDependencies) => Promise<HookResult>,
): Promise<void> {
  const { client, close } = createRuntimeTaskHookClient();
  const memory = resolveMemoryClient();
  const log = createLogger(scope);

  try {
    const input = await readHookInputFromStdin();
    const result = await handler(input, {
      tasks: client,
      memory,
      log,
    });

    writeHookOutput(result);
  } catch (error) {
    writeHookError(scope, error);
  } finally {
    close();
  }
}
