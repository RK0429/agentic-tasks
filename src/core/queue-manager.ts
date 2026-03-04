import Database from 'better-sqlite3';

import { DependencyResolver } from './dependency-resolver.js';
import type { Task } from '../types/index.js';

const PRIORITY_SCORE: Record<Task['priority'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface NextTaskInput {
  project_id: string;
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

  public constructor(db: Database.Database, dependencyResolver: DependencyResolver) {
    this.db = db;
    this.dependencyResolver = dependencyResolver;
  }

  public next_task(input: NextTaskInput): Task | null {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM tasks
        WHERE project_id = ?
          AND task_type = 'task'
          AND status IN ('backlog', 'to_do')
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
      .all(input.project_id) as QueueTaskRow[];

    const filtered = rows
      .filter((row) => !input.assignee || row.assignee === null || row.assignee === input.assignee)
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
}
