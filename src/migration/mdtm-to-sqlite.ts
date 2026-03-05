import { openDatabase } from '../db/index.js';
import type { TaskStatus, TaskType } from '../types/index.js';

import { parseMdtmDirectory, type MdtmTaskDraft } from './mdtm-parser.js';

const DEFAULT_PROJECT_ID = 'PROJ-001';

interface ResolvedTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: 'critical' | 'high' | 'medium' | 'low';
  task_type: TaskType;
  parent_task_id: string | null;
  goal_id: string | null;
  depth: number;
  project_id: string;
  sprint_id: string | null;
  assignee: string | null;
  phase: MdtmTaskDraft['phase'];
  source_ref: string | null;
  expected_effort: MdtmTaskDraft['expected_effort'];
  wbs_version: number;
  gate_status: MdtmTaskDraft['gate_status'];
  created_by: string | null;
  created_at: string;
  updated_at: string;
  acceptance_criteria: MdtmTaskDraft['acceptance_criteria'];
  metadata: MdtmTaskDraft['metadata'];
  depends_on: string[];
  source_path: string;
}

export interface ImportMdtmOptions {
  source_dir: string;
  db_path: string;
  default_project_id?: string;
  clear_existing?: boolean;
}

export interface ImportMdtmResult {
  imported_tasks: number;
  imported_dependencies: number;
  project_ids: string[];
  status_distribution: Record<TaskStatus, number>;
  warnings: string[];
}

function ensureNoDuplicateIds(drafts: MdtmTaskDraft[]): void {
  const seen = new Set<string>();
  for (const draft of drafts) {
    if (seen.has(draft.id)) {
      throw new Error(`duplicate task id in MDTM source: ${draft.id}`);
    }
    seen.add(draft.id);
  }
}

function resolveHierarchy(
  drafts: MdtmTaskDraft[],
  default_project_id: string,
): { resolved: ResolvedTask[]; warnings: string[] } {
  ensureNoDuplicateIds(drafts);

  const warnings: string[] = [];
  const draftMap = new Map(drafts.map((draft) => [draft.id, draft]));
  const parentMap = new Map<string, string | null>();

  for (const draft of drafts) {
    if (draft.task_type === 'goal') {
      parentMap.set(draft.id, null);
      continue;
    }

    const parent =
      draft.parent_task_id ??
      draft.inferred_parent_task_id ??
      draft.goal_id ??
      draft.inferred_goal_id ??
      null;

    if (!parent) {
      throw new Error(`task requires parent_task_id or inferable goal: ${draft.id} (${draft.source_path})`);
    }

    if (!draftMap.has(parent)) {
      throw new Error(`parent task not found: ${draft.id} -> ${parent}`);
    }

    if (parent === draft.id) {
      throw new Error(`task cannot reference itself as parent: ${draft.id}`);
    }

    parentMap.set(draft.id, parent);
  }

  const memo = new Map<string, { goal_id: string | null; depth: number; project_id: string }>();

  const resolveNode = (
    id: string,
    stack: Set<string>,
  ): { goal_id: string | null; depth: number; project_id: string } => {
    const cached = memo.get(id);
    if (cached) {
      return cached;
    }

    if (stack.has(id)) {
      throw new Error(`hierarchy cycle detected around ${id}`);
    }

    const node = draftMap.get(id);
    if (!node) {
      throw new Error(`task not found while resolving hierarchy: ${id}`);
    }

    stack.add(id);

    let resolved: { goal_id: string | null; depth: number; project_id: string };
    if (node.task_type === 'goal') {
      resolved = {
        goal_id: null,
        depth: 0,
        project_id: node.project_id ?? default_project_id,
      };
    } else {
      const parentId = parentMap.get(id);
      if (!parentId) {
        throw new Error(`parent resolution failed for task: ${id}`);
      }

      const parent = draftMap.get(parentId);
      if (!parent) {
        throw new Error(`parent task not found while resolving hierarchy: ${parentId}`);
      }

      const parentResolved = resolveNode(parent.id, stack);
      const goal_id = parent.task_type === 'goal' ? parent.id : parentResolved.goal_id;
      if (!goal_id) {
        throw new Error(`goal_id resolution failed for task: ${id}`);
      }

      const project_id = node.project_id ?? parentResolved.project_id;
      if (node.project_id && node.project_id !== parentResolved.project_id) {
        throw new Error(
          `project mismatch between task and parent: ${id} (${node.project_id}) vs ${parent.id} (${parentResolved.project_id})`,
        );
      }

      resolved = {
        goal_id,
        depth: parentResolved.depth + 1,
        project_id,
      };

      if (node.goal_id && node.goal_id !== goal_id) {
        warnings.push(`goal_id overridden by hierarchy: ${id} (${node.goal_id} -> ${goal_id})`);
      }
    }

    stack.delete(id);
    memo.set(id, resolved);
    return resolved;
  };

  for (const draft of drafts) {
    resolveNode(draft.id, new Set<string>());
  }

  const resolved = drafts
    .map((draft): ResolvedTask => {
      const hierarchy = memo.get(draft.id);
      if (!hierarchy) {
        throw new Error(`internal error: hierarchy is missing for ${draft.id}`);
      }

      return {
        id: draft.id,
        title: draft.title,
        description: draft.description,
        status: draft.status,
        priority: draft.priority,
        task_type: draft.task_type,
        parent_task_id: parentMap.get(draft.id) ?? null,
        goal_id: hierarchy.goal_id,
        depth: hierarchy.depth,
        project_id: hierarchy.project_id,
        sprint_id: draft.sprint_id,
        assignee: draft.assignee,
        phase: draft.phase,
        source_ref: draft.source_ref,
        expected_effort: draft.expected_effort,
        wbs_version: draft.wbs_version,
        gate_status: draft.gate_status,
        created_by: draft.created_by,
        created_at: draft.created_at,
        updated_at: draft.updated_at,
        acceptance_criteria: draft.acceptance_criteria,
        metadata: draft.metadata,
        depends_on: draft.depends_on,
        source_path: draft.source_path,
      };
    })
    .sort((a, b) => {
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      if (a.task_type !== b.task_type) {
        return a.task_type === 'goal' ? -1 : 1;
      }
      return a.id.localeCompare(b.id);
    });

  return {
    resolved,
    warnings,
  };
}

function emptyStatusDistribution(): Record<TaskStatus, number> {
  return {
    backlog: 0,
    to_do: 0,
    in_progress: 0,
    review: 0,
    done: 0,
    blocked: 0,
    escalated: 0,
    archived: 0,
  };
}

export function importMdtmToSqlite(options: ImportMdtmOptions): ImportMdtmResult {
  const parsed = parseMdtmDirectory(options.source_dir);
  const { resolved, warnings: hierarchyWarnings } = resolveHierarchy(
    parsed.tasks,
    options.default_project_id ?? DEFAULT_PROJECT_ID,
  );

  const warnings = [...parsed.warnings, ...hierarchyWarnings];
  const db = openDatabase({ db_path: options.db_path, initialize: true });

  try {
    const projectIds = [...new Set(resolved.map((task) => task.project_id))].sort();

    const insertTask = db.prepare(
      `
      INSERT INTO tasks(
        id, title, description, status, priority, task_type,
        parent_task_id, goal_id, depth, phase, source_ref,
        expected_effort, actual_effort_ms, wbs_version, gate_status,
        project_id, sprint_id, assignee, acceptance_criteria, metadata,
        version, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    const insertDependency = db.prepare(
      `
      INSERT INTO task_dependencies(task_id, depends_on, type, created_at)
      VALUES (?, ?, 'finish_to_start', ?)
      `,
    );

    const insertProject = db.prepare(
      `
      INSERT INTO projects(id, name, description, metadata, wip_limit, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    const tx = db.transaction(() => {
      if (options.clear_existing) {
        db.prepare('DELETE FROM task_dependencies').run();
        db.prepare('DELETE FROM task_locks').run();
        db.prepare('DELETE FROM gate_evaluations').run();
        db.prepare('DELETE FROM quality_gates').run();
        db.prepare('DELETE FROM task_events').run();
        db.prepare('DELETE FROM checkpoints').run();
        db.prepare('DELETE FROM tasks').run();
      }

      const now = new Date().toISOString();
      for (const projectId of projectIds) {
        const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as
          | { id: string }
          | undefined;

        if (!existing) {
          insertProject.run(
            projectId,
            `Imported Project ${projectId}`,
            'Created by MDTM migration import',
            null,
            5,
            1,
            now,
            now,
          );
        }
      }

      for (const task of resolved) {
        const duplicate = db.prepare('SELECT id FROM tasks WHERE id = ?').get(task.id) as
          | { id: string }
          | undefined;

        if (duplicate) {
          throw new Error(`task id already exists in database: ${task.id}`);
        }

        if (task.task_type === 'goal' && task.parent_task_id !== null) {
          throw new Error(`goal cannot have parent_task_id: ${task.id}`);
        }

        if (task.task_type === 'task' && task.parent_task_id === null) {
          throw new Error(`task requires parent_task_id: ${task.id}`);
        }

        insertTask.run(
          task.id,
          task.title,
          task.description,
          task.status,
          task.priority,
          task.task_type,
          task.parent_task_id,
          task.goal_id,
          task.depth,
          task.phase,
          task.source_ref,
          task.expected_effort,
          null,
          task.wbs_version,
          task.gate_status,
          task.project_id,
          task.sprint_id,
          task.assignee,
          JSON.stringify(task.acceptance_criteria),
          JSON.stringify(task.metadata),
          1,
          task.created_by,
          task.created_at,
          task.updated_at,
        );
      }

      const taskMap = new Map(resolved.map((task) => [task.id, task]));
      const createdAt = new Date().toISOString();

      for (const task of resolved) {
        if (task.task_type !== 'task') {
          continue;
        }

        for (const dependsOn of task.depends_on) {
          const upstream = taskMap.get(dependsOn);
          if (!upstream) {
            throw new Error(`dependency target not found: ${task.id} -> ${dependsOn}`);
          }

          if (upstream.task_type !== 'task') {
            throw new Error(`dependency target must be task: ${task.id} -> ${dependsOn}`);
          }

          if (task.goal_id !== upstream.goal_id) {
            throw new Error(`dependency must remain within same goal: ${task.id} -> ${dependsOn}`);
          }

          insertDependency.run(task.id, dependsOn, createdAt);
        }
      }
    });

    tx();

    const hasCycle = (
      db.prepare(
        `
        WITH RECURSIVE graph(root, node) AS (
          SELECT task_id, depends_on FROM task_dependencies
          UNION ALL
          SELECT graph.root, dep.depends_on
          FROM graph
          JOIN task_dependencies dep ON dep.task_id = graph.node
        )
        SELECT COUNT(*) AS count
        FROM graph
        WHERE root = node
        `,
      ).get() as { count: number }
    ).count;

    if (hasCycle > 0) {
      throw new Error('cyclic dependency detected after import');
    }

    const refreshTx = db.transaction(() => {
      const taskRows = db
        .prepare("SELECT id, status FROM tasks WHERE task_type = 'task'")
        .all() as Array<{ id: string; status: TaskStatus }>;

      for (const row of taskRows) {
        const unresolved = (
          db
            .prepare(
              `
              SELECT COUNT(*) AS count
              FROM task_dependencies td
              JOIN tasks t ON t.id = td.depends_on
              WHERE td.task_id = ?
                AND t.status NOT IN ('done', 'archived')
              `,
            )
            .get(row.id) as { count: number }
        ).count;

        if (row.status === 'to_do' && unresolved > 0) {
          db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(
            'blocked',
            new Date().toISOString(),
            row.id,
          );
        }

        if (row.status === 'blocked' && unresolved === 0) {
          db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(
            'to_do',
            new Date().toISOString(),
            row.id,
          );
        }
      }
    });

    refreshTx();

    const status_distribution = emptyStatusDistribution();
    const distributionRows = db
      .prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status')
      .all() as Array<{ status: TaskStatus; count: number }>;

    for (const row of distributionRows) {
      status_distribution[row.status] = row.count;
    }

    const dependencyCount = (
      db.prepare('SELECT COUNT(*) AS count FROM task_dependencies').get() as { count: number }
    ).count;

    return {
      imported_tasks: resolved.length,
      imported_dependencies: dependencyCount,
      project_ids: projectIds,
      status_distribution,
      warnings,
    };
  } finally {
    db.close();
  }
}
