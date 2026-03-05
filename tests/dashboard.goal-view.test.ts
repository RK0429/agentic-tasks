import { afterEach, describe, expect, it } from 'vitest';

import { createTestContext, type TestContext } from './test-utils.js';

describe('dashboard goal view', () => {
  let context: TestContext | undefined;

  afterEach(() => {
    context?.cleanup();
    context = undefined;
  });

  it('aggregates goal progress, child status summary, and quality gate status', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Dashboard Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    const t1 = context.runtime.create_task(
      {
        title: 'T1',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
        metadata: { skip_review: true },
      },
      'lead',
    );
    const t2 = context.runtime.create_task(
      { title: 'T2', task_type: 'task', parent_task_id: goal.goal_id, project_id: 'PROJ-001' },
      'lead',
    );
    const t3 = context.runtime.create_task(
      { title: 'T3', task_type: 'task', parent_task_id: goal.goal_id, project_id: 'PROJ-001' },
      'lead',
    );

    context.runtime.claim_and_start({ task_id: t1.id, agent_id: 'worker-1' });
    context.runtime.complete_task({ task_id: t1.id, agent_id: 'worker-1' });

    context.runtime.claim_and_start({ task_id: t2.id, agent_id: 'worker-2' });

    context.runtime.claim_and_start({ task_id: t3.id, agent_id: 'worker-3' });
    context.runtime.block_task({
      task_id: t3.id,
      agent_id: 'worker-3',
      reason: 'blocked on dependency',
    });

    const gateDone = context.runtime.create_quality_gate(
      {
        task_id: t1.id,
        gate_type: 'test',
        enforcement_level: 'required',
        exit_criteria: [{ id: 'EC-1', description: 'tests', type: 'automated', evaluator: 'ci' }],
        checker_agent: 'ci',
      },
      'lead',
    );
    const gateFailed = context.runtime.create_quality_gate(
      {
        task_id: t2.id,
        gate_type: 'code_review',
        enforcement_level: 'required',
        exit_criteria: [{ id: 'EC-2', description: 'review', type: 'manual', evaluator: 'reviewer' }],
        checker_agent: 'reviewer',
      },
      'lead',
    );
    context.runtime.create_quality_gate(
      {
        task_id: t3.id,
        gate_type: 'security',
        enforcement_level: 'recommended',
        exit_criteria: [{ id: 'EC-3', description: 'scan', type: 'automated', evaluator: 'scanner' }],
        checker_agent: 'scanner',
      },
      'lead',
    );

    context.runtime.evaluate_quality_gate({
      gate_id: gateDone.gate_id,
      result: 'pass',
      evaluator_agent: 'ci',
      evaluator_backend: 'codex',
    });
    context.runtime.evaluate_quality_gate({
      gate_id: gateFailed.gate_id,
      result: 'fail',
      evaluator_agent: 'reviewer',
      evaluator_backend: 'claude',
    });

    const dashboard = context.runtime.dashboard({ project_id: 'PROJ-001' });
    const goalItem = dashboard.goals.find((item) => item.goal_id === goal.goal_id);

    expect(goalItem).toBeTruthy();
    if (!goalItem) {
      throw new Error('goal not found in dashboard');
    }

    expect(goalItem.progress_percent).toBeGreaterThanOrEqual(0);
    expect(goalItem.tasks_summary.total).toBe(3);
    expect(goalItem.tasks_summary.by_status.done).toBe(1);
    expect(goalItem.tasks_summary.by_status.in_progress).toBe(1);
    expect(goalItem.tasks_summary.by_status.blocked).toBe(1);

    expect(goalItem.quality_summary.gates_total).toBe(3);
    expect(goalItem.quality_summary.gates_passed).toBe(1);
    expect(goalItem.quality_summary.gates_failed).toBe(1);
    expect(goalItem.quality_summary.gates_pending).toBe(1);
    expect(goalItem.quality_summary.aggregate_status).toBe('failed');
  });
});
