import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';

import {
  exportSqliteToMdtm,
  importMdtmToSqlite,
  parseMdtmDirectory,
  verifyMigration,
} from '../src/migration/index.js';

describe('MDTM migration roundtrip', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('imports MDTM, exports SQLite, and preserves ids/dependencies', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'agentic-tasks-migration-'));

    const sourceDir = path.join(tempDir, 'source-mdtm');
    const targetDir = path.join(tempDir, 'target-mdtm');
    const dbPath = path.join(tempDir, 'tasks.db');
    const secondDbPath = path.join(tempDir, 'tasks-roundtrip.db');

    mkdirSync(path.join(sourceDir, 'GOAL-001', 'TASK-001'), { recursive: true });
    mkdirSync(path.join(sourceDir, 'GOAL-001', 'TASK-002'), { recursive: true });

    writeFileSync(
      path.join(sourceDir, 'GOAL-001', '_goal.md'),
      matter.stringify('Goal description\n', {
        id: 'GOAL-001',
        title: 'Migration Goal',
        status: 'to_do',
        priority: 'high',
        task_type: 'goal',
        project_id: 'PROJ-001',
      }),
      'utf8',
    );

    writeFileSync(
      path.join(sourceDir, 'GOAL-001', 'TASK-001', '_task.md'),
      matter.stringify('Task A description\n', {
        id: 'TASK-001',
        title: 'Task A',
        status: 'done',
        priority: 'high',
        task_type: 'task',
        parent_task_id: 'GOAL-001',
        depends_on: [],
      }),
      'utf8',
    );

    writeFileSync(
      path.join(sourceDir, 'GOAL-001', 'TASK-002', '_task.md'),
      matter.stringify('Task B description\n', {
        id: 'TASK-002',
        title: 'Task B',
        status: 'to_do',
        priority: 'medium',
        task_type: 'task',
        parent_task_id: 'GOAL-001',
        depends_on: ['TASK-001'],
      }),
      'utf8',
    );

    const imported = importMdtmToSqlite({
      source_dir: sourceDir,
      db_path: dbPath,
      clear_existing: true,
    });

    expect(imported.imported_tasks).toBe(3);
    expect(imported.imported_dependencies).toBe(1);

    const verify = verifyMigration(dbPath);
    expect(verify.passed).toBe(true);

    const exported = exportSqliteToMdtm({
      db_path: dbPath,
      target_dir: targetDir,
    });

    expect(exported.exported_tasks).toBe(3);
    expect(exported.exported_goals).toBe(1);

    const parsedExport = parseMdtmDirectory(targetDir);
    const exportedIds = parsedExport.tasks.map((task) => task.id).sort();
    expect(exportedIds).toEqual(['GOAL-001', 'TASK-001', 'TASK-002']);

    const task2 = parsedExport.tasks.find((task) => task.id === 'TASK-002');
    expect(task2?.depends_on).toContain('TASK-001');

    const secondImport = importMdtmToSqlite({
      source_dir: targetDir,
      db_path: secondDbPath,
      clear_existing: true,
    });

    expect(secondImport.imported_tasks).toBe(3);
    expect(secondImport.imported_dependencies).toBe(1);

    const exportedGoalPath = path.join(targetDir, 'GOAL-001', '_goal.md');
    const exportedGoal = readFileSync(exportedGoalPath, 'utf8');
    expect(exportedGoal).toContain('id: GOAL-001');
  });
});
