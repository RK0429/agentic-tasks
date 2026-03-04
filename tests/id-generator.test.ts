import { afterEach, describe, expect, it } from 'vitest';

import { createTestContext, type TestContext } from './test-utils.js';

describe('IdGenerator', () => {
  let context: TestContext | undefined;

  afterEach(() => {
    context?.cleanup();
    context = undefined;
  });

  it('generates global sequential IDs with zero padding', () => {
    context = createTestContext();

    const task1 = context.idGenerator.generate('TASK');
    const task2 = context.idGenerator.generate('TASK');
    const goal1 = context.idGenerator.generate('GOAL');

    expect(task1).toBe('TASK-001');
    expect(task2).toBe('TASK-002');
    expect(goal1).toBe('GOAL-001');
  });

  it('expands digits when sequence exceeds 999', () => {
    context = createTestContext();

    context.db
      .prepare('UPDATE system_counters SET next_value = 1000 WHERE counter_key = ?')
      .run('TASK');

    const task = context.idGenerator.generate('TASK');
    expect(task).toBe('TASK-1000');
  });
});
