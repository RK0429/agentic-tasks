import Database from 'better-sqlite3';

import { TasksError } from './errors.js';
import type { CounterKey } from '../types/index.js';

const PREFIX_BY_COUNTER: Record<CounterKey, string> = {
  TASK: 'TASK',
  GOAL: 'GOAL',
  GATE: 'GATE',
  PROJ: 'PROJ',
  SPRINT: 'SPRINT',
  SCHED: 'SCHED',
};

function nowIso(): string {
  return new Date().toISOString();
}

function formatSequence(value: number): string {
  return value >= 1000 ? `${value}` : `${value}`.padStart(3, '0');
}

function isBusyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'SQLITE_BUSY',
  );
}

export class IdGenerator {
  private readonly db: Database.Database;

  public constructor(db: Database.Database) {
    this.db = db;
  }

  public generate(counter_key: CounterKey): string {
    const prefix = PREFIX_BY_COUNTER[counter_key];
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        this.db.exec('BEGIN IMMEDIATE');

        const row = this.db
          .prepare('SELECT next_value FROM system_counters WHERE counter_key = ?')
          .get(counter_key) as { next_value: number } | undefined;

        if (!row) {
          throw new TasksError('counter_not_found', `counter not found: ${counter_key}`);
        }

        const nextValue = row.next_value;
        this.db
          .prepare('UPDATE system_counters SET next_value = ?, updated_at = ? WHERE counter_key = ?')
          .run(nextValue + 1, nowIso(), counter_key);

        this.db.exec('COMMIT');
        return `${prefix}-${formatSequence(nextValue)}`;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // no-op: transaction may already be closed
        }

        if (attempt === maxRetries || !isBusyError(error)) {
          throw error;
        }
      }
    }

    throw new TasksError('id_generation_failed', `failed to generate id for ${counter_key}`);
  }
}
