import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { TasksError, TasksRuntime } from '../core/index.js';
import { openDatabase } from '../db/index.js';

const DEFAULT_DB_PATH = path.resolve(process.cwd(), '.tasks/agentic-tasks.db');

function toToolResponse(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function toErrorResponse(error: unknown) {
  if (error instanceof TasksError) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: false,
              error: {
                code: error.code,
                message: error.message,
              },
              details: error.details,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: false,
            error: {
              code: 'unknown_error',
              message: error instanceof Error ? error.message : String(error),
            },
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

function registerTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  handler: (input: Record<string, unknown>) => unknown,
): void {
  server.tool(name, description, inputSchema, async (input) => {
    try {
      const output = await handler(input as Record<string, unknown>);
      return toToolResponse({ success: true, ...((output as Record<string, unknown>) ?? {}) });
    } catch (error) {
      return toErrorResponse(error);
    }
  });
}

export interface CreateMcpServerOptions {
  db_path?: string;
}

export function createMcpServer(options: CreateMcpServerOptions = {}): {
  server: McpServer;
  runtime: TasksRuntime;
  close: () => void;
} {
  const db_path = options.db_path ?? process.env.AGENTIC_TASKS_DB_PATH ?? DEFAULT_DB_PATH;
  mkdirSync(path.dirname(db_path), { recursive: true });

  const db = openDatabase({ db_path, initialize: true });
  const runtime = new TasksRuntime(db);

  const server = new McpServer({
    name: 'agentic-tasks',
    version: '0.1.0',
  });

  registerTool(
    server,
    'create_task',
    'Create a task with hierarchy fields, phase and expected effort.',
    {
      title: z.string(),
      description: z.string().optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      task_type: z.enum(['goal', 'task']).optional(),
      parent_task_id: z.string().nullable().optional(),
      project_id: z.string().optional(),
      sprint_id: z.string().nullable().optional(),
      status: z
        .enum(['backlog', 'to_do', 'in_progress', 'review', 'done', 'blocked', 'escalated', 'archived'])
        .optional(),
      assignee: z.string().nullable().optional(),
      acceptance_criteria: z
        .array(
          z.object({
            id: z.string(),
            description: z.string(),
            type: z.enum(['functional', 'non_functional', 'technical', 'ux']),
            verified: z.boolean(),
            verified_by: z.string().nullable(),
            verified_at: z.string().nullable(),
          }),
        )
        .nullable()
        .optional(),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
      created_by: z.string().nullable().optional(),
      phase: z
        .enum([
          'analysis',
          'requirements',
          'design',
          'wbs',
          'risk',
          'implementation',
          'review',
          'integration',
        ])
        .nullable()
        .optional(),
      source_ref: z.string().nullable().optional(),
      expected_effort: z.enum(['XS', 'S', 'M', 'L', 'XL']).nullable().optional(),
      agent_id: z.string(),
    },
    (input) => {
      return {
        task: runtime.create_task(
          {
            title: String(input.title),
            description: input.description as string | undefined,
            priority: input.priority as 'critical' | 'high' | 'medium' | 'low' | undefined,
            task_type: input.task_type as 'goal' | 'task' | undefined,
            parent_task_id: (input.parent_task_id as string | null | undefined) ?? undefined,
            project_id: input.project_id as string | undefined,
            sprint_id: (input.sprint_id as string | null | undefined) ?? undefined,
            status: input.status as
              | 'backlog'
              | 'to_do'
              | 'in_progress'
              | 'review'
              | 'done'
              | 'blocked'
              | 'escalated'
              | 'archived'
              | undefined,
            assignee: (input.assignee as string | null | undefined) ?? undefined,
            acceptance_criteria: (input.acceptance_criteria as never) ?? undefined,
            metadata: (input.metadata as Record<string, unknown> | null | undefined) ?? undefined,
            created_by: (input.created_by as string | null | undefined) ?? undefined,
            phase: (input.phase as
              | 'analysis'
              | 'requirements'
              | 'design'
              | 'wbs'
              | 'risk'
              | 'implementation'
              | 'review'
              | 'integration'
              | null
              | undefined) ?? undefined,
            source_ref: (input.source_ref as string | null | undefined) ?? undefined,
            expected_effort: (input.expected_effort as 'XS' | 'S' | 'M' | 'L' | 'XL' | null | undefined) ??
              undefined,
          },
          String(input.agent_id),
        ),
      };
    },
  );

  registerTool(
    server,
    'update_task',
    'Update task fields with access control and quality-gate constraints.',
    {
      task_id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z
        .enum(['backlog', 'to_do', 'in_progress', 'review', 'done', 'blocked', 'escalated', 'archived'])
        .optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      sprint_id: z.string().nullable().optional(),
      assignee: z.string().nullable().optional(),
      acceptance_criteria: z
        .array(
          z.object({
            id: z.string(),
            description: z.string(),
            type: z.enum(['functional', 'non_functional', 'technical', 'ux']),
            verified: z.boolean(),
            verified_by: z.string().nullable(),
            verified_at: z.string().nullable(),
          }),
        )
        .nullable()
        .optional(),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
      phase: z
        .enum([
          'analysis',
          'requirements',
          'design',
          'wbs',
          'risk',
          'implementation',
          'review',
          'integration',
        ])
        .nullable()
        .optional(),
      source_ref: z.string().nullable().optional(),
      expected_effort: z.enum(['XS', 'S', 'M', 'L', 'XL']).nullable().optional(),
      actual_effort_ms: z.number().int().nullable().optional(),
      agent_id: z.string(),
    },
    (input) => {
      return {
        task: runtime.update_task(
          String(input.task_id),
          {
            title: input.title as string | undefined,
            description: input.description as string | undefined,
            status: input.status as
              | 'backlog'
              | 'to_do'
              | 'in_progress'
              | 'review'
              | 'done'
              | 'blocked'
              | 'escalated'
              | 'archived'
              | undefined,
            priority: input.priority as 'critical' | 'high' | 'medium' | 'low' | undefined,
            sprint_id: (input.sprint_id as string | null | undefined) ?? undefined,
            assignee: (input.assignee as string | null | undefined) ?? undefined,
            acceptance_criteria: (input.acceptance_criteria as never) ?? undefined,
            metadata: (input.metadata as Record<string, unknown> | null | undefined) ?? undefined,
            phase: (input.phase as
              | 'analysis'
              | 'requirements'
              | 'design'
              | 'wbs'
              | 'risk'
              | 'implementation'
              | 'review'
              | 'integration'
              | null
              | undefined) ?? undefined,
            source_ref: (input.source_ref as string | null | undefined) ?? undefined,
            expected_effort: (input.expected_effort as 'XS' | 'S' | 'M' | 'L' | 'XL' | null | undefined) ??
              undefined,
            actual_effort_ms: (input.actual_effort_ms as number | null | undefined) ?? undefined,
          },
          String(input.agent_id),
        ),
      };
    },
  );

  registerTool(
    server,
    'get_task',
    'Get task details including gates, dependencies and hierarchy metadata.',
    {
      task_id: z.string(),
      include_dependencies: z.boolean().default(true),
    },
    (input) => {
      return runtime.get_task(String(input.task_id), Boolean(input.include_dependencies));
    },
  );

  registerTool(
    server,
    'delete_task',
    'Delete a task (creator only).',
    {
      task_id: z.string(),
      agent_id: z.string(),
    },
    (input) => runtime.delete_task(String(input.task_id), String(input.agent_id)),
  );

  registerTool(
    server,
    'assign_task',
    'Assign task with WIP limit validation.',
    {
      task_id: z.string(),
      assignee: z.string().nullable(),
      agent_id: z.string(),
    },
    (input) =>
      runtime.assign_task({
        task_id: String(input.task_id),
        assignee: (input.assignee as string | null) ?? null,
        agent_id: String(input.agent_id),
      }),
  );

  registerTool(
    server,
    'release_task',
    'Release task lock.',
    {
      task_id: z.string(),
      agent_id: z.string(),
    },
    (input) => runtime.release_task({ task_id: String(input.task_id), agent_id: String(input.agent_id) }),
  );

  registerTool(
    server,
    'extend_lock',
    'Extend task lock TTL.',
    {
      task_id: z.string(),
      relay_session_id: z.string().optional(),
      extend_ms: z.number().int().min(1).optional(),
    },
    (input) =>
      runtime.extend_lock({
        task_id: String(input.task_id),
        relay_session_id: input.relay_session_id as string | undefined,
        extend_ms: input.extend_ms as number | undefined,
      }),
  );

  registerTool(
    server,
    'resolve_dependencies',
    'Resolve dependency state for a task.',
    {
      task_id: z.string(),
    },
    (input) => runtime.resolve_dependencies(String(input.task_id)),
  );

  registerTool(
    server,
    'next_task',
    'Get next executable task by priority and dependency resolution with WIP check.',
    {
      project_id: z.string(),
      assignee: z.string().optional(),
    },
    (input) => ({ task: runtime.next_task({ project_id: String(input.project_id), assignee: input.assignee as string | undefined }) }),
  );

  registerTool(
    server,
    'dashboard',
    'Get project dashboard including goal progress rollups.',
    {
      project_id: z.string(),
    },
    (input) => runtime.dashboard({ project_id: String(input.project_id) }),
  );

  registerTool(
    server,
    'create_project',
    'Create a project.',
    {
      name: z.string(),
      description: z.string().optional(),
      wip_limit: z.number().int().min(1).optional(),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    },
    (input) =>
      runtime.create_project({
        name: String(input.name),
        description: input.description as string | undefined,
        wip_limit: input.wip_limit as number | undefined,
        metadata: (input.metadata as Record<string, unknown> | null | undefined) ?? undefined,
      }),
  );

  registerTool(
    server,
    'get_project',
    'Get a project.',
    {
      project_id: z.string(),
    },
    (input) => runtime.get_project(String(input.project_id)),
  );

  registerTool(
    server,
    'update_project',
    'Update a project.',
    {
      project_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      wip_limit: z.number().int().min(1).optional(),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    },
    (input) =>
      runtime.update_project(String(input.project_id), {
        name: input.name as string | undefined,
        description: input.description as string | undefined,
        wip_limit: input.wip_limit as number | undefined,
        metadata: (input.metadata as Record<string, unknown> | null | undefined) ?? undefined,
      }),
  );

  registerTool(
    server,
    'list_projects',
    'List projects.',
    {},
    () => runtime.list_projects(),
  );

  registerTool(
    server,
    'delete_project',
    'Delete a project. Rejected when project has tasks.',
    {
      project_id: z.string(),
    },
    (input) => runtime.delete_project(String(input.project_id)),
  );

  registerTool(
    server,
    'create_sprint',
    'Create a sprint.',
    {
      project_id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      phase_number: z.number().int().min(0).max(7).optional(),
      start_date: z.string(),
      end_date: z.string(),
      status: z.enum(['planned', 'active', 'completed']).optional(),
    },
    (input) =>
      runtime.create_sprint({
        project_id: String(input.project_id),
        name: String(input.name),
        description: input.description as string | undefined,
        phase_number: input.phase_number as number | undefined,
        start_date: String(input.start_date),
        end_date: String(input.end_date),
        status: input.status as 'planned' | 'active' | 'completed' | undefined,
      }),
  );

  registerTool(
    server,
    'update_sprint',
    'Update a sprint.',
    {
      sprint_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      phase_number: z.number().int().min(0).max(7).optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      status: z.enum(['planned', 'active', 'completed']).optional(),
    },
    (input) =>
      runtime.update_sprint(String(input.sprint_id), {
        name: input.name as string | undefined,
        description: input.description as string | undefined,
        phase_number: input.phase_number as number | undefined,
        start_date: input.start_date as string | undefined,
        end_date: input.end_date as string | undefined,
        status: input.status as 'planned' | 'active' | 'completed' | undefined,
      }),
  );

  registerTool(
    server,
    'list_sprints',
    'List sprints with optional project/status filters.',
    {
      project_id: z.string().optional(),
      status: z.enum(['planned', 'active', 'completed']).optional(),
    },
    (input) =>
      runtime.list_sprints({
        project_id: input.project_id as string | undefined,
        status: input.status as 'planned' | 'active' | 'completed' | undefined,
      }),
  );

  registerTool(
    server,
    'complete_sprint',
    'Complete a sprint and move remaining open tasks out of the sprint.',
    {
      sprint_id: z.string(),
      agent_id: z.string().optional(),
    },
    (input) =>
      runtime.complete_sprint({
        sprint_id: String(input.sprint_id),
        agent_id: input.agent_id as string | undefined,
      }),
  );

  registerTool(
    server,
    'create_schedule',
    'Create a schedule that auto-generates tasks from a cron expression.',
    {
      name: z.string(),
      cron: z.string().optional(),
      cron_expression: z.string().optional(),
      task_template: z.record(z.string(), z.unknown()),
      project_id: z.string(),
      enabled: z.boolean().optional(),
      max_instances: z.number().int().min(1).optional(),
      next_run_at: z.string().nullable().optional(),
    },
    (input) => {
      const cron = (input.cron_expression as string | undefined) ?? (input.cron as string | undefined);
      if (!cron) {
        throw new TasksError('invalid_cron_expression', 'cron or cron_expression is required');
      }

      return runtime.create_schedule({
        name: String(input.name),
        cron,
        task_template: input.task_template as never,
        project_id: String(input.project_id),
        enabled: input.enabled as boolean | undefined,
        max_instances: input.max_instances as number | undefined,
        next_run_at: (input.next_run_at as string | null | undefined) ?? undefined,
      });
    },
  );

  registerTool(
    server,
    'update_schedule',
    'Update a schedule.',
    {
      schedule_id: z.string(),
      name: z.string().optional(),
      cron: z.string().optional(),
      cron_expression: z.string().optional(),
      task_template: z.record(z.string(), z.unknown()).optional(),
      project_id: z.string().optional(),
      enabled: z.boolean().optional(),
      max_instances: z.number().int().min(1).optional(),
      last_run_at: z.string().nullable().optional(),
      next_run_at: z.string().nullable().optional(),
    },
    (input) =>
      runtime.update_schedule(String(input.schedule_id), {
        name: input.name as string | undefined,
        cron: ((input.cron_expression as string | undefined) ?? input.cron) as string | undefined,
        task_template: input.task_template as never,
        project_id: input.project_id as string | undefined,
        enabled: input.enabled as boolean | undefined,
        max_instances: input.max_instances as number | undefined,
        last_run_at: (input.last_run_at as string | null | undefined) ?? undefined,
        next_run_at: (input.next_run_at as string | null | undefined) ?? undefined,
      }),
  );

  registerTool(
    server,
    'delete_schedule',
    'Delete a schedule.',
    {
      schedule_id: z.string(),
    },
    (input) => runtime.delete_schedule(String(input.schedule_id)),
  );

  registerTool(
    server,
    'list_schedules',
    'List schedules with optional project filter.',
    {
      project_id: z.string().optional(),
    },
    (input) => runtime.list_schedules(input.project_id as string | undefined),
  );

  registerTool(
    server,
    'run_scheduler',
    'Run due schedules immediately and create tasks.',
    {},
    () => runtime.run_scheduler(),
  );

  registerTool(
    server,
    'stale_lock_cleanup',
    'Cleanup stale locks by relay session IDs.',
    {
      stale_session_ids: z.array(z.string()).min(1).optional(),
      relay_session_id: z.string().optional(),
      reason: z.enum([
        'heartbeat_timeout',
        'heartbeat_failure',
        'process_crash',
        'context_overflow',
        'session_timeout',
        'manual_cleanup',
      ]),
      agent_id: z.string(),
    },
    (input) =>
      runtime.stale_lock_cleanup({
        stale_session_ids: input.stale_session_ids as string[] | undefined,
        relay_session_id: input.relay_session_id as string | undefined,
        reason: input.reason as
          | 'heartbeat_timeout'
          | 'heartbeat_failure'
          | 'process_crash'
          | 'context_overflow'
          | 'session_timeout'
          | 'manual_cleanup',
        agent_id: String(input.agent_id),
      }),
  );

  registerTool(
    server,
    'decompose_task',
    'Decompose parent task into child tasks and optional dependencies.',
    {
      task_id: z.string(),
      agent_id: z.string(),
      children: z
        .array(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
            expected_effort: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(),
            acceptance_criteria: z
              .array(
                z.object({
                  id: z.string(),
                  description: z.string(),
                  type: z.enum(['functional', 'non_functional', 'technical', 'ux']),
                  verified: z.boolean().default(false),
                  verified_by: z.string().nullable().default(null),
                  verified_at: z.string().nullable().default(null),
                }),
              )
              .optional(),
          }),
        )
        .min(1),
      dependencies: z
        .array(
          z.object({
            from_index: z.number().int().min(0),
            to_index: z.number().int().min(0),
            type: z.enum(['finish_to_start', 'start_to_start']).optional(),
          }),
        )
        .optional(),
    },
    (input) => runtime.decompose_task(input as never),
  );

  registerTool(
    server,
    'claim_and_start',
    'Atomically claim a task: assign + lock + set in_progress.',
    {
      task_id: z.string(),
      agent_id: z.string(),
      relay_session_id: z.string().optional(),
      lock_duration_ms: z.number().int().min(60_000).optional(),
    },
    (input) => runtime.claim_and_start(input as never),
  );

  registerTool(
    server,
    'complete_task',
    'Complete task with idempotency and lock release.',
    {
      task_id: z.string(),
      agent_id: z.string(),
      actual_effort_ms: z.number().int().optional(),
      result_summary: z.string().optional(),
      skip_review: z.boolean().default(false),
    },
    (input) => runtime.complete_task(input as never),
  );

  registerTool(
    server,
    'escalate_task',
    'Escalate in-progress task.',
    {
      task_id: z.string(),
      agent_id: z.string(),
      reason: z.string(),
      category: z.enum([
        'scope_unclear',
        'technical_blocker',
        'resource_needed',
        'decision_required',
        'quality_concern',
      ]),
      context: z
        .object({
          attempted_approaches: z.array(z.string()).optional(),
          partial_results: z.string().optional(),
          recommended_action: z.string().optional(),
        })
        .optional(),
    },
    (input) => runtime.escalate_task(input as never),
  );

  registerTool(
    server,
    'get_subtask_status',
    'Get direct child subtask statuses and actionable items.',
    {
      parent_task_id: z.string(),
      include_escalated: z.boolean().default(true),
      status_filter: z
        .array(z.enum(['backlog', 'to_do', 'in_progress', 'review', 'done', 'blocked', 'escalated', 'archived']))
        .optional(),
    },
    (input) => runtime.get_subtask_status(input as never),
  );

  registerTool(
    server,
    'delegate_task',
    'Delegate a task to another agent and claim/start it.',
    {
      task_id: z.string(),
      delegator_agent_id: z.string(),
      delegate_agent_id: z.string(),
      delegate_backend: z.enum(['claude', 'codex', 'gemini']).optional(),
      instructions: z.string(),
      relay_session_id: z.string().optional(),
      lock_duration_ms: z.number().int().min(60_000).optional(),
    },
    (input) => runtime.delegate_task(input as never),
  );

  registerTool(
    server,
    'create_quality_gate',
    'Create quality gate definition.',
    {
      task_id: z.string(),
      gate_type: z.enum(['code_review', 'test', 'security', 'deploy', 'acceptance', 'custom']),
      enforcement_level: z.enum(['required', 'recommended']).default('required'),
      exit_criteria: z
        .array(
          z.object({
            id: z.string(),
            description: z.string(),
            type: z.enum(['automated', 'manual', 'hybrid']),
            evaluator: z.string(),
          }),
        )
        .min(1),
      checker_agent: z.string(),
      checker_backend: z.string().optional(),
      max_retries: z.number().int().min(1).max(10).default(3),
      agent_id: z.string(),
    },
    (input) => {
      return runtime.create_quality_gate(
        {
          task_id: String(input.task_id),
          gate_type: input.gate_type as
            | 'code_review'
            | 'test'
            | 'security'
            | 'deploy'
            | 'acceptance'
            | 'custom',
          enforcement_level: input.enforcement_level as 'required' | 'recommended' | undefined,
          exit_criteria: input.exit_criteria as never,
          checker_agent: String(input.checker_agent),
          checker_backend: (input.checker_backend as string | undefined) ?? undefined,
          max_retries: Number(input.max_retries),
        },
        String(input.agent_id),
      );
    },
  );

  registerTool(
    server,
    'evaluate_quality_gate',
    'Evaluate quality gate.',
    {
      gate_id: z.string(),
      result: z.enum(['pass', 'fail']),
      evaluator_agent: z.string(),
      evaluator_backend: z.enum(['claude', 'codex', 'gemini']),
      feedback: z.string().optional(),
      criteria_results: z
        .array(
          z.object({
            criterion_id: z.string(),
            result: z.enum(['pass', 'fail']),
            detail: z.string(),
          }),
        )
        .optional(),
      relay_session_id: z.string().optional(),
    },
    (input) => runtime.evaluate_quality_gate(input as never),
  );

  registerTool(
    server,
    'get_quality_gate',
    'Get quality gate definition and latest evaluation.',
    {
      gate_id: z.string(),
      include_history: z.boolean().default(false),
    },
    (input) => runtime.get_quality_gate(input as never),
  );

  registerTool(
    server,
    'list_quality_gates',
    'List quality gates by task or goal.',
    {
      task_id: z.string().optional(),
      goal_id: z.string().optional(),
      enforcement_level: z.enum(['required', 'recommended']).optional(),
      status: z.enum(['pending', 'passed', 'failed']).optional(),
    },
    (input) => runtime.list_quality_gates(input as never),
  );

  registerTool(
    server,
    'delete_quality_gate',
    'Delete quality gate.',
    {
      gate_id: z.string(),
      force: z.boolean().default(false),
      agent_id: z.string(),
    },
    (input) => runtime.delete_quality_gate(input as never),
  );

  registerTool(
    server,
    'create_checkpoint',
    'Create checkpoint record.',
    {
      project_id: z.string(),
      goal_id: z.string().optional(),
      trigger_type: z.enum(['periodic', 'milestone', 'blocker', 'replan', 'manual']),
      assessment: z.record(z.string(), z.unknown()),
      decisions: z.array(z.record(z.string(), z.unknown())).optional(),
      actions_taken: z.array(z.record(z.string(), z.unknown())).optional(),
      agent_id: z.string(),
    },
    (input) => runtime.create_checkpoint(input as never),
  );

  registerTool(
    server,
    'list_checkpoints',
    'List checkpoints.',
    {
      project_id: z.string(),
      goal_id: z.string().optional(),
      trigger_type: z.enum(['periodic', 'milestone', 'blocker', 'replan', 'manual']).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    (input) => runtime.list_checkpoints(input as never),
  );

  const replanScopeSchema = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('add_task'),
      description: z.string(),
      parent_task_id: z.string().optional(),
      new_task: z.object({
        title: z.string(),
        description: z.string().optional(),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        expected_effort: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(),
        acceptance_criteria: z
          .array(
            z.object({
              id: z.string(),
              description: z.string(),
              type: z.enum(['functional', 'non_functional', 'technical', 'ux']).optional(),
              verified: z.boolean().optional(),
              verified_by: z.string().nullable().optional(),
              verified_at: z.string().nullable().optional(),
            }),
          )
          .optional(),
      }),
    }),
    z.object({
      type: z.literal('modify_task'),
      description: z.string(),
      task_id: z.string(),
      modifications: z.object({
        title: z.string().optional(),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        expected_effort: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(),
        acceptance_criteria: z
          .array(
            z.object({
              id: z.string(),
              description: z.string(),
              type: z.enum(['functional', 'non_functional', 'technical', 'ux']).optional(),
              verified: z.boolean().optional(),
              verified_by: z.string().nullable().optional(),
              verified_at: z.string().nullable().optional(),
            }),
          )
          .optional(),
      }),
    }),
    z.object({
      type: z.literal('remove_task'),
      description: z.string(),
      task_id: z.string(),
    }),
    z.object({
      type: z.literal('add_dependency'),
      description: z.string(),
      task_id: z.string(),
      depends_on: z.string(),
      dependency_type: z.enum(['finish_to_start', 'start_to_start']).optional(),
    }),
    z.object({
      type: z.literal('remove_dependency'),
      description: z.string(),
      task_id: z.string(),
      depends_on: z.string(),
    }),
  ]);

  registerTool(
    server,
    'trigger_replan',
    'Trigger replan with discriminated scope changes.',
    {
      goal_id: z.string(),
      agent_id: z.string(),
      reason: z.string(),
      scope_changes: z.array(replanScopeSchema).optional(),
    },
    (input) => runtime.trigger_replan(input as never),
  );

  registerTool(
    server,
    'create_goal',
    'Create goal task.',
    {
      title: z.string(),
      description: z.string().optional(),
      project_id: z.string(),
      acceptance_criteria: z
        .array(
          z.object({
            id: z.string(),
            description: z.string(),
            type: z.enum(['functional', 'non_functional', 'technical', 'ux']),
            verified: z.boolean().default(false),
            verified_by: z.string().nullable().default(null),
            verified_at: z.string().nullable().default(null),
          }),
        )
        .optional(),
      source_ref: z.string().optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
      agent_id: z.string(),
    },
    (input) => runtime.create_goal(input as never),
  );

  registerTool(
    server,
    'get_goal_progress',
    'Get rolled up goal progress.',
    {
      goal_id: z.string(),
      include_tree: z.boolean().default(false),
    },
    (input) => runtime.get_goal_progress(input as never),
  );

  registerTool(
    server,
    'list_goal_tree',
    'List nested goal tree.',
    {
      goal_id: z.string(),
      max_depth: z.number().int().min(-1).default(2),
      status_filter: z
        .array(z.enum(['backlog', 'to_do', 'in_progress', 'review', 'done', 'blocked', 'escalated', 'archived']))
        .optional(),
      format: z.enum(['tree', 'flat']).default('tree'),
    },
    (input) => runtime.list_goal_tree(input as never),
  );

  registerTool(
    server,
    'get_execution_view',
    'Get execution view (ready/in_progress/blocked/done and dependency edges).',
    {
      goal_id: z.string(),
    },
    (input) => runtime.get_execution_view(input as never),
  );

  return {
    server,
    runtime,
    close: () => db.close(),
  };
}

export async function startMcpServer(options: CreateMcpServerOptions = {}): Promise<void> {
  const { server } = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
