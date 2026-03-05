import type { HookResult, RelayHookInput } from './types.js';

export async function readHookInputFromStdin(): Promise<RelayHookInput> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') {
    throw new Error('stdin is empty; HookInput JSON is required');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid HookInput JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('HookInput must be a JSON object');
  }

  const value = parsed as Record<string, unknown>;
  return {
    event: typeof value.event === 'string' ? value.event : 'unknown',
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    data: value.data && typeof value.data === 'object' ? (value.data as Record<string, unknown>) : {},
  };
}

export function writeHookOutput(result: HookResult): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function writeHookError(event: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const payload: HookResult = {
    success: false,
    event,
    session_id: null,
    warnings: [message],
    actions: {},
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
}
