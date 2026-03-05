import { afterEach, describe, expect, it } from 'vitest';

import { TasksError } from '../src/core/errors.js';
import { createTestContext, type TestContext } from './test-utils.js';

describe('Orchestration Protocol E2E', () => {
  let context: TestContext | undefined;

  afterEach(() => {
    context?.cleanup();
    context = undefined;
  });

  it('decompose -> delegate -> claim -> complete -> get_subtask_status full flow', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Protocol Goal',
      project_id: 'PROJ-001',
      agent_id: 'orchestrator',
    });

    const parent = context.runtime.create_task(
      {
        title: 'Protocol Parent',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'orchestrator',
    );

    context.runtime.claim_and_start({
      task_id: parent.id,
      agent_id: 'specialist',
      relay_session_id: 'relay-specialist',
    });

    const decomposed = context.runtime.decompose_task({
      task_id: parent.id,
      agent_id: 'specialist',
      children: [
        { title: 'Child 1', expected_effort: 'S' },
        { title: 'Child 2', expected_effort: 'M' },
      ],
      dependencies: [{ from_index: 0, to_index: 1, type: 'finish_to_start' }],
    });

    const child1 = decomposed.children[0]?.task_id;
    const child2 = decomposed.children[1]?.task_id;
    if (!child1 || !child2) {
      throw new Error('child tasks not found');
    }

    const delegated1 = context.runtime.delegate_task({
      task_id: child1,
      delegator_agent_id: 'specialist',
      delegate_agent_id: 'worker-1',
      delegate_backend: 'codex',
      instructions: 'Implement child 1',
      relay_session_id: 'relay-worker-1',
    });

    expect(delegated1.assigned_to).toBe('worker-1');
    context.runtime.complete_task({ task_id: child1, agent_id: 'worker-1' });
    context.runtime.approve_task({ task_id: child1, agent_id: 'specialist' });

    const delegated2 = context.runtime.delegate_task({
      task_id: child2,
      delegator_agent_id: 'specialist',
      delegate_agent_id: 'worker-2',
      delegate_backend: 'codex',
      instructions: 'Implement child 2',
      relay_session_id: 'relay-worker-2',
    });

    expect(delegated2.assigned_to).toBe('worker-2');
    context.runtime.complete_task({ task_id: child2, agent_id: 'worker-2' });
    context.runtime.approve_task({ task_id: child2, agent_id: 'specialist' });

    const status = context.runtime.get_subtask_status({ parent_task_id: parent.id, include_escalated: true });
    expect(status.summary.by_status.done).toBe(2);
  });

  it('quality gate pass/fail branch and create_checkpoint/trigger_replan', () => {
    context = createTestContext();

    const goal = context.runtime.create_goal({
      title: 'Quality Goal',
      project_id: 'PROJ-001',
      agent_id: 'lead',
    });

    context.runtime.assign_task({ task_id: goal.goal_id, assignee: 'lead', agent_id: 'lead' });

    const task = context.runtime.create_task(
      {
        title: 'Gate Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );
    context.runtime.create_task(
      {
        title: 'Open Task',
        task_type: 'task',
        parent_task_id: goal.goal_id,
        project_id: 'PROJ-001',
      },
      'lead',
    );

    context.runtime.claim_and_start({ task_id: task.id, agent_id: 'maker', relay_session_id: 'relay-maker' });

    const gate = context.runtime.create_quality_gate(
      {
        task_id: task.id,
        gate_type: 'code_review',
        enforcement_level: 'required',
        exit_criteria: [
          {
            id: 'EC-GATE',
            description: 'review pass required',
            type: 'manual',
            evaluator: 'checker',
          },
        ],
        checker_agent: 'checker',
      },
      'maker',
    );

    const complete = context.runtime.complete_task({
      task_id: task.id,
      agent_id: 'maker',
      actual_effort_ms: 60_000,
    });
    expect(complete.status).toBe('completed');
    expect(complete.new_status).toBe('review');

    context.runtime.evaluate_quality_gate({
      gate_id: gate.gate_id,
      result: 'fail',
      evaluator_agent: 'checker',
      evaluator_backend: 'claude',
      feedback: 'insufficient tests',
    });

    expect(() => {
      context?.runtime.approve_task({ task_id: task.id, agent_id: 'lead' });
    }).toThrowError(TasksError);

    context.runtime.evaluate_quality_gate({
      gate_id: gate.gate_id,
      result: 'pass',
      evaluator_agent: 'checker',
      evaluator_backend: 'claude',
      feedback: 'approved',
    });

    const done = context.runtime.approve_task({ task_id: task.id, agent_id: 'lead' });
    expect(done.status).toBe('approved');

    const checkpoint = context.runtime.create_checkpoint({
      project_id: 'PROJ-001',
      goal_id: goal.goal_id,
      trigger_type: 'manual',
      assessment: {
        progress_percent: context.taskManager.getGoalProgressPercent(goal.goal_id),
        on_track: true,
        depth_assessment: 'adequate',
      },
      agent_id: 'lead',
    });

    expect(checkpoint.checkpoint_id).toBeGreaterThan(0);

    const replan = context.runtime.trigger_replan({
      goal_id: goal.goal_id,
      agent_id: 'lead',
      reason: 'scope update',
      scope_changes: [
        {
          type: 'add_task',
          description: 'add follow-up task',
          new_task: {
            title: 'Follow-up',
            priority: 'medium',
          },
        },
      ],
    });

    expect(replan.goal_id).toBe(goal.goal_id);
    expect(replan.replan_summary.tasks_added).toBe(1);

    const checkpoints = context.runtime.list_checkpoints({
      project_id: 'PROJ-001',
      goal_id: goal.goal_id,
    });
    expect(checkpoints.total).toBeGreaterThanOrEqual(2);
  });
});
