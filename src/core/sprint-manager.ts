import Database from 'better-sqlite3';

import { EventEmitter } from './event-emitter.js';
import { TasksError } from './errors.js';
import { IdGenerator } from './id-generator.js';
import type {
  CreateSprintInput,
  ListSprintsInput,
  Sprint,
  SprintStatus,
  TaskStatus,
  UpdateSprintInput,
} from '../types/index.js';

interface SprintRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  phase_number: number;
  start_date: string;
  end_date: string;
  status: SprintStatus;
  created_at: string;
}

interface SprintTaskRow {
  id: string;
  status: TaskStatus;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizePhaseNumber(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 0 || value > 7) {
    throw new TasksError('invalid_phase_number', 'phase_number must be an integer between 0 and 7', {
      value,
    });
  }

  return value;
}

function validateDateRange(start_date: string, end_date: string): void {
  if (!isValidDateString(start_date)) {
    throw new TasksError('invalid_start_date', 'start_date must be YYYY-MM-DD', { start_date });
  }
  if (!isValidDateString(end_date)) {
    throw new TasksError('invalid_end_date', 'end_date must be YYYY-MM-DD', { end_date });
  }
  if (start_date > end_date) {
    throw new TasksError('invalid_date_range', 'start_date must be <= end_date', {
      start_date,
      end_date,
    });
  }
}

export class SprintManager {
  private readonly db: Database.Database;
  private readonly idGenerator: IdGenerator;
  private readonly eventEmitter: EventEmitter;

  public constructor(db: Database.Database, idGenerator: IdGenerator, eventEmitter: EventEmitter) {
    this.db = db;
    this.idGenerator = idGenerator;
    this.eventEmitter = eventEmitter;
  }

  public createSprint(input: CreateSprintInput): Sprint {
    if (!input.name || input.name.trim() === '') {
      throw new TasksError('invalid_sprint_name', 'sprint name is required');
    }

    this.ensureProjectExists(input.project_id);

    const phase_number = normalizePhaseNumber(input.phase_number) ?? 0;
    const status = input.status ?? 'planned';
    validateDateRange(input.start_date, input.end_date);

    if (status === 'active') {
      this.ensureNoOtherActiveSprint(input.project_id, null);
    }

    const id = this.idGenerator.generate('SPRINT');
    const created_at = nowIso();

    this.db
      .prepare(
        `
        INSERT INTO sprints(
          id, project_id, name, description, phase_number, start_date, end_date, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.project_id,
        input.name,
        input.description ?? '',
        phase_number,
        input.start_date,
        input.end_date,
        status,
        created_at,
      );

    const sprint = this.getSprint(id);
    if (!sprint) {
      throw new TasksError('sprint_not_found', `sprint not found after create: ${id}`);
    }

    return sprint;
  }

  public getSprint(sprint_id: string): Sprint | null {
    const row = this.db
      .prepare(
        `
        SELECT id, project_id, name, description, phase_number, start_date, end_date, status, created_at
        FROM sprints
        WHERE id = ?
        LIMIT 1
        `,
      )
      .get(sprint_id) as SprintRow | undefined;

    return row ?? null;
  }

  public updateSprint(sprint_id: string, input: UpdateSprintInput): Sprint {
    const current = this.getSprint(sprint_id);
    if (!current) {
      throw new TasksError('sprint_not_found', `sprint not found: ${sprint_id}`);
    }

    const phase_number = normalizePhaseNumber(input.phase_number);
    const next_status = input.status ?? current.status;

    const next_start = input.start_date ?? current.start_date;
    const next_end = input.end_date ?? current.end_date;
    validateDateRange(next_start, next_end);

    if (next_status === 'active') {
      this.ensureNoOtherActiveSprint(current.project_id, current.id);
    }

    this.db
      .prepare(
        `
        UPDATE sprints
        SET name = ?,
            description = ?,
            phase_number = ?,
            start_date = ?,
            end_date = ?,
            status = ?
        WHERE id = ?
        `,
      )
      .run(
        input.name ?? current.name,
        input.description ?? current.description,
        phase_number ?? current.phase_number,
        next_start,
        next_end,
        next_status,
        sprint_id,
      );

    const updated = this.getSprint(sprint_id);
    if (!updated) {
      throw new TasksError('sprint_not_found', `sprint not found after update: ${sprint_id}`);
    }

    return updated;
  }

  public listSprints(input: ListSprintsInput = {}): Sprint[] {
    const where: string[] = [];
    const values: string[] = [];

    if (input.project_id) {
      where.push('project_id = ?');
      values.push(input.project_id);
    }
    if (input.status) {
      where.push('status = ?');
      values.push(input.status);
    }

    const sql = [
      'SELECT id, project_id, name, description, phase_number, start_date, end_date, status, created_at FROM sprints',
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      'ORDER BY start_date ASC, created_at ASC',
    ]
      .filter(Boolean)
      .join(' ');

    return this.db.prepare(sql).all(...values) as SprintRow[];
  }

  public completeSprint(sprint_id: string, agent_id = 'system'): {
    sprint: Sprint;
    moved_tasks: string[];
  } {
    const sprint = this.getSprint(sprint_id);
    if (!sprint) {
      throw new TasksError('sprint_not_found', `sprint not found: ${sprint_id}`);
    }

    const openTasks = this.db
      .prepare(
        `
        SELECT id, status
        FROM tasks
        WHERE sprint_id = ?
          AND status NOT IN ('done', 'archived')
        ORDER BY created_at ASC
        `,
      )
      .all(sprint_id) as SprintTaskRow[];

    const tx = this.db.transaction(() => {
      for (const task of openTasks) {
        const nextStatus: TaskStatus =
          task.status === 'in_progress' || task.status === 'review' ? 'to_do' : task.status;

        this.db.prepare('DELETE FROM task_locks WHERE task_id = ?').run(task.id);

        this.db
          .prepare(
            `
            UPDATE tasks
            SET sprint_id = NULL,
                status = ?,
                assignee = CASE
                  WHEN ? IN ('in_progress', 'review') THEN NULL
                  ELSE assignee
                END,
                updated_at = ?,
                version = version + 1
            WHERE id = ?
            `,
          )
          .run(nextStatus, task.status, nowIso(), task.id);

        this.eventEmitter.emit_task_event({
          task_id: task.id,
          event_type: 'task_updated',
          data: {
            sprint_id: null,
            reason: 'sprint_completed',
          },
          triggered_by: agent_id,
        });

        if (nextStatus !== task.status) {
          this.eventEmitter.emit_task_event({
            task_id: task.id,
            event_type: 'status_changed',
            data: {
              from: task.status,
              to: nextStatus,
              reason: 'sprint_completed',
            },
            triggered_by: agent_id,
          });
        }
      }

      this.db.prepare('UPDATE sprints SET status = ? WHERE id = ?').run('completed', sprint_id);
    });

    tx();

    const updated = this.getSprint(sprint_id);
    if (!updated) {
      throw new TasksError('sprint_not_found', `sprint not found after complete: ${sprint_id}`);
    }

    return {
      sprint: updated,
      moved_tasks: openTasks.map((task) => task.id),
    };
  }

  private ensureProjectExists(project_id: string): void {
    const exists = this.db
      .prepare('SELECT id FROM projects WHERE id = ? LIMIT 1')
      .get(project_id) as { id: string } | undefined;

    if (!exists) {
      throw new TasksError('project_not_found', `project not found: ${project_id}`);
    }
  }

  private ensureNoOtherActiveSprint(project_id: string, exclude_sprint_id: string | null): void {
    const row = this.db
      .prepare(
        `
        SELECT id
        FROM sprints
        WHERE project_id = ?
          AND status = 'active'
          AND (? IS NULL OR id != ?)
        LIMIT 1
        `,
      )
      .get(project_id, exclude_sprint_id, exclude_sprint_id) as { id: string } | undefined;

    if (row) {
      throw new TasksError(
        'active_sprint_exists',
        'project already has an active sprint',
        {
          project_id,
          active_sprint_id: row.id,
        },
      );
    }
  }
}
