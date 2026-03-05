import type { HookDependencies, HookResult, RelayHookInput } from './types.js';
import type { Task } from '../types/index.js';

function getData(input: RelayHookInput): Record<string, unknown> {
  return input.data ?? {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function taskIdFromInput(input: RelayHookInput): string | undefined {
  const data = getData(input);
  return asString(data.taskId) ?? asString(data.task_id) ?? asString(data.taskID);
}

function agentIdFromInput(input: RelayHookInput): string {
  const data = getData(input);
  return (
    asString(data.agentType) ??
    asString(data.agent_id) ??
    asString(data.agentId) ??
    'relay-hook'
  );
}

function sessionIdFromInput(input: RelayHookInput): string | undefined {
  return asString(input.sessionId);
}

function baseResult(input: RelayHookInput): HookResult {
  return {
    success: true,
    event: input.event,
    session_id: input.sessionId ?? null,
    warnings: [],
    actions: {},
  };
}

function buildPromptInjection(task: Task | null, memorySummary: string): string {
  const lines: string[] = ['[agentic-tasks context]'];

  if (task) {
    lines.push(`task_id: ${String(task.id ?? '')}`);
    lines.push(`title: ${String(task.title ?? '')}`);
    lines.push(`status: ${String(task.status ?? '')}`);
    lines.push(`priority: ${String(task.priority ?? '')}`);
    const parent = task.parent_task_id ? String(task.parent_task_id) : 'none';
    lines.push(`parent_task_id: ${parent}`);
  }

  if (memorySummary.trim() !== '') {
    lines.push('memory_context:');
    lines.push(memorySummary);
  } else {
    lines.push('memory_context: (not found)');
  }

  return lines.join('\n');
}

export async function handlePreSpawn(
  input: RelayHookInput,
  deps: HookDependencies,
): Promise<HookResult> {
  const result = baseResult(input);
  const task_id = taskIdFromInput(input);
  const agent_id = agentIdFromInput(input);
  const relay_session_id = sessionIdFromInput(input);

  if (!task_id) {
    result.warnings.push('taskId is missing; pre-spawn integration skipped');
    return result;
  }

  const claim = deps.tasks.claim_and_start({
    task_id,
    agent_id,
    relay_session_id,
  });

  const memory = await deps.memory.memory_search({
    query: `task: ${task_id}`,
    task_id,
    agent_id,
    relay_session_id,
  });

  const task = deps.tasks.get_task(task_id);
  const data = getData(input);
  const existingSystemPrompt = asString(data.systemPrompt) ?? '';
  const promptInjection = buildPromptInjection(task, memory.summary);
  const systemPrompt = existingSystemPrompt
    ? `${existingSystemPrompt}\n\n${promptInjection}`
    : promptInjection;

  result.actions = {
    claim_and_start: claim,
    memory_search: {
      query: `task: ${task_id}`,
      summary: memory.summary,
    },
  };

  result.task = task;
  result.prompt_injection = promptInjection;
  result.system_prompt = systemPrompt;

  return result;
}

export async function handleSessionComplete(
  input: RelayHookInput,
  deps: HookDependencies,
): Promise<HookResult> {
  const result = baseResult(input);
  const task_id = taskIdFromInput(input);
  const agent_id = agentIdFromInput(input);
  const relay_session_id = sessionIdFromInput(input);
  const durationMs = asNumber(getData(input).durationMs);

  if (!task_id) {
    result.warnings.push('taskId is missing; on-session-complete integration skipped');
    return result;
  }

  const completion = deps.tasks.complete_task({
    task_id,
    agent_id,
    actual_effort_ms: durationMs ? Math.max(0, Math.round(durationMs)) : undefined,
  });

  const memory = await deps.memory.memory_note_new({
    task_id,
    relay_session_id,
    agent_id,
    snapshot_type: 'session_complete',
    title: `relay:on-session-complete:${task_id}`,
  });

  result.actions = {
    complete_task: completion,
    memory_note_new: {
      note_path: memory.note_path,
    },
  };

  return result;
}

export async function handleSessionError(
  input: RelayHookInput,
  deps: HookDependencies,
): Promise<HookResult> {
  const result = baseResult(input);
  const task_id = taskIdFromInput(input);
  const agent_id = agentIdFromInput(input);
  const relay_session_id = sessionIdFromInput(input);

  if (!relay_session_id) {
    result.warnings.push('sessionId is missing; stale_lock_cleanup skipped');
  }

  if (relay_session_id) {
    result.actions.stale_lock_cleanup = deps.tasks.stale_lock_cleanup({
      stale_session_ids: [relay_session_id],
      reason: 'manual_cleanup',
      agent_id,
    });
  }

  try {
    const memory = await deps.memory.memory_note_new({
      task_id,
      relay_session_id,
      agent_id,
      snapshot_type: 'session_error',
      title: `relay:on-session-error:${task_id ?? 'unknown'}`,
    });
    result.actions.memory_note_new = {
      note_path: memory.note_path,
    };
  } catch (error) {
    result.warnings.push(
      `best-effort memory recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return result;
}

export async function handleSessionStale(
  input: RelayHookInput,
  deps: HookDependencies,
): Promise<HookResult> {
  const result = baseResult(input);
  const agent_id = agentIdFromInput(input);
  const relay_session_id = sessionIdFromInput(input);

  if (!relay_session_id) {
    result.warnings.push('sessionId is missing; stale_lock_cleanup skipped');
    return result;
  }

  result.actions.stale_lock_cleanup = deps.tasks.stale_lock_cleanup({
    stale_session_ids: [relay_session_id],
    reason: 'heartbeat_timeout',
    agent_id,
  });

  return result;
}

export async function handleContextThreshold(
  input: RelayHookInput,
  deps: HookDependencies,
): Promise<HookResult> {
  const result = baseResult(input);
  const data = getData(input);
  const level = asString(data.level) ?? 'warning';
  const task_id = taskIdFromInput(input);
  const agent_id = agentIdFromInput(input);
  const relay_session_id = sessionIdFromInput(input);

  result.level = level;

  if (level === 'warning') {
    deps.log('context-threshold warning', {
      task_id: task_id ?? null,
      session_id: relay_session_id ?? null,
    });
    result.actions.notice = {
      message: 'warning level detected; no persistence executed',
    };
    return result;
  }

  const memory = await deps.memory.memory_note_new({
    task_id,
    relay_session_id,
    agent_id,
    snapshot_type: level,
    title: `relay:on-context-threshold:${level}:${task_id ?? 'unknown'}`,
  });

  result.actions.memory_note_new = {
    note_path: memory.note_path,
    level,
  };

  return result;
}
