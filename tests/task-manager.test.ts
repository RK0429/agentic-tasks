import { afterEach, describe, expect, it } from 'vitest';

import { TasksError } from '../src/core/errors.js';
import { createTestContext, type TestContext } from './test-utils.js';

function setUpdatedAt(context: TestContext, taskIds: string[], updatedAt: string): void {
  const placeholders = taskIds.map(() => '?').join(', ');
  context.db
    .prepare(`UPDATE tasks SET updated_at = ? WHERE id IN (${placeholders})`)
    .run(updatedAt, ...taskIds);
}

describe('TaskManager', () => {
  let context: TestContext | undefined;

  afterEach(() => {
    context?.cleanup();
    context = undefined;
  });

  it('creates hierarchical tasks with derived depth and goal_id', () => {
    context = createTestContext();

    const goal = context.taskManager.createTask({
      title: 'Goal',
      task_type: 'goal',
      project_id: 'PROJ-001',
    });

    const task = context.taskManager.createTask({
      title: 'Task',
      task_type: 'task',
      parent_task_id: goal.id,
      project_id: goal.project_id,
      acceptance_criteria: null,
    });

    const child = context.taskManager.createTask({
      title: 'Child',
      task_type: 'task',
      parent_task_id: task.id,
      goal_id: goal.id,
      project_id: task.project_id,
    });

    expect(goal.status).toBe('to_do');
    expect(goal.depth).toBe(0);

    expect(task.goal_id).toBe(goal.id);
    expect(task.depth).toBe(1);
    expect(task.acceptance_criteria).toEqual([]);

    expect(child.goal_id).toBe(goal.id);
    expect(child.depth).toBe(2);
  });

  it('creates task under goal when only goal_id is provided', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    const task = context.runtime.create_task(
      {
        title: 'Task',
        task_type: 'task',
        goal_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );

    expect(task.parent_task_id).toBe(goal.goal_id);
    expect(task.goal_id).toBe(goal.goal_id);
    expect(task.depth).toBe(1);
  });

  it('keeps existing behavior when both goal_id and parent_task_id are provided', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    const task = context.runtime.create_task(
      {
        title: 'Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        goal_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );

    expect(task.parent_task_id).toBe(goal.goal_id);
    expect(task.goal_id).toBe(goal.goal_id);
    expect(task.depth).toBe(1);
  });

  it('keeps throwing parent_required when goal_id and parent_task_id are both missing', () => {
    context = createTestContext();

    expect(() => {
      context?.runtime.create_task(
        {
          title: 'Task',
          task_type: 'task',
          project_id: 'PROJ-001',
        },
        'lead',
      );
    }).toThrowError('task requires parent_task_id');
  });

  it('rejects mismatched goal_id on create_task', () => {
    context = createTestContext();

    const goalA = context.taskManager.createTask({
      title: 'Goal A',
      task_type: 'goal',
      project_id: 'PROJ-001',
    });
    const goalB = context.taskManager.createTask({
      title: 'Goal B',
      task_type: 'goal',
      project_id: 'PROJ-001',
    });

    expect(() => {
      context?.taskManager.createTask({
        title: 'Task',
        task_type: 'task',
        parent_task_id: goalA.id,
        goal_id: goalB.id,
        project_id: 'PROJ-001',
      });
    }).toThrowError(TasksError);
  });

  it('filters tasks by depth limit', () => {
    context = createTestContext();

    const goal = context.taskManager.createTask({
      title: 'Goal',
      task_type: 'goal',
      project_id: 'PROJ-001',
    });
    const task = context.taskManager.createTask({
      title: 'Task',
      task_type: 'task',
      parent_task_id: goal.id,
      project_id: 'PROJ-001',
    });
    context.taskManager.createTask({
      title: 'Child',
      task_type: 'task',
      parent_task_id: task.id,
      project_id: 'PROJ-001',
    });

    const depth1 = context.taskManager.listTasks({ depth: 1 });
    expect(depth1.map((item) => item.id)).toEqual(
      expect.arrayContaining([goal.id, task.id]),
    );
    expect(depth1.some((item) => item.depth > 1)).toBe(false);
  });

  it('rejects reparent updates', () => {
    context = createTestContext();

    const goal = context.taskManager.createTask({
      title: 'Goal',
      task_type: 'goal',
      project_id: 'PROJ-001',
    });

    const task = context.taskManager.createTask({
      title: 'Task',
      task_type: 'task',
      parent_task_id: goal.id,
      project_id: goal.project_id,
    });

    const otherGoal = context.taskManager.createTask({
      title: 'Other Goal',
      task_type: 'goal',
      project_id: 'PROJ-001',
    });

    expect(() => {
      context?.taskManager.updateTask(task.id, { parent_task_id: otherGoal.id });
    }).toThrowError(TasksError);
  });

  it('enforces approve_task quality gate and acceptance criteria', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    const task = context.runtime.create_task(
      {
      title: 'Task',
      task_type: 'task',
      parent_task_id: goal.goal_id,
      project_id: 'PROJ-001',
      acceptance_criteria: [
        {
          id: 'AC-001',
          description: 'works',
          type: 'functional',
          verified: false,
          verified_by: null,
          verified_at: null,
        },
      ],
      },
      'lead',
    );

    context.runtime.claim_and_start({ task_id: task.id, agent_id: 'worker' });
    const completed = context.runtime.complete_task({ task_id: task.id, agent_id: 'worker' });
    expect(completed.new_status).toBe('review');

    const gate = context.qualityGateManager.create_quality_gate({
      task_id: task.id,
      gate_type: 'test',
      enforcement_level: 'required',
      exit_criteria: [
        {
          id: 'EC-001',
          description: 'all tests pass',
          type: 'automated',
          evaluator: 'test-runner',
        },
      ],
      checker_agent: 'tester',
    });

    expect(() => {
      context?.runtime.approve_task({ task_id: task.id, agent_id: 'lead' });
    }).toThrowError(TasksError);

    context.qualityGateManager.create_gate_evaluation({
      gate_id: gate.id,
      result: 'pass',
      evaluator_agent: 'tester',
      evaluator_backend: 'codex',
      criteria_results: [
        {
          criterion_id: 'EC-001',
          result: 'pass',
          detail: 'passed',
        },
      ],
    });

    expect(() => {
      context?.runtime.approve_task({ task_id: task.id, agent_id: 'lead' });
    }).toThrowError(TasksError);

    const ready = context.runtime.update_task(
      task.id,
      {
        acceptance_criteria: [
          {
            id: 'AC-001',
            description: 'works',
            type: 'functional',
            verified: true,
            verified_by: 'tester',
            verified_at: new Date().toISOString(),
          },
        ],
      },
      'lead',
    );

    expect(ready.acceptance_criteria[0]?.verified).toBe(true);

    const approved = context.runtime.approve_task({ task_id: task.id, agent_id: 'lead' });
    expect(approved.status).toBe('approved');
  });

  it('purges archived tasks older than retention', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Purge Goal',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });
    const parent = context.runtime.create_task(
      {
        title: 'Purge Parent',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'owner',
    );
    const child = context.runtime.create_task(
      {
        title: 'Purge Child',
        task_type: 'task',
        parent_task_id: parent.id,
        project_id: 'PROJ-001',
      },
      'owner',
    );

    context.runtime.archive_task({ task_id: goal.goal_id, agent_id: 'system' });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    setUpdatedAt(context, [goal.goal_id, parent.id, child.id], old);

    const purged = context.taskManager.purgeArchived(24 * 60 * 60 * 1000);
    expect(purged).toBe(3);

    const remaining = context.db
      .prepare('SELECT COUNT(*) AS count FROM tasks WHERE id IN (?, ?, ?)')
      .get(goal.goal_id, parent.id, child.id) as { count: number };
    expect(remaining.count).toBe(0);
  });

  it('does not purge archived tasks within retention', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Recent Archived Goal',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });
    const task = context.runtime.create_task(
      {
        title: 'Recent Archived Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'owner',
    );

    context.runtime.archive_task({ task_id: goal.goal_id, agent_id: 'system' });

    const purged = context.taskManager.purgeArchived(24 * 60 * 60 * 1000);
    expect(purged).toBe(0);

    const remaining = context.db
      .prepare('SELECT COUNT(*) AS count FROM tasks WHERE id IN (?, ?)')
      .get(goal.goal_id, task.id) as { count: number };
    expect(remaining.count).toBe(2);
  });

  it('does not purge non-archived tasks', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Active Goal',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });
    const task = context.runtime.create_task(
      {
        title: 'Active Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'owner',
    );

    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    setUpdatedAt(context, [goal.goal_id, task.id], old);

    const purged = context.taskManager.purgeArchived(24 * 60 * 60 * 1000);
    expect(purged).toBe(0);

    const remaining = context.db
      .prepare('SELECT COUNT(*) AS count FROM tasks WHERE id IN (?, ?)')
      .get(goal.goal_id, task.id) as { count: number };
    expect(remaining.count).toBe(2);
  });

  it('purges archived parent and children without FK violations', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Cascade Goal',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });
    const parent = context.runtime.create_task(
      {
        title: 'Cascade Parent',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'owner',
    );
    const childA = context.runtime.create_task(
      {
        title: 'Cascade Child A',
        task_type: 'task',
        parent_task_id: parent.id,
        project_id: 'PROJ-001',
      },
      'owner',
    );
    const childB = context.runtime.create_task(
      {
        title: 'Cascade Child B',
        task_type: 'task',
        parent_task_id: parent.id,
        project_id: 'PROJ-001',
      },
      'owner',
    );

    context.runtime.add_dependency({
      task_id: childB.id,
      depends_on: childA.id,
      agent_id: 'owner',
    });
    context.runtime.archive_task({ task_id: goal.goal_id, agent_id: 'system' });

    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    setUpdatedAt(context, [goal.goal_id, parent.id, childA.id, childB.id], old);

    const purged = context.taskManager.purgeArchived(24 * 60 * 60 * 1000);
    expect(purged).toBe(4);

    const dependencyRows = context.db
      .prepare('SELECT COUNT(*) AS count FROM task_dependencies')
      .get() as { count: number };
    expect(dependencyRows.count).toBe(0);
  });

  it('returns the correct purge count for mixed eligible tasks', () => {
    context = createTestContext();

    const archivedOldA = context.runtime.create_goal({
      title: 'Archived Old A',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });
    const archivedOldB = context.runtime.create_goal({
      title: 'Archived Old B',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });
    const archivedRecent = context.runtime.create_goal({
      title: 'Archived Recent',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });
    const activeGoal = context.runtime.create_goal({
      title: 'Active Goal',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });

    context.runtime.archive_task({ task_id: archivedOldA.goal_id, agent_id: 'system' });
    context.runtime.archive_task({ task_id: archivedOldB.goal_id, agent_id: 'system' });
    context.runtime.archive_task({ task_id: archivedRecent.goal_id, agent_id: 'system' });

    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    setUpdatedAt(context, [archivedOldA.goal_id, archivedOldB.goal_id, activeGoal.goal_id], old);

    const purged = context.taskManager.purgeArchived(24 * 60 * 60 * 1000);
    expect(purged).toBe(2);

    expect(context.taskManager.getTask(archivedOldA.goal_id)).toBeNull();
    expect(context.taskManager.getTask(archivedOldB.goal_id)).toBeNull();
    expect(context.taskManager.getTask(archivedRecent.goal_id)).not.toBeNull();
    expect(context.taskManager.getTask(activeGoal.goal_id)).not.toBeNull();
  });

  it('purges archived tasks via runtime API', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Runtime Purge Goal',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });
    const task = context.runtime.create_task(
      {
        title: 'Runtime Purge Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'owner',
    );

    context.runtime.archive_task({ task_id: goal.goal_id, agent_id: 'system' });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    setUpdatedAt(context, [goal.goal_id, task.id], old);

    const result = context.runtime.purge_archived({});
    expect(result).toEqual({
      purged_count: 2,
      retention_hours: 24,
    });
    expect(context.taskManager.getTask(goal.goal_id)).toBeNull();
    expect(context.taskManager.getTask(task.id)).toBeNull();
  });
});
