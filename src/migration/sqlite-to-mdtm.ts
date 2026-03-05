import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';

import { openDatabase } from '../db/index.js';
import type { Task } from '../types/index.js';

export interface ExportMdtmOptions {
  db_path: string;
  target_dir: string;
  project_id?: string;
}

export interface ExportMdtmResult {
  exported_tasks: number;
  exported_goals: number;
  files: string[];
}

interface TaskRow {
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
  wbs_version: number;
  gate_status: Task['gate_status'];
  project_id: string;
  sprint_id: string | null;
  assignee: string | null;
  acceptance_criteria: string | null;
  metadata: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function buildFrontmatter(task: TaskRow, depends_on: string[]): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    task_type: task.task_type,
    assignee: task.assignee,
    depends_on,
    parent_task_id: task.parent_task_id,
    goal_id: task.goal_id,
    project_id: task.project_id,
    sprint_id: task.sprint_id,
    phase: task.phase,
    source_ref: task.source_ref,
    expected_effort: task.expected_effort,
    wbs_version: task.wbs_version,
    gate_status: task.gate_status,
    created_by: task.created_by,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };

  const acceptance_criteria = parseJson(task.acceptance_criteria, [] as unknown[]);
  if (acceptance_criteria.length > 0) {
    frontmatter.acceptance_criteria = acceptance_criteria;
  }

  const metadata = parseJson(task.metadata, null as Record<string, unknown> | null);
  if (metadata) {
    frontmatter.metadata = metadata;
  }

  return frontmatter;
}

function fileForTask(
  task: TaskRow,
  pathById: Map<string, string>,
  rootDir: string,
): string {
  if (task.task_type === 'goal') {
    const goalDir = path.join(rootDir, task.id);
    pathById.set(task.id, goalDir);
    return path.join(goalDir, '_goal.md');
  }

  const parentDir = task.parent_task_id ? pathById.get(task.parent_task_id) : undefined;
  if (!parentDir) {
    throw new Error(`parent directory not found while exporting task: ${task.id}`);
  }

  const taskDir = path.join(parentDir, task.id);
  pathById.set(task.id, taskDir);
  return path.join(taskDir, '_task.md');
}

export function exportSqliteToMdtm(options: ExportMdtmOptions): ExportMdtmResult {
  const db = openDatabase({ db_path: options.db_path, initialize: true });

  try {
    const where = options.project_id ? 'WHERE project_id = ?' : '';
    const tasks = db
      .prepare(
        `
        SELECT
          id, title, description, status, priority, task_type,
          parent_task_id, goal_id, depth, phase, source_ref,
          expected_effort, wbs_version, gate_status,
          project_id, sprint_id, assignee,
          acceptance_criteria, metadata, created_by, created_at, updated_at
        FROM tasks
        ${where}
        ORDER BY depth ASC, created_at ASC
        `,
      )
      .all(...(options.project_id ? [options.project_id] : [])) as TaskRow[];

    const dependencies = db
      .prepare('SELECT task_id, depends_on FROM task_dependencies ORDER BY task_id, depends_on')
      .all() as Array<{ task_id: string; depends_on: string }>;

    const dependsOnMap = new Map<string, string[]>();
    for (const edge of dependencies) {
      const current = dependsOnMap.get(edge.task_id) ?? [];
      current.push(edge.depends_on);
      dependsOnMap.set(edge.task_id, current);
    }

    mkdirSync(options.target_dir, { recursive: true });

    const pathById = new Map<string, string>();
    const files: string[] = [];

    for (const task of tasks) {
      const outputPath = fileForTask(task, pathById, options.target_dir);
      mkdirSync(path.dirname(outputPath), { recursive: true });

      const frontmatter = buildFrontmatter(task, dependsOnMap.get(task.id) ?? []);
      const markdown = matter.stringify(`${task.description.trim()}\n`, frontmatter);
      writeFileSync(outputPath, markdown, 'utf8');
      files.push(outputPath);
    }

    return {
      exported_tasks: tasks.length,
      exported_goals: tasks.filter((task) => task.task_type === 'goal').length,
      files,
    };
  } finally {
    db.close();
  }
}
