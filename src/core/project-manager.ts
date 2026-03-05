import Database from 'better-sqlite3';

import { TasksError } from './errors.js';
import { IdGenerator } from './id-generator.js';
import type {
  CreateProjectInput,
  Project,
  UpdateProjectInput,
} from '../types/index.js';

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  metadata: string | null;
  wip_limit: number;
  version: number;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  return JSON.parse(value) as Record<string, unknown>;
}

function normalizeWipLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new TasksError('invalid_wip_limit', 'wip_limit must be an integer >= 1', { value });
  }

  return value;
}

export class ProjectManager {
  private readonly db: Database.Database;
  private readonly idGenerator: IdGenerator;

  public constructor(db: Database.Database, idGenerator: IdGenerator) {
    this.db = db;
    this.idGenerator = idGenerator;
  }

  public createProject(input: CreateProjectInput): Project {
    if (!input.name || input.name.trim() === '') {
      throw new TasksError('invalid_project_name', 'project name is required');
    }

    const wip_limit = normalizeWipLimit(input.wip_limit) ?? 5;
    const id = this.idGenerator.generate('PROJ');
    const now = nowIso();

    this.db
      .prepare(
        `
        INSERT INTO projects(id, name, description, metadata, wip_limit, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.name,
        input.description ?? '',
        JSON.stringify(input.metadata ?? null),
        wip_limit,
        1,
        now,
        now,
      );

    const project = this.getProject(id);
    if (!project) {
      throw new TasksError('project_not_found', `project not found after create: ${id}`);
    }

    return project;
  }

  public getProject(project_id: string): Project | null {
    const row = this.db
      .prepare(
        `
        SELECT id, name, description, metadata, wip_limit, version, created_at, updated_at
        FROM projects
        WHERE id = ?
        LIMIT 1
        `,
      )
      .get(project_id) as ProjectRow | undefined;

    return row ? this.toProject(row) : null;
  }

  public updateProject(project_id: string, input: UpdateProjectInput): Project {
    const current = this.getProject(project_id);
    if (!current) {
      throw new TasksError('project_not_found', `project not found: ${project_id}`);
    }

    const wip_limit = normalizeWipLimit(input.wip_limit);
    const now = nowIso();

    this.db
      .prepare(
        `
        UPDATE projects
        SET name = ?,
            description = ?,
            metadata = ?,
            wip_limit = ?,
            version = version + 1,
            updated_at = ?
        WHERE id = ?
        `,
      )
      .run(
        input.name ?? current.name,
        input.description ?? current.description,
        JSON.stringify(
          Object.prototype.hasOwnProperty.call(input, 'metadata')
            ? input.metadata ?? null
            : current.metadata,
        ),
        wip_limit ?? current.wip_limit,
        now,
        project_id,
      );

    const updated = this.getProject(project_id);
    if (!updated) {
      throw new TasksError('project_not_found', `project not found after update: ${project_id}`);
    }

    return updated;
  }

  public listProjects(): Project[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, name, description, metadata, wip_limit, version, created_at, updated_at
        FROM projects
        ORDER BY created_at ASC
        `,
      )
      .all() as ProjectRow[];

    return rows.map((row) => this.toProject(row));
  }

  public deleteProject(project_id: string): void {
    const project = this.getProject(project_id);
    if (!project) {
      throw new TasksError('project_not_found', `project not found: ${project_id}`);
    }

    const taskCount = (
      this.db
        .prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?')
        .get(project_id) as { count: number }
    ).count;

    if (taskCount > 0) {
      throw new TasksError('project_has_tasks', 'project has tasks and cannot be deleted', {
        project_id,
        task_count: taskCount,
      });
    }

    this.db.prepare('DELETE FROM projects WHERE id = ?').run(project_id);
  }

  private toProject(row: ProjectRow): Project {
    return {
      ...row,
      metadata: parseJsonObject(row.metadata),
    };
  }
}
