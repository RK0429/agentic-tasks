import { afterEach, describe, expect, it } from 'vitest';

import { TasksError } from '../src/core/errors.js';
import { createTestContext, type TestContext } from './test-utils.js';

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

  it('validates status transitions and quality gate enforcement', () => {
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
    });

    expect(() => {
      context?.taskManager.updateTask(task.id, { status: 'done' });
    }).toThrowError(TasksError);

    context.taskManager.updateTask(task.id, { status: 'to_do' });
    context.taskManager.updateTask(task.id, { status: 'in_progress' });
    context.taskManager.updateTask(task.id, { status: 'review' });

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
      context?.taskManager.updateTask(task.id, { status: 'done' });
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
      context?.taskManager.updateTask(task.id, { status: 'done' });
    }).toThrowError(TasksError);

    const ready = context.taskManager.updateTask(task.id, {
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
    });

    expect(ready.acceptance_criteria[0]?.verified).toBe(true);

    const done = context.taskManager.updateTask(task.id, { status: 'done' });
    expect(done.status).toBe('done');
  });
});
