import { afterEach, describe, expect, it } from 'vitest';

import { createTestContext, type TestContext } from './test-utils.js';

describe('Phase 1-4 regression smoke (with Phase 5 runtime)', () => {
  let context: TestContext | undefined;

  afterEach(() => {
    context?.cleanup();
    context = undefined;
  });

  it('keeps core orchestration flow working', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Regression Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });
    context.runtime.create_goal({
      title: 'Open Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    const taskA = context.runtime.create_task(
      {
        title: 'Smoke A',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
        metadata: { skip_review: true },
      },
      'lead',
    );

    const taskB = context.runtime.create_task(
      {
        title: 'Smoke B',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );

    context.dependencyResolver.add_dependency({
      task_id: taskB.id,
      depends_on: taskA.id,
      type: 'finish_to_start',
      triggered_by: 'lead',
    });

    context.runtime.claim_and_start({ task_id: taskA.id, agent_id: 'worker-a' });
    context.runtime.complete_task({ task_id: taskA.id, agent_id: 'worker-a' });

    const resolution = context.runtime.resolve_dependencies(taskB.id);
    expect(resolution.is_resolved).toBe(true);

    const gate = context.runtime.create_quality_gate(
      {
        task_id: taskB.id,
        gate_type: 'test',
        enforcement_level: 'required',
        exit_criteria: [
          {
            id: 'EC-001',
            description: 'smoke test',
            type: 'automated',
            evaluator: 'tester',
          },
        ],
        checker_agent: 'tester',
      },
      'lead',
    );

    context.runtime.claim_and_start({ task_id: taskB.id, agent_id: 'worker-b' });
    context.runtime.complete_task({ task_id: taskB.id, agent_id: 'worker-b' });

    context.runtime.evaluate_quality_gate({
      gate_id: gate.gate_id,
      result: 'pass',
      evaluator_agent: 'lead',
      evaluator_backend: 'codex',
    });

    context.runtime.approve_task({ task_id: taskB.id, agent_id: 'lead' });

    const dashboard = context.runtime.dashboard({ project_id: 'PROJ-001' });
    expect(dashboard.project_id).toBe('PROJ-001');
    expect(dashboard.goals.some((item) => item.goal_id === goal.goal_id)).toBe(true);
  });
});
