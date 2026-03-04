import Database from 'better-sqlite3';

import { EventEmitter } from './event-emitter.js';
import { TasksError } from './errors.js';
import type { TaskLock } from '../types/index.js';

function nowIso(): string {
  return new Date().toISOString();
}

function addMs(dateIso: string, ms: number): string {
  return new Date(new Date(dateIso).getTime() + ms).toISOString();
}

export class LockManager {
  private readonly db: Database.Database;
  private readonly eventEmitter: EventEmitter;

  public constructor(db: Database.Database, eventEmitter: EventEmitter) {
    this.db = db;
    this.eventEmitter = eventEmitter;
  }

  public acquire_lock(
    task_id: string,
    agent_id: string,
    relay_session_id: string | null = null,
    lock_duration_ms = 3_600_000,
  ): TaskLock {
    const tx = this.db.transaction(() => {
      const task = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(task_id) as
        | { id: string }
        | undefined;

      if (!task) {
        throw new TasksError('task_not_found', `task not found: ${task_id}`);
      }

      const current = this.get_lock(task_id);
      const now = nowIso();

      if (current && new Date(current.expires_at).getTime() > Date.now()) {
        throw new TasksError('lock_conflict', 'task is already locked', {
          task_id,
          lock_holder: current.agent_id,
          expires_at: current.expires_at,
        });
      }

      this.db.prepare('DELETE FROM task_locks WHERE task_id = ?').run(task_id);

      const lock: TaskLock = {
        task_id,
        agent_id,
        relay_session_id,
        locked_at: now,
        expires_at: addMs(now, lock_duration_ms),
      };

      this.db
        .prepare(
          `
          INSERT INTO task_locks(task_id, agent_id, relay_session_id, locked_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
          `,
        )
        .run(task_id, agent_id, relay_session_id, lock.locked_at, lock.expires_at);

      this.eventEmitter.emit_task_event({
        task_id,
        event_type: 'locked',
        data: {
          agent_id,
          relay_session_id,
          expires_at: lock.expires_at,
        },
        triggered_by: agent_id,
      });

      return lock;
    });

    return tx();
  }

  public release_lock(task_id: string, agent_id?: string): void {
    const tx = this.db.transaction(() => {
      const lock = this.get_lock(task_id);
      if (!lock) {
        return;
      }

      if (agent_id && lock.agent_id !== agent_id) {
        throw new TasksError('lock_owner_mismatch', 'lock owned by another agent', {
          task_id,
          lock_holder: lock.agent_id,
        });
      }

      this.db.prepare('DELETE FROM task_locks WHERE task_id = ?').run(task_id);

      this.eventEmitter.emit_task_event({
        task_id,
        event_type: 'unlocked',
        data: {
          released_by: agent_id ?? 'system',
        },
        triggered_by: agent_id ?? 'system',
      });
    });

    tx();
  }

  public extend_lock(task_id: string, extend_ms = 3_600_000): TaskLock {
    const lock = this.get_lock(task_id);
    if (!lock) {
      throw new TasksError('not_locked', `task is not locked: ${task_id}`);
    }

    const expires_at = addMs(nowIso(), extend_ms);
    this.db.prepare('UPDATE task_locks SET expires_at = ? WHERE task_id = ?').run(expires_at, task_id);

    return {
      ...lock,
      expires_at,
    };
  }

  public get_lock(task_id: string): TaskLock | null {
    const row = this.db
      .prepare(
        `
        SELECT task_id, agent_id, relay_session_id, locked_at, expires_at
        FROM task_locks
        WHERE task_id = ?
        `,
      )
      .get(task_id) as TaskLock | undefined;

    return row ?? null;
  }
}
