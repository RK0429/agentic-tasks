export class TasksError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  public constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TasksError';
    this.code = code;
    this.details = details;
  }
}

export function isTasksError(value: unknown): value is TasksError {
  return value instanceof TasksError;
}
