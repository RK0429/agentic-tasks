import { afterEach, describe, expect, it } from 'vitest';

import { TasksError } from '../src/core/errors.js';
import { createTestContext, type TestContext } from './test-utils.js';

describe('Project and Sprint management', () => {
  let context: TestContext | undefined;

  afterEach(() => {
    context?.cleanup();
    context = undefined;
  });

  it('supports project CRUD and blocks deletion when tasks exist', () => {
    context = createTestContext();

    const created = context.runtime.create_project({
      name: 'Phase5 Project',
      description: 'advanced features',
      wip_limit: 3,
      metadata: { owner: 'pm' },
    });

    expect(created.project.id).toMatch(/^PROJ-/);
    expect(created.project.wip_limit).toBe(3);

    const fetched = context.runtime.get_project(created.project.id);
    expect(fetched.project.name).toBe('Phase5 Project');

    const updated = context.runtime.update_project(created.project.id, {
      wip_limit: 7,
      description: 'updated',
    });
    expect(updated.project.wip_limit).toBe(7);
    expect(updated.project.description).toBe('updated');

    const listed = context.runtime.list_projects();
    expect(listed.projects.some((project) => project.id === created.project.id)).toBe(true);

    const goal = context.runtime.create_goal({
      title: 'Project Goal',
      project_id: created.project.id,
      agent_id: 'owner',
    });

    context.runtime.create_task(
      {
        title: 'Task on project',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: created.project.id,
      },
      'owner',
    );

    expect(() => {
      context?.runtime.delete_project(created.project.id);
    }).toThrowError(TasksError);

    const empty = context.runtime.create_project({
      name: 'Empty Project',
    });
    const deleted = context.runtime.delete_project(empty.project.id);
    expect(deleted.deleted).toBe(true);
  });

  it('supports sprint CRUD and complete_sprint carry-over handling', () => {
    context = createTestContext();

    const project = context.runtime.create_project({
      name: 'Sprint Project',
    }).project;

    const sprint = context.runtime.create_sprint({
      project_id: project.id,
      name: 'Sprint 1',
      phase_number: 5,
      start_date: '2026-03-01',
      end_date: '2026-03-14',
      status: 'active',
    }).sprint;

    expect(sprint.id).toMatch(/^SPRINT-/);
    expect(sprint.status).toBe('active');

    const updated = context.runtime.update_sprint(sprint.id, {
      name: 'Sprint 1 Updated',
      status: 'active',
    });
    expect(updated.sprint.name).toBe('Sprint 1 Updated');

    const list = context.runtime.list_sprints({ project_id: project.id });
    expect(list.sprints.map((item) => item.id)).toContain(sprint.id);

    const goal = context.runtime.create_goal({
      title: 'Sprint Goal',
      project_id: project.id,
      agent_id: 'lead',
    });

    const task = context.runtime.create_task(
      {
        title: 'Carry Over Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: project.id,
        sprint_id: sprint.id,
      },
      'lead',
    );

    context.runtime.claim_and_start({
      task_id: task.id,
      agent_id: 'lead',
      relay_session_id: 'relay-sprint',
    });

    const completed = context.runtime.complete_sprint({
      sprint_id: sprint.id,
      agent_id: 'lead',
    });

    expect(completed.sprint.status).toBe('completed');
    expect(completed.moved_tasks).toContain(task.id);

    const taskAfter = context.taskManager.getTask(task.id);
    expect(taskAfter?.sprint_id).toBeNull();
    expect(taskAfter?.status).toBe('to_do');
  });
});
