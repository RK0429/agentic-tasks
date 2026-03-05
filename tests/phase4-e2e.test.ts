import { afterEach, describe, expect, it, vi } from 'vitest';

import { handlePreSpawn, handleSessionComplete, handleSessionStale } from '../src/hooks/handlers.js';
import { TasksError } from '../src/core/errors.js';
import type { HookDependencies } from '../src/hooks/types.js';
import { createTestContext, type TestContext } from './test-utils.js';

function createHookDeps(context: TestContext): HookDependencies {
  return {
    tasks: {
      get_task(task_id) {
        return context.runtime.get_task(task_id, true).task;
      },
      claim_and_start(input) {
        return context.runtime.claim_and_start(input);
      },
      complete_task(input) {
        return context.runtime.complete_task(input);
      },
      stale_lock_cleanup(input) {
        return context.runtime.stale_lock_cleanup(input);
      },
    },
    memory: {
      memory_search: vi.fn(async () => ({
        summary: '- context: recovered from memory',
        raw: { results: [] },
      })),
      memory_note_new: vi.fn(async () => ({
        note_path: 'memory/2026-03-05/TASK.md',
        raw: { saved: true },
      })),
    },
    log: vi.fn(),
  };
}

describe('Phase 4 E2E patterns 1-5', () => {
  let context: TestContext | undefined;

  afterEach(() => {
    context?.cleanup();
    context = undefined;
  });

  it('Pattern 1: normal flow (pre-spawn -> claim -> complete)', async () => {
    context = createTestContext();
    const deps = createHookDeps(context);

    const goal = context.runtime.create_goal({
      title: 'Pattern1 Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    const task = context.runtime.create_task(
      {
        title: 'Pattern1 Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );

    const pre = await handlePreSpawn(
      {
        event: 'pre-spawn',
        sessionId: 'relay-pattern1',
        data: {
          taskId: task.id,
          agentType: 'worker-a',
          systemPrompt: 'base prompt',
        },
      },
      deps,
    );

    expect(pre.success).toBe(true);
    expect(pre.system_prompt).toContain(task.id);

    const claimed = context.taskManager.getTask(task.id);
    expect(claimed?.status).toBe('in_progress');
    expect(context.lockManager.get_lock(task.id)?.agent_id).toBe('worker-a');

    const completed = await handleSessionComplete(
      {
        event: 'on-session-complete',
        sessionId: 'relay-pattern1',
        data: {
          taskId: task.id,
          agentType: 'worker-a',
          durationMs: 90_000,
        },
      },
      deps,
    );

    expect(completed.success).toBe(true);
    const final = context.taskManager.getTask(task.id);
    expect(final?.status === 'review' || final?.status === 'done').toBe(true);
    expect(context.lockManager.get_lock(task.id)).toBeNull();
  });

  it('Pattern 1b: fractal delegation with quality gate and goal auto-review', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Pattern1b Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    context.runtime.assign_task({
      task_id: goal.goal_id,
      assignee: 'lead',
      agent_id: 'lead',
    });

    const parent = context.runtime.create_task(
      {
        title: 'Parent Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );

    context.runtime.update_task(parent.id, { status: 'to_do' }, 'lead');
    context.runtime.claim_and_start({
      task_id: parent.id,
      agent_id: 'specialist',
      relay_session_id: 'relay-parent',
    });

    const decomposed = context.runtime.decompose_task({
      task_id: parent.id,
      agent_id: 'specialist',
      children: [{ title: 'Child A' }, { title: 'Child B' }],
      dependencies: [{ from_index: 0, to_index: 1, type: 'finish_to_start' }],
    });

    const childA = decomposed.children[0]?.task_id;
    const childB = decomposed.children[1]?.task_id;
    if (!childA || !childB) {
      throw new Error('child task ids not found');
    }

    context.runtime.claim_and_start({ task_id: childA, agent_id: 'worker-a', relay_session_id: 'relay-a' });
    const completedA = context.runtime.complete_task({ task_id: childA, agent_id: 'worker-a', skip_review: true });
    expect(completedA.status).toBe('completed');

    context.runtime.claim_and_start({ task_id: childB, agent_id: 'worker-b', relay_session_id: 'relay-b' });
    const completedB = context.runtime.complete_task({ task_id: childB, agent_id: 'worker-b', skip_review: true });
    expect(completedB.status).toBe('completed');

    const gate = context.runtime.create_quality_gate(
      {
        task_id: parent.id,
        gate_type: 'code_review',
        enforcement_level: 'required',
        exit_criteria: [
          {
            id: 'EC-001',
            description: 'review pass',
            type: 'manual',
            evaluator: 'checker',
          },
        ],
        checker_agent: 'checker',
      },
      'specialist',
    );

    const parentComplete = context.runtime.complete_task({
      task_id: parent.id,
      agent_id: 'specialist',
      actual_effort_ms: 120_000,
    });

    expect(parentComplete.status).toBe('completed');
    expect(parentComplete.new_status).toBe('review');

    context.runtime.evaluate_quality_gate({
      gate_id: gate.gate_id,
      result: 'pass',
      evaluator_agent: 'checker',
      evaluator_backend: 'codex',
    });

    const doneParent = context.runtime.update_task(parent.id, { status: 'done' }, 'specialist');
    expect(doneParent.status).toBe('done');

    const refreshedGoal = context.taskManager.getTask(goal.goal_id);
    expect(refreshedGoal?.status).toBe('review');
  });

  it('Pattern 2: crash recovery via stale_lock_cleanup and next_task reacquire', async () => {
    context = createTestContext();
    const deps = createHookDeps(context);

    const goal = context.runtime.create_goal({
      title: 'Pattern2 Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    const task = context.runtime.create_task(
      {
        title: 'Crash Target',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );

    context.runtime.update_task(task.id, { status: 'to_do' }, 'lead');
    context.runtime.claim_and_start({
      task_id: task.id,
      agent_id: 'worker',
      relay_session_id: 'relay-crash',
    });

    await handleSessionStale(
      {
        event: 'on-session-stale',
        sessionId: 'relay-crash',
        data: {
          taskId: task.id,
          agentType: 'watchdog',
        },
      },
      deps,
    );

    const recovered = context.taskManager.getTask(task.id);
    expect(recovered?.status).toBe('to_do');
    expect(context.lockManager.get_lock(task.id)).toBeNull();

    const next = context.runtime.next_task({ project_id: 'PROJ-001' });
    expect(next?.id).toBe(task.id);
  });

  it('Pattern 3: extend_lock and TTL expiration invalidation', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Pattern3 Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    const task = context.runtime.create_task(
      {
        title: 'Long Running Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );

    context.runtime.update_task(task.id, { status: 'to_do' }, 'lead');
    context.runtime.claim_and_start({
      task_id: task.id,
      agent_id: 'worker-a',
      relay_session_id: 'relay-long',
      lock_duration_ms: 60_000,
    });

    const extended = context.runtime.extend_lock({
      task_id: task.id,
      relay_session_id: 'relay-long',
      extend_ms: 120_000,
    });

    expect(extended.extended).toBe(true);
    expect(new Date(extended.new_expires_at).getTime()).toBeGreaterThan(Date.now());

    context.db
      .prepare("UPDATE task_locks SET expires_at = datetime('now', '-1 minute') WHERE task_id = ?")
      .run(task.id);

    const reClaim = context.runtime.claim_and_start({
      task_id: task.id,
      agent_id: 'worker-b',
      relay_session_id: 'relay-new',
      lock_duration_ms: 60_000,
    });

    expect(reClaim.new_status).toBe('in_progress');
    expect(context.lockManager.get_lock(task.id)?.agent_id).toBe('worker-b');
  });

  it('Pattern 4: dependency chain resolution TASK-A -> TASK-B -> TASK-C', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Pattern4 Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    const taskA = context.runtime.create_task(
      { title: 'TASK-A', task_type: 'task', parent_task_id: goal.goal_id, project_id: 'PROJ-001' },
      'lead',
    );
    const taskB = context.runtime.create_task(
      { title: 'TASK-B', task_type: 'task', parent_task_id: goal.goal_id, project_id: 'PROJ-001' },
      'lead',
    );
    const taskC = context.runtime.create_task(
      { title: 'TASK-C', task_type: 'task', parent_task_id: goal.goal_id, project_id: 'PROJ-001' },
      'lead',
    );

    context.runtime.update_task(taskA.id, { status: 'to_do' }, 'lead');
    context.runtime.update_task(taskB.id, { status: 'to_do' }, 'lead');
    context.runtime.update_task(taskC.id, { status: 'to_do' }, 'lead');

    context.dependencyResolver.add_dependency({ task_id: taskB.id, depends_on: taskA.id, triggered_by: 'lead' });
    context.dependencyResolver.add_dependency({ task_id: taskC.id, depends_on: taskB.id, triggered_by: 'lead' });

    expect(context.taskManager.getTask(taskB.id)?.status).toBe('blocked');

    context.runtime.claim_and_start({ task_id: taskA.id, agent_id: 'worker-a' });
    const completeA = context.runtime.complete_task({
      task_id: taskA.id,
      agent_id: 'worker-a',
      skip_review: true,
    });
    expect(completeA.status).toBe('completed');

    const nextAfterA = context.runtime.next_task({ project_id: 'PROJ-001' });
    expect(nextAfterA?.id).toBe(taskB.id);

    context.runtime.claim_and_start({ task_id: taskB.id, agent_id: 'worker-b' });
    context.runtime.complete_task({ task_id: taskB.id, agent_id: 'worker-b', skip_review: true });

    const nextAfterB = context.runtime.next_task({ project_id: 'PROJ-001' });
    expect(nextAfterB?.id).toBe(taskC.id);
  });

  it('Pattern 5: escalate -> resolve flow', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Pattern5 Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    context.runtime.assign_task({ task_id: goal.goal_id, assignee: 'lead', agent_id: 'lead' });

    const task = context.runtime.create_task(
      {
        title: 'Escalation Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );

    context.runtime.update_task(task.id, { status: 'to_do' }, 'lead');
    context.runtime.claim_and_start({
      task_id: task.id,
      agent_id: 'worker',
      relay_session_id: 'relay-escalate',
    });

    context.runtime.escalate_task({
      task_id: task.id,
      agent_id: 'worker',
      reason: 'blocked by external API',
      category: 'technical_blocker',
    });

    expect(context.taskManager.getTask(task.id)?.status).toBe('escalated');

    expect(() => {
      context?.runtime.update_task(task.id, { status: 'in_progress' }, 'other');
    }).toThrowError(TasksError);

    const resumed = context.runtime.update_task(task.id, { status: 'in_progress' }, 'lead');
    expect(resumed.status).toBe('in_progress');

    context.runtime.update_task(task.id, { status: 'escalated' }, 'worker');
    const blocked = context.runtime.update_task(task.id, { status: 'blocked' }, 'lead');
    expect(blocked.status).toBe('blocked');
    expect(context.lockManager.get_lock(task.id)).toBeNull();
  });
});
