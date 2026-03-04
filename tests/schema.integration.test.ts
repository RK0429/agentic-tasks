import { afterEach, describe, expect, it } from 'vitest';

import { createTestContext, type TestContext } from './test-utils.js';

describe('schema integration', () => {
  let context: TestContext | undefined;

  afterEach(() => {
    context?.cleanup();
    context = undefined;
  });

  it('creates all required tables and seeds counters', () => {
    context = createTestContext();

    const rows = context.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableSet = new Set(rows.map((row) => row.name));

    for (const table of [
      'system_counters',
      'tasks',
      'task_dependencies',
      'quality_gates',
      'gate_evaluations',
      'projects',
      'sprints',
      'task_locks',
      'task_events',
      'checkpoints',
      'schedules',
    ]) {
      expect(tableSet.has(table)).toBe(true);
    }

    const counters = context.db
      .prepare('SELECT counter_key, next_value FROM system_counters ORDER BY counter_key')
      .all() as Array<{ counter_key: string; next_value: number }>;

    expect(counters.map((row) => row.counter_key)).toEqual([
      'GATE',
      'GOAL',
      'PROJ',
      'SCHED',
      'SPRINT',
      'TASK',
    ]);

    const defaultProject = context.db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get('PROJ-001') as { id: string } | undefined;

    expect(defaultProject?.id).toBe('PROJ-001');
  });
});
