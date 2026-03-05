import { afterEach, describe, expect, it } from 'vitest';

import { createTestContext, type TestContext } from './test-utils.js';

describe('Scheduler', () => {
  let context: TestContext | undefined;

  afterEach(() => {
    context?.cleanup();
    context = undefined;
  });

  it('calculates next run time from cron expression', () => {
    context = createTestContext();

    const base = new Date('2026-03-05T01:30:00.000Z');
    const next = context.scheduler.getNextRunTime('0 */2 * * *', base);
    // Next run should be after the base time and within 2 hours
    expect(next.getTime()).toBeGreaterThan(base.getTime());
    expect(next.getTime() - base.getTime()).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
    // Should land on an even hour boundary (minute = 0)
    expect(next.getMinutes()).toBe(0);
  });

  it('creates tasks for due schedules and updates run timestamps', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Scheduled Goal',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });

    const schedule = context.scheduler.createSchedule({
      name: 'Every 5 min',
      cron: '*/5 * * * *',
      project_id: 'PROJ-001',
      task_template: {
        title: 'Scheduled Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      next_run_at: new Date(Date.now() - 5_000).toISOString(),
    });

    const result = context.scheduler.checkAndRun();
    expect(result.created_tasks).toHaveLength(1);

    const createdTaskId = result.created_tasks[0] ?? '';
    const createdTask = context.taskManager.getTask(createdTaskId);
    expect(createdTask?.title).toBe('Scheduled Task');
    expect(createdTask?.metadata?.schedule_id).toBe(schedule.id);

    const updatedSchedule = context.scheduler.getSchedule(schedule.id);
    expect(updatedSchedule?.last_run_at).not.toBeNull();
    expect(updatedSchedule?.next_run_at).not.toBeNull();
  });

  it('respects max_instances for active scheduled tasks', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Max Instance Goal',
      project_id: 'PROJ-001',
      agent_id: 'owner',
    });

    const schedule = context.scheduler.createSchedule({
      name: 'Single Active',
      cron: '* * * * *',
      project_id: 'PROJ-001',
      max_instances: 1,
      task_template: {
        title: 'Active Limited Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      next_run_at: new Date(Date.now() - 5_000).toISOString(),
    });

    const first = context.scheduler.checkAndRun();
    expect(first.created_tasks).toHaveLength(1);

    context.scheduler.updateSchedule(schedule.id, {
      next_run_at: new Date(Date.now() - 5_000).toISOString(),
    });

    const second = context.scheduler.checkAndRun();
    expect(second.created_tasks).toHaveLength(0);
  });
});
