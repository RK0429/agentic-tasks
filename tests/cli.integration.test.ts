import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

function runCli(args: string[]): unknown {
  const cliPath = path.resolve(process.cwd(), 'src/cli/tasks.ts');
  const stdout = execFileSync('node', ['--import', 'tsx', cliPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  return JSON.parse(stdout);
}

describe('CLI integration', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('supports basic CRUD and dependency commands', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'agentic-tasks-cli-'));
    const dbPath = path.join(tempDir, 'tasks.db');

    const init = runCli(['--db', dbPath, 'init']) as { success: boolean };
    expect(init.success).toBe(true);

    const goal = runCli([
      '--db',
      dbPath,
      'create',
      '--title',
      'CLI Goal',
      '--task-type',
      'goal',
      '--project-id',
      'PROJ-001',
    ]) as { task: { id: string } };

    const task1 = runCli([
      '--db',
      dbPath,
      'create',
      '--title',
      'CLI Task 1',
      '--task-type',
      'task',
      '--parent-task-id',
      goal.task.id,
      '--project-id',
      'PROJ-001',
    ]) as { task: { id: string } };

    const task2 = runCli([
      '--db',
      dbPath,
      'create',
      '--title',
      'CLI Task 2',
      '--task-type',
      'task',
      '--parent-task-id',
      goal.task.id,
      '--project-id',
      'PROJ-001',
    ]) as { task: { id: string } };

    const fetched = runCli(['--db', dbPath, 'get', task1.task.id]) as {
      task: { id: string; title: string };
    };

    expect(fetched.task.id).toBe(task1.task.id);
    expect(fetched.task.title).toBe('CLI Task 1');

    const updated = runCli([
      '--db',
      dbPath,
      'update',
      task1.task.id,
      '--status',
      'to_do',
    ]) as { task: { status: string } };

    expect(updated.task.status).toBe('to_do');

    const depAdd = runCli([
      '--db',
      dbPath,
      'deps',
      'add',
      '--task-id',
      task2.task.id,
      '--depends-on',
      task1.task.id,
    ]) as { success: boolean };

    expect(depAdd.success).toBe(true);

    const depList = runCli(['--db', dbPath, 'deps', 'list', task2.task.id]) as {
      dependencies: { upstream: string[] };
    };

    expect(depList.dependencies.upstream).toContain(task1.task.id);

    const list = runCli(['--db', dbPath, 'list', '--project-id', 'PROJ-001']) as {
      tasks: Array<{ id: string }>;
    };

    const ids = list.tasks.map((task) => task.id);
    expect(ids).toContain(task1.task.id);
    expect(ids).toContain(task2.task.id);

    const deleted = runCli(['--db', dbPath, 'delete', task2.task.id]) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);
  });

  it('supports project/sprint/schedule advanced commands', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'agentic-tasks-cli-'));
    const dbPath = path.join(tempDir, 'tasks.db');

    runCli(['--db', dbPath, 'init']);

    const project = runCli([
      '--db',
      dbPath,
      'project',
      'create',
      '--name',
      'CLI Advanced Project',
      '--wip-limit',
      '3',
    ]) as { project: { id: string; wip_limit: number } };

    expect(project.project.id).toMatch(/^PROJ-/);
    expect(project.project.wip_limit).toBe(3);

    const sprint = runCli([
      '--db',
      dbPath,
      'sprint',
      'create',
      '--project-id',
      project.project.id,
      '--name',
      'Sprint CLI',
      '--start-date',
      '2026-03-01',
      '--end-date',
      '2026-03-14',
      '--status',
      'active',
      '--phase-number',
      '5',
    ]) as { sprint: { id: string; status: string } };

    expect(sprint.sprint.id).toMatch(/^SPRINT-/);
    expect(sprint.sprint.status).toBe('active');

    const goal = runCli([
      '--db',
      dbPath,
      'create',
      '--title',
      'Schedule Goal',
      '--task-type',
      'goal',
      '--project-id',
      project.project.id,
    ]) as { task: { id: string } };

    const schedule = runCli([
      '--db',
      dbPath,
      'schedule',
      'create',
      '--name',
      'CLI Schedule',
      '--project-id',
      project.project.id,
      '--cron',
      '* * * * *',
      '--task-template',
      JSON.stringify({
        title: 'From CLI Schedule',
        task_type: 'task',
        parent_task_id: goal.task.id,
      }),
    ]) as { schedule: { id: string } };

    expect(schedule.schedule.id).toMatch(/^SCHED-/);

    const run = runCli(['--db', dbPath, 'schedule', 'run']) as { created_tasks: string[] };
    expect(Array.isArray(run.created_tasks)).toBe(true);

    const completed = runCli([
      '--db',
      dbPath,
      'sprint',
      'complete',
      sprint.sprint.id,
    ]) as { sprint: { status: string } };
    expect(completed.sprint.status).toBe('completed');
  });
});
