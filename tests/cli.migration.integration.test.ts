import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';

function runCli(args: string[]): Record<string, unknown> {
  const cliPath = path.resolve(process.cwd(), 'src/cli/tasks.ts');
  const stdout = execFileSync('node', ['--import', 'tsx', cliPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  return JSON.parse(stdout) as Record<string, unknown>;
}

describe('CLI migration commands', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('supports migrate import/export/verify commands', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'agentic-tasks-cli-migrate-'));

    const dbPath = path.join(tempDir, 'tasks.db');
    const sourceDir = path.join(tempDir, 'mdtm-source');
    const exportDir = path.join(tempDir, 'mdtm-export');

    mkdirSync(path.join(sourceDir, 'GOAL-001', 'TASK-001'), { recursive: true });
    writeFileSync(
      path.join(sourceDir, 'GOAL-001', '_goal.md'),
      matter.stringify('Goal\n', {
        id: 'GOAL-001',
        title: 'CLI Migration Goal',
        status: 'to_do',
        priority: 'high',
        task_type: 'goal',
        project_id: 'PROJ-001',
      }),
      'utf8',
    );
    writeFileSync(
      path.join(sourceDir, 'GOAL-001', 'TASK-001', '_task.md'),
      matter.stringify('Task\n', {
        id: 'TASK-001',
        title: 'CLI Migration Task',
        status: 'to_do',
        priority: 'medium',
        task_type: 'task',
        parent_task_id: 'GOAL-001',
      }),
      'utf8',
    );

    const imported = runCli(['--db', dbPath, 'migrate', 'import', sourceDir, '--clear-existing']);
    expect(imported.success).toBe(true);
    expect(imported.imported_tasks).toBe(2);

    const verified = runCli(['--db', dbPath, 'migrate', 'verify']);
    expect(verified.passed).toBe(true);

    const exported = runCli(['--db', dbPath, 'migrate', 'export', exportDir]);
    expect(exported.success).toBe(true);
    expect(exported.exported_tasks).toBe(2);
  });
});
