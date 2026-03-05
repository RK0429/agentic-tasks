import Database from 'better-sqlite3';

import { DependencyResolver } from './dependency-resolver.js';
import { EventEmitter } from './event-emitter.js';
import { TasksError } from './errors.js';
import type { Task } from '../types/index.js';

const PRIORITY_SCORE: Record<Task['priority'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface NextTaskInput {
  project_id?: string;
  assignee?: string;
}

interface QueueTaskRow {
  id: string;
  title: string;
  description: string;
  status: Task['status'];
  priority: Task['priority'];
  task_type: Task['task_type'];
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

export class QueueManager {
  private readonly db: Database.Database;
  private readonly dependencyResolver: DependencyResolver;
  private readonly eventEmitter: EventEmitter;

  public constructor(
    db: Database.Database,
    dependencyResolver: DependencyResolver,
    eventEmitter: EventEmitter,
  ) {
    this.db = db;
    this.dependencyResolver = dependencyResolver;
    this.eventEmitter = eventEmitter;
  }

  public next_task(input: NextTaskInput): Task | null {
    if (input.project_id) {
      this.ensureProjectWipLimit(input.project_id, input.assignee ?? 'system');
    }

    const where: string[] = ["task_type = 'task'", "status IN ('backlog', 'to_do')"];
    const values: string[] = [];
    if (input.project_id) {
      where.push('project_id = ?');
      values.push(input.project_id);
    }

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM tasks
        WHERE ${where.join(' AND ')}
        ORDER BY
          CASE priority
            WHEN 'critical' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            ELSE 3
          END ASC,
          created_at ASC
        `,
      )
      .all(...values) as QueueTaskRow[];

    const assigneeFiltered = rows.filter(
      (row) => !input.assignee || row.assignee === null || row.assignee === input.assignee,
    );

    if (!input.project_id) {
      const blockedProjects = new Set<string>();
      const projectIds = [...new Set(assigneeFiltered.map((row) => row.project_id))];
      for (const project_id of projectIds) {
        try {
          this.ensureProjectWipLimit(project_id, input.assignee ?? 'system');
        } catch (error) {
          if (error instanceof TasksError && error.code === 'wip_limit_exceeded') {
            blockedProjects.add(project_id);
            continue;
          }
          throw error;
        }
      }

      const ready = assigneeFiltered
        .filter((row) => !blockedProjects.has(row.project_id))
        .filter((row) => this.dependencyResolver.are_dependencies_resolved(row.id))
        .sort((a, b) => PRIORITY_SCORE[a.priority] - PRIORITY_SCORE[b.priority]);

      if (ready.length === 0) {
        return null;
      }

      const row = ready[0];
      return {
        ...row,
        acceptance_criteria: row.acceptance_criteria
          ? (JSON.parse(row.acceptance_criteria) as Task['acceptance_criteria'])
          : [],
        metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
      };
    }

    const filtered = assigneeFiltered
      .filter((row) => this.dependencyResolver.are_dependencies_resolved(row.id))
      .sort((a, b) => PRIORITY_SCORE[a.priority] - PRIORITY_SCORE[b.priority]);

    if (filtered.length === 0) {
      return null;
    }

    const row = filtered[0];
    return {
      ...row,
      acceptance_criteria: row.acceptance_criteria
        ? (JSON.parse(row.acceptance_criteria) as Task['acceptance_criteria'])
        : [],
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    };
  }

  private ensureProjectWipLimit(project_id: string, triggered_by: string): void {
    const project = this.db
      .prepare('SELECT id, wip_limit FROM projects WHERE id = ? LIMIT 1')
      .get(project_id) as { id: string; wip_limit: number } | undefined;

    if (!project) {
      throw new TasksError('project_not_found', `project not found: ${project_id}`);
    }

    const wip = this.db
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

    if (wip.count >= project.wip_limit) {
      const eventTask = this.db
        .prepare(
          `
          SELECT id
          FROM tasks
          WHERE project_id = ?
            AND task_type = 'task'
          ORDER BY created_at ASC
          LIMIT 1
          `,
        )
        .get(project_id) as { id: string } | undefined;

      if (eventTask) {
        this.eventEmitter.emit_task_event({
          task_id: eventTask.id,
          event_type: 'wip_limit_exceeded',
          data: {
            project_id,
            current: wip.count,
            limit: project.wip_limit,
            source: 'next_task',
          },
          triggered_by,
        });
      }

      throw new TasksError('wip_limit_exceeded', 'Project WIP limit exceeded', {
        current: wip.count,
        limit: project.wip_limit,
      });
    }
  }
}
