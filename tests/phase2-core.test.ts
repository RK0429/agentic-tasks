import { afterEach, describe, expect, it } from 'vitest';

import { TasksError } from '../src/core/errors.js';
import { createTestContext, type TestContext } from './test-utils.js';

describe('Phase 2 core features', () => {
  let context: TestContext | undefined;

  afterEach(() => {
    context?.cleanup();
    context = undefined;
  });

  it('enforces WIP limit on claim_and_start / assign_task', () => {
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

    expect(() => {
      context?.runtime.claim_and_start({ task_id: t3.id, agent_id: 'owner' });
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

  it('allows next_task without project_id and picks from all projects', () => {
    context = createTestContext();

    const project2 = context.runtime.create_project({
      name: 'Project 2',
      description: 'Secondary',
      wip_limit: 5,
    }).project;

    const goal1 = context.runtime.create_goal({
      title: 'Goal 1',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });
    const goal2 = context.runtime.create_goal({
      title: 'Goal 2',
      project_id: project2.id,
      agent_id: 'owner',
    });

    const low = context.runtime.create_task(
      {
        title: 'Low Priority',
        task_type: 'task',
        parent_task_id: goal1.goal_id,
        project_id: 'PROJ-001',
        priority: 'low',
      },
      'owner',
    );
    const high = context.runtime.create_task(
      {
        title: 'High Priority',
        task_type: 'task',
        parent_task_id: goal2.goal_id,
        project_id: project2.id,
        priority: 'high',
      },
      'owner',
    );

    const next = context.runtime.next_task({});
    expect(next?.id).toBe(high.id);
    expect(next?.id).not.toBe(low.id);
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

    context.runtime.claim_and_start({ task_id: doneTask.id, agent_id: 'worker-done' });
    context.runtime.complete_task({ task_id: doneTask.id, agent_id: 'worker-done' });
    context.runtime.approve_task({ task_id: doneTask.id, agent_id: 'owner' });

    context.runtime.claim_and_start({ task_id: reviewTask.id, agent_id: 'worker-review' });
    context.runtime.complete_task({ task_id: reviewTask.id, agent_id: 'worker-review' });

    context.runtime.claim_and_start({ task_id: inProgressTask.id, agent_id: 'worker-progress' });

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
      context?.runtime.reopen_task({ task_id: task.id, agent_id: 'worker' });
    }).toThrowError(TasksError);

    const reopened = context.runtime.reopen_task({ task_id: task.id, agent_id: 'lead' });
    expect(reopened.new_status).toBe('to_do');

    context.runtime.claim_and_start({
      task_id: task.id,
      agent_id: 'worker',
      relay_session_id: 'relay-2',
    });
    const blocked = context.runtime.block_task({
      task_id: task.id,
      agent_id: 'worker',
      reason: 'need parent decision',
    });
    expect(blocked.new_status).toBe('blocked');
  });

  it('sets goal assignee automatically from create_goal agent_id', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Auto Assignee Goal',
      project_id: 'PROJ-001',
      agent_id: 'goal-owner',
    });

    const stored = context.taskManager.getTask(goal.goal_id);
    expect(stored?.assignee).toBe('goal-owner');
  });

  it('rejects self-approval on approve_task', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Approval Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    const task = context.runtime.create_task(
      {
        title: 'Needs Review',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );

    context.runtime.claim_and_start({ task_id: task.id, agent_id: 'worker' });
    context.runtime.complete_task({ task_id: task.id, agent_id: 'worker' });

    expect(() => {
      context?.runtime.approve_task({ task_id: task.id, agent_id: 'worker' });
    }).toThrowError(TasksError);

    const approved = context.runtime.approve_task({ task_id: task.id, agent_id: 'lead' });
    expect(approved.status).toBe('approved');
  });

  it('supports block_task / reopen_task / archive_task transitions', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Transition Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    const task = context.runtime.create_task(
      {
        title: 'Transition Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );

    context.runtime.claim_and_start({ task_id: task.id, agent_id: 'worker' });
    const blocked = context.runtime.block_task({
      task_id: task.id,
      agent_id: 'worker',
      reason: 'waiting for input',
    });
    expect(blocked.new_status).toBe('blocked');
    expect(context.lockManager.get_lock(task.id)).toBeNull();

    const reopened = context.runtime.reopen_task({
      task_id: task.id,
      agent_id: 'lead',
      reason: 'clarified',
    });
    expect(reopened.new_status).toBe('to_do');

    const archived = context.runtime.archive_task({
      task_id: task.id,
      agent_id: 'lead',
    });
    expect(archived.new_status).toBe('archived');
  });

  it('auto-cleans goal tasks when all tasks are done/archived', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Cleanup Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });
    context.runtime.create_goal({
      title: 'Open Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    const task1 = context.runtime.create_task(
      {
        title: 'Cleanup Task 1',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );
    const task2 = context.runtime.create_task(
      {
        title: 'Cleanup Task 2',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );

    context.runtime.claim_and_start({ task_id: task1.id, agent_id: 'worker-1' });
    context.runtime.complete_task({ task_id: task1.id, agent_id: 'worker-1' });
    context.runtime.approve_task({ task_id: task1.id, agent_id: 'lead' });

    context.runtime.claim_and_start({ task_id: task2.id, agent_id: 'worker-2' });
    context.runtime.complete_task({ task_id: task2.id, agent_id: 'worker-2' });
    const approved = context.runtime.approve_task({ task_id: task2.id, agent_id: 'lead' });

    expect(approved.cleanup?.goal_cleaned?.goal_id).toBe(goal.goal_id);
    expect(approved.cleanup?.goal_cleaned?.tasks_deleted).toEqual(
      expect.arrayContaining([task1.id, task2.id]),
    );

    const remaining = context.taskManager.listTasks({ goal_id: goal.goal_id, task_type: 'task' });
    expect(remaining).toHaveLength(0);
    expect(context.taskManager.getTask(goal.goal_id)?.status).toBe('done');
  });

  it('auto-cleans project when all goals are completed', () => {
    context = createTestContext();

    const project = context.runtime.create_project({
      name: 'Auto Cleanup Project',
    }).project;

    const goal = context.runtime.create_goal({
      title: 'Only Goal',
      project_id: project.id,
      agent_id: 'lead',
    });
    const task = context.runtime.create_task(
      {
        title: 'Only Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: project.id,
      },
      'lead',
    );

    context.runtime.claim_and_start({ task_id: task.id, agent_id: 'worker' });
    context.runtime.complete_task({ task_id: task.id, agent_id: 'worker' });
    const approved = context.runtime.approve_task({ task_id: task.id, agent_id: 'lead' });

    expect(approved.cleanup?.project_cleaned?.project_id).toBe(project.id);
    expect(context.taskManager.getTask(goal.goal_id)).toBeNull();
    expect(() => {
      context?.runtime.get_project(project.id);
    }).toThrowError(TasksError);
  });
});
