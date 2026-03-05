import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

import { EventEmitter } from './event-emitter.js';
import { TasksError } from './errors.js';
import { IdGenerator } from './id-generator.js';
import { TaskManager } from './task-manager.js';
import type {
  CreateScheduleInput,
  CreateTaskInput,
  Schedule,
  UpdateScheduleInput,
} from '../types/index.js';

interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  task_template: string;
  project_id: string;
  enabled: number;
  max_instances: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

interface TaskMetadataRow {
  metadata: string | null;
}

const ACTIVE_SCHEDULE_TASK_STATUSES = new Set([
  'backlog',
  'to_do',
  'in_progress',
  'review',
  'blocked',
  'escalated',
]);

function nowIso(): string {
  return new Date().toISOString();
}

function parseTaskTemplate(value: string): CreateTaskInput {
  return JSON.parse(value) as CreateTaskInput;
}

export class Scheduler {
  private readonly db: Database.Database;
  private readonly idGenerator: IdGenerator;
  private readonly taskManager: TaskManager;
  private readonly eventEmitter: EventEmitter;

  public constructor(
    db: Database.Database,
    idGenerator: IdGenerator,
    taskManager: TaskManager,
    eventEmitter: EventEmitter,
  ) {
    this.db = db;
    this.idGenerator = idGenerator;
    this.taskManager = taskManager;
    this.eventEmitter = eventEmitter;
  }

  public createSchedule(input: CreateScheduleInput): Schedule {
    if (!input.name || input.name.trim() === '') {
      throw new TasksError('invalid_schedule_name', 'schedule name is required');
    }

    this.ensureProjectExists(input.project_id);
    this.validateCron(input.cron);

    if (input.max_instances !== undefined) {
      this.validateMaxInstances(input.max_instances);
    }

    const id = this.idGenerator.generate('SCHED');
    const created_at = nowIso();

    const next_run_at =
      input.next_run_at ?? this.getNextRunTime(input.cron, new Date(created_at)).toISOString();

    this.db
      .prepare(
        `
        INSERT INTO schedules(
          id, name, cron, task_template, project_id, enabled, max_instances, last_run_at, next_run_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.name,
        input.cron,
        JSON.stringify(input.task_template),
        input.project_id,
        input.enabled === false ? 0 : 1,
        input.max_instances ?? 1,
        null,
        next_run_at,
        created_at,
      );

    const schedule = this.getSchedule(id);
    if (!schedule) {
      throw new TasksError('schedule_not_found', `schedule not found after create: ${id}`);
    }

    return schedule;
  }

  public getSchedule(schedule_id: string): Schedule | null {
    const row = this.db
      .prepare(
        `
        SELECT id, name, cron, task_template, project_id, enabled, max_instances, last_run_at, next_run_at, created_at
        FROM schedules
        WHERE id = ?
        LIMIT 1
        `,
      )
      .get(schedule_id) as ScheduleRow | undefined;

    return row ? this.toSchedule(row) : null;
  }

  public updateSchedule(schedule_id: string, input: UpdateScheduleInput): Schedule {
    const current = this.getSchedule(schedule_id);
    if (!current) {
      throw new TasksError('schedule_not_found', `schedule not found: ${schedule_id}`);
    }

    if (input.project_id) {
      this.ensureProjectExists(input.project_id);
    }

    if (input.cron) {
      this.validateCron(input.cron);
    }

    if (input.max_instances !== undefined) {
      this.validateMaxInstances(input.max_instances);
    }

    const next_cron = input.cron ?? current.cron;
    const next_run_at = Object.prototype.hasOwnProperty.call(input, 'next_run_at')
      ? input.next_run_at ?? null
      : input.cron
        ? this.getNextRunTime(next_cron).toISOString()
        : current.next_run_at;

    this.db
      .prepare(
        `
        UPDATE schedules
        SET name = ?,
            cron = ?,
            task_template = ?,
            project_id = ?,
            enabled = ?,
            max_instances = ?,
            last_run_at = ?,
            next_run_at = ?
        WHERE id = ?
        `,
      )
      .run(
        input.name ?? current.name,
        next_cron,
        JSON.stringify(input.task_template ?? current.task_template),
        input.project_id ?? current.project_id,
        input.enabled === undefined ? (current.enabled ? 1 : 0) : input.enabled ? 1 : 0,
        input.max_instances ?? current.max_instances,
        Object.prototype.hasOwnProperty.call(input, 'last_run_at')
          ? input.last_run_at ?? null
          : current.last_run_at,
        next_run_at,
        schedule_id,
      );

    const updated = this.getSchedule(schedule_id);
    if (!updated) {
      throw new TasksError('schedule_not_found', `schedule not found after update: ${schedule_id}`);
    }

    return updated;
  }

  public deleteSchedule(schedule_id: string): void {
    const schedule = this.getSchedule(schedule_id);
    if (!schedule) {
      throw new TasksError('schedule_not_found', `schedule not found: ${schedule_id}`);
    }

    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(schedule_id);
  }

  public listSchedules(project_id?: string): Schedule[] {
    if (project_id) {
      this.ensureProjectExists(project_id);
    }

    const sql = project_id
      ? `
        SELECT id, name, cron, task_template, project_id, enabled, max_instances, last_run_at, next_run_at, created_at
        FROM schedules
        WHERE project_id = ?
        ORDER BY created_at ASC
      `
      : `
        SELECT id, name, cron, task_template, project_id, enabled, max_instances, last_run_at, next_run_at, created_at
        FROM schedules
        ORDER BY created_at ASC
      `;

    const rows = project_id
      ? (this.db.prepare(sql).all(project_id) as ScheduleRow[])
      : (this.db.prepare(sql).all() as ScheduleRow[]);

    return rows.map((row) => this.toSchedule(row));
  }

  public checkAndRun(): { created_tasks: string[] } {
    const due = this.db
      .prepare(
        `
        SELECT id, name, cron, task_template, project_id, enabled, max_instances, last_run_at, next_run_at, created_at
        FROM schedules
        WHERE enabled = 1
          AND next_run_at IS NOT NULL
          AND datetime(next_run_at) <= datetime(?)
        ORDER BY next_run_at ASC
        `,
      )
      .all(nowIso()) as ScheduleRow[];

    const created_tasks: string[] = [];

    for (const row of due) {
      const schedule = this.toSchedule(row);
      const run_at = nowIso();
      const next_run_at = this.getNextRunTime(schedule.cron, new Date(run_at)).toISOString();

      if (!this.canCreateAnotherInstance(schedule)) {
        this.db
          .prepare(
            `
            UPDATE schedules
            SET last_run_at = ?,
                next_run_at = ?
            WHERE id = ?
            `,
          )
          .run(run_at, next_run_at, schedule.id);
        continue;
      }

      const template = schedule.task_template;
      const metadata = {
        ...(template.metadata ?? {}),
        schedule_id: schedule.id,
        schedule_name: schedule.name,
        scheduled_at: run_at,
      };

      const task = this.taskManager.createTask(
        {
          ...template,
          project_id: template.project_id ?? schedule.project_id,
          metadata,
        },
        'system',
      );

      created_tasks.push(task.id);

      this.eventEmitter.emit_task_event({
        task_id: task.id,
        event_type: 'schedule_triggered',
        data: {
          schedule_id: schedule.id,
          schedule_name: schedule.name,
          run_at,
        },
        triggered_by: 'system',
      });

      this.db
        .prepare(
          `
          UPDATE schedules
          SET last_run_at = ?,
              next_run_at = ?
          WHERE id = ?
          `,
        )
        .run(run_at, next_run_at, schedule.id);
    }

    return { created_tasks };
  }

  public getNextRunTime(cron: string, currentDate = new Date()): Date {
    try {
      const expression = CronExpressionParser.parse(cron, { currentDate });
      return expression.next().toDate();
    } catch (error) {
      throw new TasksError('invalid_cron_expression', 'invalid cron expression', {
        cron,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private toSchedule(row: ScheduleRow): Schedule {
    return {
      ...row,
      task_template: parseTaskTemplate(row.task_template),
      enabled: row.enabled === 1,
    };
  }

  private validateCron(cron: string): void {
    this.getNextRunTime(cron);
  }

  private validateMaxInstances(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
      throw new TasksError('invalid_max_instances', 'max_instances must be an integer >= 1', {
        value,
      });
    }
  }

  private ensureProjectExists(project_id: string): void {
    const row = this.db
      .prepare('SELECT id FROM projects WHERE id = ? LIMIT 1')
      .get(project_id) as { id: string } | undefined;

    if (!row) {
      throw new TasksError('project_not_found', `project not found: ${project_id}`);
    }
  }

  private canCreateAnotherInstance(schedule: Schedule): boolean {
    const rows = this.db
      .prepare(
        `
        SELECT metadata
        FROM tasks
        WHERE project_id = ?
          AND status IN ('backlog', 'to_do', 'in_progress', 'review', 'blocked', 'escalated')
        `,
      )
      .all(schedule.project_id) as TaskMetadataRow[];

    const activeCount = rows.reduce((count, row) => {
      if (!row.metadata) {
        return count;
      }

      try {
        const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
        const scheduleId = metadata.schedule_id;
        if (typeof scheduleId === 'string' && scheduleId === schedule.id) {
          return count + 1;
        }
      } catch {
        return count;
      }

      return count;
    }, 0);

    if (!ACTIVE_SCHEDULE_TASK_STATUSES.size) {
      return true;
    }

    return activeCount < schedule.max_instances;
  }
}
