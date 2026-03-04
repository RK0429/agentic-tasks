import Database from 'better-sqlite3';

export interface EmitTaskEventInput {
  task_id: string;
  event_type: string;
  data?: Record<string, unknown> | null;
  triggered_by?: string;
  created_at?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class EventEmitter {
  private readonly db: Database.Database;

  public constructor(db: Database.Database) {
    this.db = db;
  }

  public emit_task_event(input: EmitTaskEventInput): void {
    this.db
      .prepare(
        `
        INSERT INTO task_events(task_id, event_type, data, triggered_by, created_at)
        VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.task_id,
        input.event_type,
        input.data ? JSON.stringify(input.data) : null,
        input.triggered_by ?? 'system',
        input.created_at ?? nowIso(),
      );
  }
}
