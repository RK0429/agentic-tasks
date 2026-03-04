import Database from 'better-sqlite3';

import { EventEmitter } from './event-emitter.js';
import { TasksError } from './errors.js';
import type { DependencyType, TaskStatus } from '../types/index.js';

function nowIso(): string {
  return new Date().toISOString();
}

interface TaskEdgeNode {
  id: string;
  parent_task_id: string | null;
  goal_id: string | null;
  status: TaskStatus;
}

export interface AddDependencyInput {
  task_id: string;
  depends_on: string;
  type?: DependencyType;
  triggered_by?: string;
}

export class DependencyResolver {
  private readonly db: Database.Database;
  private readonly eventEmitter: EventEmitter;

  public constructor(db: Database.Database, eventEmitter: EventEmitter) {
    this.db = db;
    this.eventEmitter = eventEmitter;
  }

  public add_dependency(input: AddDependencyInput): void {
    if (input.task_id === input.depends_on) {
      throw new TasksError('self_dependency_not_allowed', 'task cannot depend on itself');
    }

    const tx = this.db.transaction(() => {
      const task = this.getTaskNode(input.task_id);
      const dependency = this.getTaskNode(input.depends_on);

      if (task.goal_id !== dependency.goal_id) {
        throw new TasksError('dependency_goal_mismatch', 'dependency must be within the same goal', {
          task_id: task.id,
          depends_on: dependency.id,
        });
      }

      if (task.parent_task_id !== dependency.parent_task_id) {
        throw new TasksError(
          'dependency_not_sibling',
          'dependency must be between sibling tasks with the same parent',
          {
            task_id: task.id,
            depends_on: dependency.id,
          },
        );
      }

      this.db
        .prepare(
          `
          INSERT OR IGNORE INTO task_dependencies(task_id, depends_on, type, created_at)
          VALUES (?, ?, ?, ?)
          `,
        )
        .run(input.task_id, input.depends_on, input.type ?? 'finish_to_start', nowIso());

      if (this.has_cycle()) {
        this.db
          .prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on = ?')
          .run(input.task_id, input.depends_on);

        throw new TasksError('cyclic_dependency', 'cyclic dependency detected', {
          task_id: input.task_id,
          depends_on: input.depends_on,
        });
      }

      this.eventEmitter.emit_task_event({
        task_id: input.task_id,
        event_type: 'dependency_added',
        data: {
          depends_on: input.depends_on,
          type: input.type ?? 'finish_to_start',
        },
        triggered_by: input.triggered_by,
      });

      if (!this.are_dependencies_resolved(input.task_id)) {
        const target = this.db
          .prepare('SELECT status FROM tasks WHERE id = ?')
          .get(input.task_id) as { status: TaskStatus };

        if (target.status === 'to_do') {
          this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(
            'blocked',
            nowIso(),
            input.task_id,
          );

          this.eventEmitter.emit_task_event({
            task_id: input.task_id,
            event_type: 'blocked',
            data: {
              reason: 'dependency_added',
            },
            triggered_by: input.triggered_by,
          });
        }
      }
    });

    tx();
  }

  public remove_dependency(task_id: string, depends_on: string, triggered_by = 'system'): void {
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on = ?')
        .run(task_id, depends_on);

      if (info.changes === 0) {
        return;
      }

      this.eventEmitter.emit_task_event({
        task_id,
        event_type: 'dependency_removed',
        data: { depends_on },
        triggered_by,
      });

      const task = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(task_id) as
        | { status: TaskStatus }
        | undefined;

      if (task && task.status === 'blocked' && this.are_dependencies_resolved(task_id)) {
        this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(
          'to_do',
          nowIso(),
          task_id,
        );

        this.eventEmitter.emit_task_event({
          task_id,
          event_type: 'dependency_resolved',
          data: { depends_on },
          triggered_by,
        });

        this.eventEmitter.emit_task_event({
          task_id,
          event_type: 'unblocked',
          data: { reason: 'dependency_resolved' },
          triggered_by,
        });
      }
    });

    tx();
  }

  public list_dependencies(task_id: string): { upstream: string[]; downstream: string[] } {
    const upstreamRows = this.db
      .prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ? ORDER BY depends_on')
      .all(task_id) as Array<{ depends_on: string }>;

    const downstreamRows = this.db
      .prepare('SELECT task_id FROM task_dependencies WHERE depends_on = ? ORDER BY task_id')
      .all(task_id) as Array<{ task_id: string }>;

    return {
      upstream: upstreamRows.map((row) => row.depends_on),
      downstream: downstreamRows.map((row) => row.task_id),
    };
  }

  public are_dependencies_resolved(task_id: string): boolean {
    const unresolved = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM task_dependencies td
        JOIN tasks t ON t.id = td.depends_on
        WHERE td.task_id = ?
          AND t.status NOT IN ('done', 'archived')
        `,
      )
      .get(task_id) as { count: number };

    return unresolved.count === 0;
  }

  public has_cycle(): boolean {
    const nodes = this.db
      .prepare('SELECT id FROM tasks WHERE task_type = ? ORDER BY id')
      .all('task') as Array<{ id: string }>;

    if (nodes.length === 0) {
      return false;
    }

    const edges = this.db
      .prepare('SELECT task_id, depends_on FROM task_dependencies')
      .all() as Array<{ task_id: string; depends_on: string }>;

    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const node of nodes) {
      inDegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }

    for (const edge of edges) {
      if (!adjacency.has(edge.depends_on) || !adjacency.has(edge.task_id)) {
        continue;
      }
      adjacency.get(edge.depends_on)?.push(edge.task_id);
      inDegree.set(edge.task_id, (inDegree.get(edge.task_id) ?? 0) + 1);
    }

    const queue = Array.from(inDegree.entries())
      .filter(([, degree]) => degree === 0)
      .map(([nodeId]) => nodeId);

    let visited = 0;
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) {
        break;
      }
      visited += 1;

      for (const next of adjacency.get(node) ?? []) {
        const degree = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, degree);
        if (degree === 0) {
          queue.push(next);
        }
      }
    }

    return visited !== inDegree.size;
  }

  public topological_sort(goal_id?: string): string[] {
    const tasks = goal_id
      ? ((this.db
          .prepare('SELECT id FROM tasks WHERE goal_id = ? OR id = ? ORDER BY id')
          .all(goal_id, goal_id) as Array<{ id: string }>) ?? [])
      : ((this.db.prepare('SELECT id FROM tasks ORDER BY id').all() as Array<{ id: string }>) ?? []);

    const taskIds = new Set(tasks.map((task) => task.id));
    const edges = this.db
      .prepare('SELECT task_id, depends_on FROM task_dependencies')
      .all() as Array<{ task_id: string; depends_on: string }>;

    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const task of tasks) {
      inDegree.set(task.id, 0);
      adjacency.set(task.id, []);
    }

    for (const edge of edges) {
      if (!taskIds.has(edge.task_id) || !taskIds.has(edge.depends_on)) {
        continue;
      }
      adjacency.get(edge.depends_on)?.push(edge.task_id);
      inDegree.set(edge.task_id, (inDegree.get(edge.task_id) ?? 0) + 1);
    }

    const queue = Array.from(inDegree.entries())
      .filter(([, degree]) => degree === 0)
      .map(([id]) => id)
      .sort();

    const sorted: string[] = [];

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) {
        break;
      }
      sorted.push(node);

      for (const next of adjacency.get(node) ?? []) {
        const degree = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, degree);
        if (degree === 0) {
          queue.push(next);
          queue.sort();
        }
      }
    }

    if (sorted.length !== tasks.length) {
      throw new TasksError('cyclic_dependency', 'topological sort failed due to cycle');
    }

    return sorted;
  }

  private getTaskNode(task_id: string): TaskEdgeNode {
    const task = this.db
      .prepare(
        'SELECT id, parent_task_id, goal_id, status FROM tasks WHERE id = ? AND task_type = ? LIMIT 1',
      )
      .get(task_id, 'task') as TaskEdgeNode | undefined;

    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${task_id}`);
    }

    return task;
  }
}
