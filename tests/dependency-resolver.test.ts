import { afterEach, describe, expect, it } from 'vitest';

import { TasksError } from '../src/core/errors.js';
import { createTestContext, type TestContext } from './test-utils.js';

describe('DependencyResolver', () => {
  let context: TestContext | undefined;

  afterEach(() => {
    context?.cleanup();
    context = undefined;
  });

  it('adds dependencies and sorts tasks topologically', () => {
    context = createTestContext();

    const goal = context.taskManager.createTask({
      title: 'Goal',
      task_type: 'goal',
      project_id: 'PROJ-001',
    });

    const t1 = context.taskManager.createTask({
      title: 'T1',
      task_type: 'task',
      parent_task_id: goal.id,
      project_id: goal.project_id,
    });
    const t2 = context.taskManager.createTask({
      title: 'T2',
      task_type: 'task',
      parent_task_id: goal.id,
      project_id: goal.project_id,
    });
    const t3 = context.taskManager.createTask({
      title: 'T3',
      task_type: 'task',
      parent_task_id: goal.id,
      project_id: goal.project_id,
    });

    context.dependencyResolver.add_dependency({ task_id: t2.id, depends_on: t1.id });
    context.dependencyResolver.add_dependency({ task_id: t3.id, depends_on: t2.id });

    const sorted = context.dependencyResolver.topological_sort(goal.id);

    expect(sorted.indexOf(t1.id)).toBeLessThan(sorted.indexOf(t2.id));
    expect(sorted.indexOf(t2.id)).toBeLessThan(sorted.indexOf(t3.id));

    expect(context.dependencyResolver.are_dependencies_resolved(t2.id)).toBe(false);
    context.runtime.archive_task({ task_id: t1.id, agent_id: 'system' });
    expect(context.dependencyResolver.are_dependencies_resolved(t2.id)).toBe(true);
  });

  it('rejects cyclic dependency', () => {
    context = createTestContext();

    const goal = context.taskManager.createTask({
      title: 'Goal',
      task_type: 'goal',
      project_id: 'PROJ-001',
    });

    const a = context.taskManager.createTask({
      title: 'A',
      task_type: 'task',
      parent_task_id: goal.id,
      project_id: goal.project_id,
    });
    const b = context.taskManager.createTask({
      title: 'B',
      task_type: 'task',
      parent_task_id: goal.id,
      project_id: goal.project_id,
    });

    context.dependencyResolver.add_dependency({ task_id: b.id, depends_on: a.id });

    expect(() => {
      context?.dependencyResolver.add_dependency({ task_id: a.id, depends_on: b.id });
    }).toThrowError(TasksError);
  });

  it('rejects dependencies across goals', () => {
    context = createTestContext();

    const g1 = context.taskManager.createTask({
      title: 'G1',
      task_type: 'goal',
      project_id: 'PROJ-001',
    });
    const g2 = context.taskManager.createTask({
      title: 'G2',
      task_type: 'goal',
      project_id: 'PROJ-001',
    });

    const t1 = context.taskManager.createTask({
      title: 'T1',
      task_type: 'task',
      parent_task_id: g1.id,
      project_id: g1.project_id,
    });
    const t2 = context.taskManager.createTask({
      title: 'T2',
      task_type: 'task',
      parent_task_id: g2.id,
      project_id: g2.project_id,
    });

    expect(() => {
      context?.dependencyResolver.add_dependency({ task_id: t1.id, depends_on: t2.id });
    }).toThrowError(TasksError);
  });
});
