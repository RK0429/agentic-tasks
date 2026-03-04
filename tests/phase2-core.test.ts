import { afterEach, describe, expect, it } from 'vitest';

import { TasksError } from '../src/core/errors.js';
import { createTestContext, type TestContext } from './test-utils.js';

describe('Phase 2 core features', () => {
  let context: TestContext | undefined;

  afterEach(() => {
    context?.cleanup();
    context = undefined;
  });

  it('enforces WIP limit on claim_and_start / assign_task / update_task(in_progress)', () => {
    context = createTestContext();

    context.db.prepare('UPDATE projects SET wip_limit = 1 WHERE id = ?').run('PROJ-001');

    const goal = context.runtime.create_goal({
      title: 'Goal',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });

    const t1 = context.runtime.create_task(
      {
        title: 'Task 1',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'owner',
    );
    const t2 = context.runtime.create_task(
      {
        title: 'Task 2',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'owner',
    );

    context.runtime.update_task(t1.id, { status: 'to_do' }, 'owner');
    context.runtime.update_task(t2.id, { status: 'to_do' }, 'owner');

    context.runtime.claim_and_start({ task_id: t1.id, agent_id: 'coder-1' });

    expect(() => {
      context?.runtime.claim_and_start({ task_id: t2.id, agent_id: 'coder-2' });
    }).toThrowError(TasksError);

    expect(() => {
      context?.runtime.assign_task({
        task_id: t2.id,
        assignee: 'coder-2',
        agent_id: 'owner',
      });
    }).toThrowError(TasksError);

    const t3 = context.runtime.create_task(
      {
        title: 'Task 3',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'owner',
    );

    context.runtime.update_task(t3.id, { status: 'to_do' }, 'owner');

    expect(() => {
      context?.runtime.update_task(t3.id, { status: 'in_progress' }, 'owner');
    }).toThrowError(TasksError);

    const latestEvent = context.db
      .prepare(
        `
        SELECT event_type
        FROM task_events
        WHERE task_id = ?
        ORDER BY id DESC
        LIMIT 1
        `,
      )
      .get(t3.id) as { event_type: string } | undefined;

    expect(latestEvent?.event_type).toBe('wip_limit_exceeded');
  });

  it('computes goal progress rollup with weighted completion and effort_to_ms', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Rollup Goal',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });

    const doneTask = context.runtime.create_task(
      {
        title: 'done',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
        expected_effort: 'XS',
      },
      'owner',
    );
    const reviewTask = context.runtime.create_task(
      {
        title: 'review',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
        expected_effort: 'S',
      },
      'owner',
    );
    const inProgressTask = context.runtime.create_task(
      {
        title: 'in-progress',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
        expected_effort: 'M',
      },
      'owner',
    );

    context.runtime.update_task(doneTask.id, { status: 'to_do' }, 'owner');
    context.runtime.update_task(doneTask.id, { status: 'in_progress' }, 'owner');
    context.runtime.update_task(doneTask.id, { status: 'review' }, 'owner');
    context.runtime.update_task(doneTask.id, { status: 'done' }, 'owner');

    context.runtime.update_task(reviewTask.id, { status: 'to_do' }, 'owner');
    context.runtime.update_task(reviewTask.id, { status: 'in_progress' }, 'owner');
    context.runtime.update_task(reviewTask.id, { status: 'review' }, 'owner');

    context.runtime.update_task(inProgressTask.id, { status: 'to_do' }, 'owner');
    context.runtime.update_task(inProgressTask.id, { status: 'in_progress' }, 'owner');

    const progress = context.taskManager.getGoalProgressPercent(goal.goal_id);

    expect(progress).toBeCloseTo(68.57, 2);
  });

  it('aggregates gate_status from all linked quality gate evaluations', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Gate Goal',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });

    const task = context.runtime.create_task(
      {
        title: 'Gate Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'owner',
    );

    context.runtime.assign_task({ task_id: task.id, assignee: 'owner', agent_id: 'owner' });

    const gate1 = context.runtime.create_quality_gate(
      {
        task_id: task.id,
        gate_type: 'test',
        enforcement_level: 'required',
        exit_criteria: [
          {
            id: 'EC-1',
            description: 'unit tests',
            type: 'automated',
            evaluator: 'tester',
          },
        ],
        checker_agent: 'tester',
      },
      'owner',
    );

    const gate2 = context.runtime.create_quality_gate(
      {
        task_id: task.id,
        gate_type: 'code_review',
        enforcement_level: 'recommended',
        exit_criteria: [
          {
            id: 'EC-2',
            description: 'reviewed',
            type: 'manual',
            evaluator: 'reviewer',
          },
        ],
        checker_agent: 'reviewer',
      },
      'owner',
    );

    expect(context.taskManager.getTask(task.id)?.gate_status).toBe('pending');

    context.runtime.evaluate_quality_gate({
      gate_id: gate1.gate_id,
      result: 'pass',
      evaluator_agent: 'owner',
      evaluator_backend: 'codex',
    });

    expect(context.taskManager.getTask(task.id)?.gate_status).toBe('pending');

    context.runtime.evaluate_quality_gate({
      gate_id: gate2.gate_id,
      result: 'fail',
      evaluator_agent: 'owner',
      evaluator_backend: 'codex',
    });

    expect(context.taskManager.getTask(task.id)?.gate_status).toBe('failed');

    context.runtime.evaluate_quality_gate({
      gate_id: gate2.gate_id,
      result: 'pass',
      evaluator_agent: 'owner',
      evaluator_backend: 'codex',
    });

    expect(context.taskManager.getTask(task.id)?.gate_status).toBe('passed');
  });

  it('cleans stale locks by relay session and returns tasks to to_do', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Cleanup Goal',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });

    const task = context.runtime.create_task(
      {
        title: 'Lock Target',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'owner',
    );

    context.runtime.update_task(task.id, { status: 'to_do' }, 'owner');
    context.runtime.claim_and_start({
      task_id: task.id,
      agent_id: 'worker',
      relay_session_id: 'session-stale',
    });

    const result = context.runtime.stale_lock_cleanup({
      stale_session_ids: ['session-stale'],
      reason: 'heartbeat_timeout',
      agent_id: 'watchdog',
    });

    expect(result.released).toContain(task.id);
    expect(result.errors).toHaveLength(0);

    const updated = context.taskManager.getTask(task.id);
    expect(updated?.status).toBe('to_do');
    expect(updated?.assignee).toBeNull();
    expect(context.lockManager.get_lock(task.id)).toBeNull();
  });

  it('enforces escalation transition authority rules', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Escalation Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    context.runtime.assign_task({
      task_id: goal.goal_id,
      assignee: 'lead',
      agent_id: 'lead',
    });

    const task = context.runtime.create_task(
      {
        title: 'Escalated Task',
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
      relay_session_id: 'relay-1',
    });

    expect(() => {
      context?.runtime.escalate_task({
        task_id: task.id,
        agent_id: 'other-worker',
        reason: 'need help',
        category: 'technical_blocker',
      });
    }).toThrowError(TasksError);

    context.runtime.escalate_task({
      task_id: task.id,
      agent_id: 'worker',
      reason: 'need help',
      category: 'technical_blocker',
    });

    expect(() => {
      context?.runtime.update_task(task.id, { status: 'in_progress' }, 'worker');
    }).toThrowError(TasksError);

    const reopened = context.runtime.update_task(task.id, { status: 'in_progress' }, 'lead');
    expect(reopened.status).toBe('in_progress');

    context.runtime.update_task(task.id, { status: 'escalated' }, 'worker');
    const blocked = context.runtime.update_task(task.id, { status: 'blocked' }, 'lead');
    expect(blocked.status).toBe('blocked');
  });
});
