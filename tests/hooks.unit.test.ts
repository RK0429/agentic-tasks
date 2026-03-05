import { describe, expect, it, vi } from 'vitest';

import {
  handleContextThreshold,
  handlePreSpawn,
  handleSessionComplete,
  handleSessionError,
  handleSessionStale,
} from '../src/hooks/handlers.js';
import type { HookDependencies, RelayHookInput } from '../src/hooks/types.js';
import type { Task } from '../src/types/index.js';

function createTask(id: string, status: Task['status'] = 'to_do'): Task {
  return {
    id,
    title: `Title ${id}`,
    description: 'description',
    status,
    priority: 'medium',
    task_type: id.startsWith('GOAL-') ? 'goal' : 'task',
    parent_task_id: id.startsWith('GOAL-') ? null : 'GOAL-001',
    goal_id: id.startsWith('GOAL-') ? null : 'GOAL-001',
    depth: id.startsWith('GOAL-') ? 0 : 1,
    phase: null,
    source_ref: null,
    expected_effort: null,
    actual_effort_ms: null,
    wbs_version: 1,
    gate_status: 'none',
    project_id: 'PROJ-001',
    sprint_id: null,
    assignee: null,
    acceptance_criteria: [],
    metadata: null,
    version: 1,
    created_by: 'owner',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function createDeps(): HookDependencies {
  const task = createTask('TASK-001');

  return {
    tasks: {
      get_task: vi.fn(() => task),
      claim_and_start: vi.fn(() => ({
        task_id: task.id,
        new_status: 'in_progress' as const,
        lock: {
          locked_at: '2026-03-05T00:00:00.000Z',
          expires_at: '2026-03-05T01:00:00.000Z',
        },
        task,
      })),
      complete_task: vi.fn(() => ({
        status: 'completed' as const,
        task_id: task.id,
        new_status: 'review' as const,
        lock_released: true,
        parent_progress_updated: true,
        parent_auto_review: false,
      })),
      stale_lock_cleanup: vi.fn(() => ({
        cleaned_up: true,
        released_tasks: [
          {
            task_id: task.id,
            previous_status: 'in_progress' as const,
            new_status: 'to_do' as const,
          },
        ],
        events_emitted: 3,
        normalized_reason: 'manual_cleanup' as const,
        released: [task.id],
        errors: [],
      })),
    },
    memory: {
      memory_search: vi.fn(async () => ({
        summary: '- note: previous implementation context',
        raw: { results: [] },
      })),
      memory_note_new: vi.fn(async () => ({
        note_path: 'memory/2026-03-05/TASK-001.md',
        raw: { ok: true },
      })),
    },
    log: vi.fn(),
  };
}

function inputFor(event: string): RelayHookInput {
  return {
    event,
    sessionId: 'relay-test-session',
    data: {
      taskId: 'TASK-001',
      agentType: 'coder',
      durationMs: 120_000,
      level: 'critical',
      systemPrompt: 'base prompt',
    },
  };
}

describe('relay hook handlers', () => {
  it('pre-spawn: claim_and_start + memory_search + prompt injection', async () => {
    const deps = createDeps();
    const result = await handlePreSpawn(inputFor('pre-spawn'), deps);

    expect(result.success).toBe(true);
    expect(result.actions.claim_and_start).toBeTruthy();
    expect(result.system_prompt).toContain('base prompt');
    expect(result.system_prompt).toContain('TASK-001');
    expect(result.system_prompt).toContain('memory_context');

    expect((deps.tasks.claim_and_start as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((deps.memory.memory_search as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('on-session-complete: complete_task + memory_note_new', async () => {
    const deps = createDeps();
    const result = await handleSessionComplete(inputFor('on-session-complete'), deps);

    expect(result.success).toBe(true);
    expect(result.actions.complete_task).toBeTruthy();
    expect(result.actions.memory_note_new).toBeTruthy();
    expect((deps.tasks.complete_task as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((deps.memory.memory_note_new as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('on-session-error: stale_lock_cleanup + best-effort memory recovery', async () => {
    const deps = createDeps();
    const result = await handleSessionError(inputFor('on-session-error'), deps);

    expect(result.success).toBe(true);
    expect(result.actions.stale_lock_cleanup).toBeTruthy();
    expect((deps.tasks.stale_lock_cleanup as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((deps.memory.memory_note_new as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('on-session-stale: stale_lock_cleanup heartbeat_timeout', async () => {
    const deps = createDeps();
    const result = await handleSessionStale(inputFor('on-session-stale'), deps);

    expect(result.success).toBe(true);
    expect(result.actions.stale_lock_cleanup).toBeTruthy();

    const callArgs = (deps.tasks.stale_lock_cleanup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      reason: string;
    };

    expect(callArgs.reason).toBe('heartbeat_timeout');
  });

  it('on-context-threshold: warning is log-only, critical persists note', async () => {
    const deps = createDeps();
    const warningInput = {
      ...inputFor('on-context-threshold'),
      data: {
        ...inputFor('on-context-threshold').data,
        level: 'warning',
      },
    };

    const warningResult = await handleContextThreshold(warningInput, deps);
    expect(warningResult.actions.notice).toBeTruthy();
    expect((deps.memory.memory_note_new as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

    const criticalResult = await handleContextThreshold(inputFor('on-context-threshold'), deps);
    expect(criticalResult.actions.memory_note_new).toBeTruthy();
    expect((deps.memory.memory_note_new as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
