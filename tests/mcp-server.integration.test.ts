import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMcpServer } from '../src/mcp-server/server.js';

function parseToolText(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0] as { type: 'text'; text: string } | undefined;
  if (!first || first.type !== 'text') {
    throw new Error('tool response does not contain text payload');
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('MCP server integration', () => {
  let tempDir: string;
  let dbPath: string;
  let client: Client;
  let closeDb: () => void;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'agentic-tasks-mcp-test-'));
    dbPath = path.join(tempDir, 'tasks.db');

    const { server, close } = createMcpServer({ db_path: dbPath });
    closeDb = close;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'agentic-tasks-test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      // no-op
    }

    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers major tools and runs decompose -> claim -> complete orchestration flow', async () => {
    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map((tool) => tool.name));

    for (const required of [
      'ping',
      'decompose_task',
      'claim_and_start',
      'extend_lock',
      'complete_task',
      'approve_task',
      'block_task',
      'reopen_task',
      'archive_task',
      'escalate_task',
      'delegate_task',
      'create_quality_gate',
      'create_checkpoint',
      'create_goal',
      'list_goal_tree',
      'get_execution_view',
      'create_project',
      'list_projects',
      'create_sprint',
      'complete_sprint',
      'create_schedule',
      'get_events',
      'poll_events',
    ]) {
      expect(toolNames.has(required)).toBe(true);
    }

    const createProject = (await client.callTool({
      name: 'create_project',
      arguments: {
        name: 'MCP Advanced Project',
        wip_limit: 4,
      },
    })) as CallToolResult;
    const createdProjectPayload = parseToolText(createProject);
    const project = createdProjectPayload.project as { id: string; wip_limit: number };
    expect(project.id).toMatch(/^PROJ-/);
    expect(project.wip_limit).toBe(4);

    const createSprint = (await client.callTool({
      name: 'create_sprint',
      arguments: {
        project_id: project.id,
        name: 'MCP Sprint',
        start_date: '2026-03-01',
        end_date: '2026-03-14',
        phase_number: 5,
        status: 'active',
      },
    })) as CallToolResult;
    const sprintPayload = parseToolText(createSprint);
    const sprint = sprintPayload.sprint as { id: string; status: string };
    expect(sprint.id).toMatch(/^SPRINT-/);
    expect(sprint.status).toBe('active');

    const goalResult = (await client.callTool({
      name: 'create_goal',
      arguments: {
        title: 'MCP Goal',
        project_id: project.id,
        agent_id: 'lead',
      },
    })) as CallToolResult;

    const goalPayload = parseToolText(goalResult);
    expect(goalPayload.success).toBe(true);
    const goalId = (goalPayload.goal_id as string) ?? '';

    const parentTaskResult = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Parent Task',
        task_type: 'task',
        parent_task_id: goalId,
        project_id: project.id,
        agent_id: 'lead',
      },
    })) as CallToolResult;

    const parentPayload = parseToolText(parentTaskResult);
    const parentTask = parentPayload.task as { id: string };

    const claimParent = (await client.callTool({
      name: 'claim_and_start',
      arguments: {
        task_id: parentTask.id,
        agent_id: 'lead',
        relay_session_id: 'relay-parent',
      },
    })) as CallToolResult;
    expect(parseToolText(claimParent).success).toBe(true);

    const decomposeResult = (await client.callTool({
      name: 'decompose_task',
      arguments: {
        task_id: parentTask.id,
        agent_id: 'lead',
        children: [
          { title: 'Child A', expected_effort: 'S' },
          { title: 'Child B', expected_effort: 'M' },
        ],
        dependencies: [{ from_index: 0, to_index: 1, type: 'finish_to_start' }],
      },
    })) as CallToolResult;

    const decomposePayload = parseToolText(decomposeResult);
    expect(decomposePayload.success).toBe(true);

    const children = decomposePayload.children as Array<{ task_id: string }>;
    expect(children).toHaveLength(2);

    const childAId = children[0]?.task_id;
    const childBId = children[1]?.task_id;

    const claimA = (await client.callTool({
      name: 'claim_and_start',
      arguments: {
        task_id: childAId,
        agent_id: 'worker-a',
        relay_session_id: 'relay-a',
      },
    })) as CallToolResult;
    expect(parseToolText(claimA).success).toBe(true);

    const completeA = (await client.callTool({
      name: 'complete_task',
      arguments: {
        task_id: childAId,
        agent_id: 'worker-a',
      },
    })) as CallToolResult;

    const completeAPayload = parseToolText(completeA);
    expect(completeAPayload.success).toBe(true);
    expect(completeAPayload.status).toBe('completed');
    expect(completeAPayload.new_status).toBe('review');

    const approveA = (await client.callTool({
      name: 'approve_task',
      arguments: {
        task_id: childAId,
        agent_id: 'lead',
      },
    })) as CallToolResult;
    const approveAPayload = parseToolText(approveA);
    expect(approveAPayload.success).toBe(true);
    expect(approveAPayload.status).toBe('approved');

    const claimB = (await client.callTool({
      name: 'claim_and_start',
      arguments: {
        task_id: childBId,
        agent_id: 'worker-b',
        relay_session_id: 'relay-b',
      },
    })) as CallToolResult;
    expect(parseToolText(claimB).success).toBe(true);

    const completeB = (await client.callTool({
      name: 'complete_task',
      arguments: {
        task_id: childBId,
        agent_id: 'worker-b',
      },
    })) as CallToolResult;

    const completeBPayload = parseToolText(completeB);
    expect(completeBPayload.success).toBe(true);
    expect(completeBPayload.status).toBe('completed');
    expect(completeBPayload.new_status).toBe('review');

    const approveB = (await client.callTool({
      name: 'approve_task',
      arguments: {
        task_id: childBId,
        agent_id: 'lead',
      },
    })) as CallToolResult;
    const approveBPayload = parseToolText(approveB);
    expect(approveBPayload.success).toBe(true);
    expect(approveBPayload.status).toBe('approved');

    const subtaskStatus = (await client.callTool({
      name: 'get_subtask_status',
      arguments: {
        parent_task_id: parentTask.id,
      },
    })) as CallToolResult;

    const subtaskPayload = parseToolText(subtaskStatus);
    expect(subtaskPayload.success).toBe(true);
    const summary = subtaskPayload.summary as { by_status: Record<string, number> };
    expect(summary.by_status.done).toBe(2);

    const scheduleResult = (await client.callTool({
      name: 'create_schedule',
      arguments: {
        name: 'MCP Schedule',
        cron: '* * * * *',
        project_id: project.id,
        task_template: {
          title: 'MCP Scheduled Task',
          task_type: 'task',
          parent_task_id: goalId,
        },
      },
    })) as CallToolResult;
    const schedulePayload = parseToolText(scheduleResult);
    expect(schedulePayload.success).toBe(true);

    const completeSprint = (await client.callTool({
      name: 'complete_sprint',
      arguments: {
        sprint_id: sprint.id,
      },
    })) as CallToolResult;
    const completedSprintPayload = parseToolText(completeSprint);
    expect(completedSprintPayload.success).toBe(true);
    expect((completedSprintPayload.sprint as { status: string }).status).toBe('completed');
  });

  it('supports ping health check tool', async () => {
    const pingResult = (await client.callTool({
      name: 'ping',
      arguments: {},
    })) as CallToolResult;

    const pingPayload = parseToolText(pingResult);
    expect(pingPayload.success).toBe(true);
    expect(pingPayload.status).toBe('ok');
    expect(typeof pingPayload.timestamp).toBe('string');
    expect(() => new Date(String(pingPayload.timestamp)).toISOString()).not.toThrow();
  });

  it('supports get_events/poll_events tools', async () => {
    const goalResult = (await client.callTool({
      name: 'create_goal',
      arguments: {
        title: 'Events Goal',
        project_id: 'PROJ-001',
        agent_id: 'lead',
      },
    })) as CallToolResult;
    const goalId = String(parseToolText(goalResult).goal_id);

    const taskResult = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Events Task',
        task_type: 'task',
        parent_task_id: goalId,
        project_id: 'PROJ-001',
        agent_id: 'lead',
      },
    })) as CallToolResult;
    const taskId = (parseToolText(taskResult).task as { id: string }).id;

    const eventsResult = (await client.callTool({
      name: 'get_events',
      arguments: {
        task_id: taskId,
        limit: 10,
      },
    })) as CallToolResult;
    const eventsPayload = parseToolText(eventsResult);
    expect(Array.isArray(eventsPayload.events)).toBe(true);
    expect((eventsPayload.events as unknown[]).length).toBeGreaterThan(0);
    expect(typeof eventsPayload.has_more).toBe('boolean');

    const pollResult = (await client.callTool({
      name: 'poll_events',
      arguments: {
        cursor: '0',
        project_id: 'PROJ-001',
      },
    })) as CallToolResult;
    const pollPayload = parseToolText(pollResult);
    expect(Array.isArray(pollPayload.events)).toBe(true);
    expect(typeof pollPayload.next_cursor).toBe('string');
  });
});
