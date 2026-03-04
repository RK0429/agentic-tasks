import Database from 'better-sqlite3';

import { TasksError } from './errors.js';

type TaskAction =
  | 'claim_and_start'
  | 'complete_task'
  | 'escalate_task'
  | 'update_task'
  | 'delete_task'
  | 'assign_task'
  | 'release_task'
  | 'decompose_task'
  | 'delegate_task';

interface TaskOwnershipRow {
  id: string;
  assignee: string | null;
  created_by: string | null;
  parent_task_id: string | null;
}

function isSystemActor(agent_id: string | null | undefined): boolean {
  return !agent_id || agent_id === 'system';
}

export class AccessControl {
  private readonly db: Database.Database;

  public constructor(db: Database.Database) {
    this.db = db;
  }

  public ensure_task_action(action: TaskAction, task_id: string, agent_id: string): void {
    if (isSystemActor(agent_id)) {
      return;
    }

    if (action === 'claim_and_start' || action === 'assign_task') {
      return;
    }

    const task = this.get_task(task_id);

    switch (action) {
      case 'complete_task':
      case 'escalate_task':
      case 'release_task':
      case 'decompose_task': {
        if (task.assignee !== agent_id) {
          throw new TasksError('access_denied', 'only assignee can perform this action', {
            action,
            task_id,
            agent_id,
            assignee: task.assignee,
          });
        }
        return;
      }
      case 'update_task': {
        if (task.assignee !== agent_id && task.created_by !== agent_id) {
          throw new TasksError('access_denied', 'only assignee or creator can update task', {
            action,
            task_id,
            agent_id,
            assignee: task.assignee,
            created_by: task.created_by,
          });
        }
        return;
      }
      case 'delete_task': {
        if (task.created_by !== agent_id) {
          throw new TasksError('access_denied', 'only creator can delete task', {
            action,
            task_id,
            agent_id,
            created_by: task.created_by,
          });
        }
        return;
      }
      case 'delegate_task': {
        const parent = task.parent_task_id ? this.get_task(task.parent_task_id) : null;
        if (task.created_by !== agent_id && parent?.assignee !== agent_id) {
          throw new TasksError(
            'access_denied',
            'only parent assignee or task creator can delegate task',
            {
              action,
              task_id,
              agent_id,
              parent_task_id: task.parent_task_id,
              parent_assignee: parent?.assignee ?? null,
              created_by: task.created_by,
            },
          );
        }
        return;
      }
    }
  }

  public ensure_parent_assignee(task_id: string, agent_id: string): void {
    if (isSystemActor(agent_id)) {
      return;
    }

    const task = this.get_task(task_id);
    if (!task.parent_task_id) {
      throw new TasksError('access_denied', 'parent task is required for escalation resolution', {
        task_id,
        agent_id,
      });
    }

    const parent = this.get_task(task.parent_task_id);
    if (parent.assignee !== agent_id) {
      throw new TasksError(
        'access_denied',
        'only parent task assignee can resolve escalated task',
        {
          task_id,
          parent_task_id: parent.id,
          agent_id,
          parent_assignee: parent.assignee,
        },
      );
    }
  }

  public is_assignee(task_id: string, agent_id: string): boolean {
    if (isSystemActor(agent_id)) {
      return true;
    }

    const task = this.get_task(task_id);
    return task.assignee === agent_id;
  }

  private get_task(task_id: string): TaskOwnershipRow {
    const row = this.db
      .prepare(
        `
        SELECT id, assignee, created_by, parent_task_id
        FROM tasks
        WHERE id = ?
        LIMIT 1
        `,
      )
      .get(task_id) as TaskOwnershipRow | undefined;

    if (!row) {
      throw new TasksError('task_not_found', `task not found: ${task_id}`);
    }

    return row;
  }
}

