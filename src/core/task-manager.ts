import Database from 'better-sqlite3';

import { AccessControl } from './access-control.js';
import { EventEmitter } from './event-emitter.js';
import { TasksError } from './errors.js';
import { IdGenerator } from './id-generator.js';
import type { DependencyResolver } from './dependency-resolver.js';
import type { QualityGateManager } from './quality-gate-manager.js';
import type {
  AcceptanceCriterion,
  CreateTaskInput,
  ExpectedEffort,
  ListTasksInput,
  Task,
  TaskStatus,
  TaskType,
  UpdateTaskInput,
} from '../types/index.js';

const EFFORT_TO_MS: Record<ExpectedEffort, number> = {
  XS: 1_800_000,
  S: 3_600_000,
  M: 7_200_000,
  L: 14_400_000,
  XL: 28_800_000,
};

const STATUS_COMPLETION_WEIGHT: Record<TaskStatus, number> = {
  backlog: 0,
  to_do: 0,
  in_progress: 0.5,
  review: 0.9,
  done: 1,
  blocked: 0,
  escalated: 0.3,
  archived: 1,
};

const WIP_STATUSES: ReadonlyArray<TaskStatus> = ['in_progress', 'review'];

interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Task['priority'];
  task_type: TaskType;
  parent_task_id: string | null;
  goal_id: string | null;
  depth: number;
  phase: Task['phase'];
  source_ref: string | null;
  expected_effort: Task['expected_effort'];
  actual_effort_ms: number | null;
  wbs_version: number;
  gate_status: Task['gate_status'];
  project_id: string;
  sprint_id: string | null;
  assignee: string | null;
  acceptance_criteria: string | null;
  metadata: string | null;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskManagerDependencies {
  access_control?: AccessControl;
  id_generator?: IdGenerator;
  event_emitter?: EventEmitter;
  quality_gate_manager?: QualityGateManager;
  dependency_resolver?: DependencyResolver;
}

interface GoalProgressRow {
  id: string;
  status: TaskStatus;
  expected_effort: ExpectedEffort | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeAcceptanceCriteria(
  criteria: CreateTaskInput['acceptance_criteria'] | UpdateTaskInput['acceptance_criteria'],
): AcceptanceCriterion[] {
  return criteria ?? [];
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  return JSON.parse(value) as Record<string, unknown>;
}

function isSystemActor(agent_id: string | null | undefined): boolean {
  return !agent_id || agent_id === 'system';
}

function roundsToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

export class TaskManager {
  private readonly db: Database.Database;
  private readonly accessControl: AccessControl;
  private readonly idGenerator: IdGenerator;
  private readonly eventEmitter: EventEmitter;

  public constructor(db: Database.Database, deps: TaskManagerDependencies = {}) {
    this.db = db;

    this.accessControl = deps.access_control ?? new AccessControl(db);
    this.eventEmitter = deps.event_emitter ?? new EventEmitter(db);
    this.idGenerator = deps.id_generator ?? new IdGenerator(db);
  }

  public createTask(input: CreateTaskInput, triggered_by = 'system'): Task {
    if (!input.title || input.title.trim() === '') {
      throw new TasksError('invalid_title', 'title is required');
    }

    const task_type = input.task_type ?? 'task';
    const defaultStatus: TaskStatus = task_type === 'goal' ? 'to_do' : 'backlog';
    const status = input.status ?? defaultStatus;

    if (task_type === 'goal' && status !== 'to_do') {
      throw new TasksError('invalid_status_for_goal', 'goal must start with to_do');
    }

    if (task_type === 'task' && status !== 'backlog') {
      throw new TasksError('invalid_status_for_task', 'task must start with backlog');
    }

    const hierarchy = this.resolveHierarchy(
      task_type,
      input.parent_task_id ?? null,
      input.goal_id ?? null,
      input.project_id ?? null,
    );

    const id = this.idGenerator.generate(task_type === 'goal' ? 'GOAL' : 'TASK');
    const now = nowIso();
    const acceptanceCriteria = normalizeAcceptanceCriteria(input.acceptance_criteria);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO tasks(
            id, title, description, status, priority, task_type,
            parent_task_id, goal_id, depth, phase, source_ref,
            expected_effort, actual_effort_ms, wbs_version, gate_status,
            project_id, sprint_id, assignee, acceptance_criteria, metadata,
            version, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          id,
          input.title,
          input.description ?? '',
          status,
          input.priority ?? 'medium',
          task_type,
          hierarchy.parent_task_id,
          hierarchy.goal_id,
          hierarchy.depth,
          input.phase ?? null,
          input.source_ref ?? null,
          input.expected_effort ?? null,
          null,
          1,
          'none',
          hierarchy.project_id,
          input.sprint_id ?? null,
          input.assignee ?? null,
          JSON.stringify(acceptanceCriteria),
          JSON.stringify(input.metadata ?? null),
          1,
          input.created_by ?? null,
          now,
          now,
        );

      this.eventEmitter.emit_task_event({
        task_id: id,
        event_type: 'task_created',
        data: {
          task_type,
          parent_task_id: hierarchy.parent_task_id,
          goal_id: hierarchy.goal_id,
        },
        triggered_by,
      });
    });

    tx();

    const created = this.getTask(id);
    if (!created) {
      throw new TasksError('task_not_found', `task not found after create: ${id}`);
    }

    return created;
  }

  public getTask(task_id: string): Task | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE id = ? LIMIT 1')
      .get(task_id) as TaskRow | undefined;

    return row ? this.toTask(row) : null;
  }

  public listTasks(filters: ListTasksInput = {}): Task[] {
    const where: string[] = [];
    const values: Array<string | number> = [];

    if (filters.status) {
      where.push('status = ?');
      values.push(filters.status);
    }
    if (filters.project_id) {
      where.push('project_id = ?');
      values.push(filters.project_id);
    }
    if (filters.goal_id) {
      where.push('goal_id = ?');
      values.push(filters.goal_id);
    }
    if (filters.depth !== undefined) {
      where.push('depth <= ?');
      values.push(filters.depth);
    }
    if (filters.parent_task_id) {
      where.push('parent_task_id = ?');
      values.push(filters.parent_task_id);
    }
    if (filters.task_type) {
      where.push('task_type = ?');
      values.push(filters.task_type);
    }
    if (filters.assignee) {
      where.push('assignee = ?');
      values.push(filters.assignee);
    }

    const sql = [
      'SELECT * FROM tasks',
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      'ORDER BY created_at DESC',
      'LIMIT ?',
      'OFFSET ?',
    ]
      .filter(Boolean)
      .join(' ');

    values.push(filters.limit ?? 100, filters.offset ?? 0);

    const rows = this.db.prepare(sql).all(...values) as TaskRow[];
    return rows.map((row) => this.toTask(row));
  }

  public assignTask(
    task_id: string,
    assignee: string | null,
    triggered_by = 'system',
    agent_id = triggered_by,
  ): Task {
    const current = this.getTask(task_id);
    if (!current) {
      throw new TasksError('task_not_found', `task not found: ${task_id}`);
    }

    this.accessControl.ensure_task_action('assign_task', task_id, agent_id);

    if (assignee && current.task_type === 'task') {
      const exclude_task_id = WIP_STATUSES.includes(current.status) ? current.id : undefined;
      this.ensureProjectWipLimit(current.project_id, task_id, triggered_by, exclude_task_id);
    }

    this.db
      .prepare(
        `
        UPDATE tasks
        SET assignee = ?,
            updated_at = ?,
            version = version + 1
        WHERE id = ?
        `,
      )
      .run(assignee, nowIso(), task_id);

    this.eventEmitter.emit_task_event({
      task_id,
      event_type: 'task_assigned',
      data: {
        assignee,
      },
      triggered_by,
    });

    const updated = this.getTask(task_id);
    if (!updated) {
      throw new TasksError('task_not_found', `task not found after assign: ${task_id}`);
    }

    return updated;
  }

  public updateTask(
    task_id: string,
    input: UpdateTaskInput,
    triggered_by = 'system',
    agent_id = triggered_by,
  ): Task {
    const current = this.getTask(task_id);
    if (!current) {
      throw new TasksError('task_not_found', `task not found: ${task_id}`);
    }

    if (!isSystemActor(agent_id)) {
      this.accessControl.ensure_task_action('update_task', task_id, agent_id);
    }

    if (
      Object.prototype.hasOwnProperty.call(input, 'parent_task_id') &&
      input.parent_task_id !== current.parent_task_id
    ) {
      throw new TasksError(
        'reparent_not_allowed',
        'Reparent is not supported; archive and recreate under new parent',
        {
          hint: 'archive + re-create under the new parent',
        },
      );
    }

    const acceptanceCriteria = Object.prototype.hasOwnProperty.call(input, 'acceptance_criteria')
      ? normalizeAcceptanceCriteria(input.acceptance_criteria)
      : current.acceptance_criteria;

    const now = nowIso();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE tasks
          SET title = ?,
              description = ?,
              priority = ?,
              sprint_id = ?,
              assignee = ?,
              acceptance_criteria = ?,
              metadata = ?,
              phase = ?,
              source_ref = ?,
              expected_effort = ?,
              actual_effort_ms = ?,
              version = version + 1,
              updated_at = ?
          WHERE id = ?
          `,
        )
        .run(
          input.title ?? current.title,
          input.description ?? current.description,
          input.priority ?? current.priority,
          Object.prototype.hasOwnProperty.call(input, 'sprint_id')
            ? input.sprint_id ?? null
            : current.sprint_id,
          Object.prototype.hasOwnProperty.call(input, 'assignee')
            ? input.assignee ?? null
            : current.assignee,
          JSON.stringify(acceptanceCriteria),
          JSON.stringify(
            Object.prototype.hasOwnProperty.call(input, 'metadata')
              ? input.metadata ?? null
              : current.metadata,
          ),
          Object.prototype.hasOwnProperty.call(input, 'phase') ? input.phase ?? null : current.phase,
          Object.prototype.hasOwnProperty.call(input, 'source_ref')
            ? input.source_ref ?? null
            : current.source_ref,
          Object.prototype.hasOwnProperty.call(input, 'expected_effort')
            ? input.expected_effort ?? null
            : current.expected_effort,
          Object.prototype.hasOwnProperty.call(input, 'actual_effort_ms')
            ? input.actual_effort_ms ?? null
            : current.actual_effort_ms,
          now,
          task_id,
        );

      this.eventEmitter.emit_task_event({
        task_id,
        event_type: 'task_updated',
        data: {
          updated_fields: Object.keys(input),
        },
        triggered_by,
      });
    });

    tx();

    const updated = this.getTask(task_id);
    if (!updated) {
      throw new TasksError('task_not_found', `task not found after update: ${task_id}`);
    }

    return updated;
  }

  public deleteTask(task_id: string, triggered_by = 'system', agent_id = triggered_by): void {
    const task = this.getTask(task_id);
    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${task_id}`);
    }

    if (!isSystemActor(agent_id)) {
      this.accessControl.ensure_task_action('delete_task', task_id, agent_id);
    }

    const lock = this.db.prepare('SELECT task_id FROM task_locks WHERE task_id = ?').get(task_id) as
      | { task_id: string }
      | undefined;

    if (lock) {
      throw new TasksError('task_locked', 'locked task cannot be deleted', { task_id });
    }

    const children = this.db
      .prepare('SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ?')
      .get(task_id) as { count: number };

    if (children.count > 0) {
      throw new TasksError('task_has_children', 'task has child tasks and cannot be deleted', {
        task_id,
        child_count: children.count,
      });
    }

    const dependents = this.db
      .prepare('SELECT COUNT(*) AS count FROM task_dependencies WHERE depends_on = ?')
      .get(task_id) as { count: number };

    if (dependents.count > 0) {
      throw new TasksError('task_has_dependents', 'task is referenced by dependency edges', {
        task_id,
        dependents: dependents.count,
      });
    }

    const tx = this.db.transaction(() => {
      this.eventEmitter.emit_task_event({
        task_id,
        event_type: 'task_deleted',
        data: {
          title: task.title,
        },
        triggered_by,
      });
      this.db
        .prepare('DELETE FROM task_dependencies WHERE task_id = ? OR depends_on = ?')
        .run(task_id, task_id);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(task_id);
    });

    tx();
  }

  public getProjectWip(project_id: string): { wip_count: number; wip_limit: number } {
    const project = this.db
      .prepare('SELECT id, wip_limit FROM projects WHERE id = ? LIMIT 1')
      .get(project_id) as { id: string; wip_limit: number } | undefined;

    if (!project) {
      throw new TasksError('project_not_found', `project not found: ${project_id}`);
    }

    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM tasks
        WHERE project_id = ?
          AND task_type = 'task'
          AND status IN ('in_progress', 'review')
        `,
      )
      .get(project_id) as { count: number };

    return {
      wip_count: row.count,
      wip_limit: project.wip_limit,
    };
  }

  public getGoalProgressPercent(goal_id: string): number {
    const goal = this.getTask(goal_id);
    if (!goal || goal.task_type !== 'goal') {
      throw new TasksError('goal_not_found', `goal not found: ${goal_id}`);
    }

    return roundsToTwoDecimals(this.computeNodeCompletion(goal_id) * 100);
  }

  private resolveHierarchy(
    task_type: TaskType,
    parent_task_id: string | null,
    requested_goal_id: string | null,
    project_id: string | null,
  ): {
    parent_task_id: string | null;
    goal_id: string | null;
    depth: number;
    project_id: string;
  } {
    if (task_type === 'goal') {
      if (parent_task_id !== null) {
        throw new TasksError('invalid_parent', 'goal must not have parent_task_id');
      }
      if (requested_goal_id !== null) {
        throw new TasksError('invalid_goal', 'goal must not have goal_id');
      }

      const resolvedProject = this.resolveProjectId(project_id);
      return {
        parent_task_id: null,
        goal_id: null,
        depth: 0,
        project_id: resolvedProject,
      };
    }

    if (!parent_task_id) {
      if (requested_goal_id) {
        parent_task_id = requested_goal_id;
      } else {
        throw new TasksError('parent_required', 'task requires parent_task_id');
      }
    }

    const parent = this.db
      .prepare('SELECT id, task_type, goal_id, depth, project_id FROM tasks WHERE id = ? LIMIT 1')
      .get(parent_task_id) as
      | {
          id: string;
          task_type: TaskType;
          goal_id: string | null;
          depth: number;
          project_id: string;
        }
      | undefined;

    if (!parent) {
      throw new TasksError('parent_not_found', `parent task not found: ${parent_task_id}`);
    }

    const resolvedProject = project_id ?? parent.project_id;
    if (resolvedProject !== parent.project_id) {
      throw new TasksError('project_mismatch', 'task project_id must match parent project_id', {
        parent_project_id: parent.project_id,
        provided_project_id: resolvedProject,
      });
    }

    const goal_id = parent.task_type === 'goal' ? parent.id : parent.goal_id;
    if (!goal_id) {
      throw new TasksError('goal_not_found', 'unable to resolve goal_id from parent chain');
    }
    if (requested_goal_id !== null && requested_goal_id !== goal_id) {
      throw new TasksError('goal_mismatch', 'goal_id must match parent chain', {
        provided_goal_id: requested_goal_id,
        resolved_goal_id: goal_id,
      });
    }

    return {
      parent_task_id,
      goal_id,
      depth: parent.depth + 1,
      project_id: resolvedProject,
    };
  }

  private resolveProjectId(project_id: string | null): string {
    if (project_id) {
      const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id) as
        | { id: string }
        | undefined;

      if (!project) {
        throw new TasksError('project_not_found', `project not found: ${project_id}`);
      }

      return project_id;
    }

    const defaultProject = this.db
      .prepare('SELECT id FROM projects ORDER BY created_at ASC LIMIT 1')
      .get() as { id: string } | undefined;

    if (!defaultProject) {
      throw new TasksError('project_not_found', 'no project found; run tasks init first');
    }

    return defaultProject.id;
  }

  private ensureProjectWipLimit(
    project_id: string,
    task_id: string,
    triggered_by: string,
    exclude_task_id?: string,
  ): void {
    const project = this.db
      .prepare('SELECT id, wip_limit FROM projects WHERE id = ? LIMIT 1')
      .get(project_id) as { id: string; wip_limit: number } | undefined;

    if (!project) {
      throw new TasksError('project_not_found', `project not found: ${project_id}`);
    }

    let countSql = `
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE project_id = ?
        AND task_type = 'task'
        AND status IN ('in_progress', 'review')
    `;

    const values: Array<string> = [project_id];
    if (exclude_task_id) {
      countSql += ' AND id != ?';
      values.push(exclude_task_id);
    }

    const wip = this.db.prepare(countSql).get(...values) as { count: number };

    if (wip.count >= project.wip_limit) {
      this.eventEmitter.emit_task_event({
        task_id,
        event_type: 'wip_limit_exceeded',
        data: {
          project_id,
          current: wip.count,
          limit: project.wip_limit,
        },
        triggered_by,
      });

      throw new TasksError('wip_limit_exceeded', 'Project WIP limit exceeded', {
        current: wip.count,
        limit: project.wip_limit,
      });
    }
  }

  private computeNodeCompletion(task_id: string): number {
    const children = this.db
      .prepare(
        `
        SELECT id, status, expected_effort
        FROM tasks
        WHERE parent_task_id = ?
          AND task_type = 'task'
        ORDER BY created_at ASC
        `,
      )
      .all(task_id) as GoalProgressRow[];

    if (children.length === 0) {
      const current = this.db
        .prepare('SELECT status FROM tasks WHERE id = ? LIMIT 1')
        .get(task_id) as { status: TaskStatus } | undefined;

      if (!current) {
        throw new TasksError('task_not_found', `task not found: ${task_id}`);
      }

      return STATUS_COMPLETION_WEIGHT[current.status];
    }

    const weighted = children.reduce(
      (acc, child) => {
        const weight = this.effortToMs(child.expected_effort);
        const completion = this.computeNodeCompletion(child.id);

        return {
          totalWeight: acc.totalWeight + weight,
          completedWeight: acc.completedWeight + completion * weight,
        };
      },
      { totalWeight: 0, completedWeight: 0 },
    );

    if (weighted.totalWeight <= 0) {
      return 0;
    }

    return weighted.completedWeight / weighted.totalWeight;
  }

  private effortToMs(expected_effort: ExpectedEffort | null): number {
    if (!expected_effort) {
      return EFFORT_TO_MS.M;
    }

    return EFFORT_TO_MS[expected_effort];
  }

  private toTask(row: TaskRow): Task {
    return {
      ...row,
      acceptance_criteria: row.acceptance_criteria
        ? (JSON.parse(row.acceptance_criteria) as AcceptanceCriterion[])
        : [],
      metadata: parseJsonObject(row.metadata),
    };
  }
}
