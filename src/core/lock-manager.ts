import Database from 'better-sqlite3';

import { EventEmitter } from './event-emitter.js';
import { TasksError } from './errors.js';
import type { TaskLock, TaskStatus } from '../types/index.js';

export type CanonicalStaleCleanupReason =
  | 'heartbeat_timeout'
  | 'process_crash'
  | 'context_overflow'
  | 'session_timeout'
  | 'manual_cleanup';

export type StaleCleanupReason = CanonicalStaleCleanupReason | 'heartbeat_failure';

export interface StaleLockCleanupInput {
  stale_session_ids?: string[];
  relay_session_id?: string;
  reason: StaleCleanupReason;
  agent_id?: string;
}

export interface StaleLockCleanupOutput {
  cleaned_up: boolean;
  released_tasks: Array<{
    task_id: string;
    previous_status: TaskStatus;
    new_status: 'to_do';
  }>;
  events_emitted: number;
  normalized_reason: CanonicalStaleCleanupReason;
  released: string[];
  errors: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMs(dateIso: string, ms: number): string {
  return new Date(new Date(dateIso).getTime() + ms).toISOString();
}

function normalizeReason(reason: StaleCleanupReason): CanonicalStaleCleanupReason {
  if (reason === 'heartbeat_failure') {
    return 'heartbeat_timeout';
  }

  return reason;
}

function normalizeSessionIds(input: StaleLockCleanupInput): string[] {
  const sessions = new Set<string>();

  for (const session of input.stale_session_ids ?? []) {
    const normalized = session.trim();
    if (normalized !== '') {
      sessions.add(normalized);
    }
  }

  const single = input.relay_session_id?.trim();
  if (single) {
    sessions.add(single);
  }

  return [...sessions];
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

  public stale_lock_cleanup(input: StaleLockCleanupInput): StaleLockCleanupOutput {
    const released: string[] = [];
    const released_tasks: StaleLockCleanupOutput['released_tasks'] = [];
    const errors: string[] = [];
    let events_emitted = 0;
    const normalized_reason = normalizeReason(input.reason);
    const actor = input.agent_id?.trim() === '' ? 'system' : (input.agent_id ?? 'system');

    const uniqueSessions = normalizeSessionIds(input);
    if (uniqueSessions.length === 0) {
      throw new TasksError(
        'invalid_input',
        'relay_session_id or stale_session_ids is required for stale_lock_cleanup',
      );
    }

    for (const stale_session_id of uniqueSessions) {
      try {
        const tx = this.db.transaction(() => {
          const lockedTasks = this.db
            .prepare(
              `
              SELECT l.task_id, t.status
              FROM task_locks l
              JOIN tasks t ON t.id = l.task_id
              WHERE l.relay_session_id = ?
              `,
            )
            .all(stale_session_id) as Array<{ task_id: string; status: TaskStatus }>;

          for (const lock of lockedTasks) {
            this.db.prepare('DELETE FROM task_locks WHERE task_id = ?').run(lock.task_id);

            this.db
              .prepare(
                `
                UPDATE tasks
                SET status = ?,
                    assignee = NULL,
                    updated_at = ?,
                    version = version + 1
                WHERE id = ?
                `,
              )
              .run('to_do', nowIso(), lock.task_id);

            this.eventEmitter.emit_task_event({
              task_id: lock.task_id,
              event_type: 'unlocked',
              data: {
                released_by: actor,
                relay_session_id: stale_session_id,
                reason: normalized_reason,
              },
              triggered_by: actor,
            });
            events_emitted += 1;

            this.eventEmitter.emit_task_event({
              task_id: lock.task_id,
              event_type: 'status_changed',
              data: {
                from: lock.status,
                to: 'to_do',
                reason: 'stale_lock_cleanup',
              },
              triggered_by: actor,
            });
            events_emitted += 1;

            this.eventEmitter.emit_task_event({
              task_id: lock.task_id,
              event_type: 'stale_lock_cleaned',
              data: {
                relay_session_id: stale_session_id,
                reason: normalized_reason,
              },
              triggered_by: actor,
            });
            events_emitted += 1;

            released.push(lock.task_id);
            released_tasks.push({
              task_id: lock.task_id,
              previous_status: lock.status,
              new_status: 'to_do',
            });
          }
        });

        tx();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${stale_session_id}: ${message}`);
      }
    }

    return {
      cleaned_up: released.length > 0,
      released_tasks,
      events_emitted,
      normalized_reason,
      released,
      errors,
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
