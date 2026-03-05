import { openDatabase } from '../db/index.js';

import { parseMdtmDirectory, type MdtmTaskDraft, type ParseMdtmResult } from './mdtm-parser.js';
import { exportSqliteToMdtm, type ExportMdtmOptions, type ExportMdtmResult } from './sqlite-to-mdtm.js';
import { importMdtmToSqlite, type ImportMdtmOptions, type ImportMdtmResult } from './mdtm-to-sqlite.js';

export interface MigrationCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerifyMigrationResult {
  passed: boolean;
  checks: MigrationCheckResult[];
}

export function verifyMigration(db_path: string): VerifyMigrationResult {
  const db = openDatabase({ db_path, initialize: true });

  try {
    const checks: MigrationCheckResult[] = [];

    const taskCount = (db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count;
    checks.push({
      name: 'task_count_positive',
      passed: taskCount > 0,
      detail: `tasks=${taskCount}`,
    });

    const invalidStatus = (
      db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM tasks
          WHERE status NOT IN ('backlog', 'to_do', 'in_progress', 'review', 'done', 'blocked', 'escalated', 'archived')
          `,
        )
        .get() as { count: number }
    ).count;
    checks.push({
      name: 'status_check',
      passed: invalidStatus === 0,
      detail: `invalid_status=${invalidStatus}`,
    });

    const invalidPriority = (
      db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM tasks
          WHERE priority NOT IN ('critical', 'high', 'medium', 'low')
          `,
        )
        .get() as { count: number }
    ).count;
    checks.push({
      name: 'priority_check',
      passed: invalidPriority === 0,
      detail: `invalid_priority=${invalidPriority}`,
    });

    const dependencyFkIssues = (
      db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM task_dependencies d
          WHERE d.task_id NOT IN (SELECT id FROM tasks)
             OR d.depends_on NOT IN (SELECT id FROM tasks)
          `,
        )
        .get() as { count: number }
    ).count;
    checks.push({
      name: 'dependency_fk_check',
      passed: dependencyFkIssues === 0,
      detail: `invalid_dependencies=${dependencyFkIssues}`,
    });

    const lockCount = (
      db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM task_locks
          WHERE expires_at > datetime('now')
          `,
        )
        .get() as { count: number }
    ).count;
    checks.push({
      name: 'lock_clean_check',
      passed: lockCount === 0,
      detail: `active_locks=${lockCount}`,
    });

    const selfRef = (
      db
        .prepare('SELECT COUNT(*) AS count FROM task_dependencies WHERE task_id = depends_on')
        .get() as { count: number }
    ).count;
    checks.push({
      name: 'self_ref_dependency_check',
      passed: selfRef === 0,
      detail: `self_references=${selfRef}`,
    });

    const cycleCount = (
      db
        .prepare(
          `
          WITH RECURSIVE dep_path(task_id, depends_on, root, path) AS (
            SELECT task_id, depends_on, task_id, task_id || '->' || depends_on
            FROM task_dependencies
            UNION ALL
            SELECT dp.task_id, td.depends_on, dp.root, dp.path || '->' || td.depends_on
            FROM dep_path dp
            JOIN task_dependencies td ON td.task_id = dp.depends_on
            WHERE instr(dp.path, td.depends_on) = 0
          )
          SELECT COUNT(*) AS count
          FROM dep_path
          WHERE depends_on = root
          `,
        )
        .get() as { count: number }
    ).count;
    checks.push({
      name: 'cycle_check',
      passed: cycleCount === 0,
      detail: `cycles=${cycleCount}`,
    });

    const passed = checks.every((check) => check.passed);
    return {
      passed,
      checks,
    };
  } finally {
    db.close();
  }
}

export {
  parseMdtmDirectory,
  importMdtmToSqlite,
  exportSqliteToMdtm,
};

export type {
  MdtmTaskDraft,
  ParseMdtmResult,
  ImportMdtmOptions,
  ImportMdtmResult,
  ExportMdtmOptions,
  ExportMdtmResult,
};
