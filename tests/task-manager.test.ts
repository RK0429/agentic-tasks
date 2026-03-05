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

    const ready = context.runtime.update_task(task.id, {
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

    const approved = context.runtime.approve_task({ task_id: task.id, agent_id: 'lead' });
    expect(approved.status).toBe('approved');
  });
});
