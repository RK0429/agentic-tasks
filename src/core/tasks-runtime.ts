import Database from 'better-sqlite3';
import path from 'node:path';

import { AccessControl } from './access-control.js';
import { DependencyResolver } from './dependency-resolver.js';
import { EventEmitter } from './event-emitter.js';
import { TasksError } from './errors.js';
import { IdGenerator } from './id-generator.js';
import { LockManager, type StaleLockCleanupInput, type StaleLockCleanupOutput } from './lock-manager.js';
import { ProjectManager } from './project-manager.js';
import { QueueManager } from './queue-manager.js';
import { QualityGateManager } from './quality-gate-manager.js';
import { Scheduler } from './scheduler.js';
import { SprintManager } from './sprint-manager.js';
import { TaskManager } from './task-manager.js';
import {
  exportSqliteToMdtm,
  importMdtmToSqlite,
  type ExportMdtmResult,
  type ImportMdtmResult,
} from '../migration/index.js';
import type {
  CreateProjectInput,
  CreateQualityGateInput,
  CreateScheduleInput,
  CreateSprintInput,
  CreateTaskInput,
  DependencyType,
  ExpectedEffort,
  GateResult,
  ListSprintsInput,
  ListTasksInput,
  Project,
  QualityGate,
  Schedule,
  Sprint,
  Task,
  TaskEvent,
  TaskStatus,
  UpdateProjectInput,
  UpdateScheduleInput,
  UpdateSprintInput,
  UpdateTaskInput,
} from '../types/index.js';

const EFFORT_TO_MS: Record<ExpectedEffort, number> = {
  XS: 1_800_000,
  S: 3_600_000,
  M: 7_200_000,
  L: 14_400_000,
  XL: 28_800_000,
};

interface TaskEventRow {
  id: number;
  task_id: string;
  event_type: string;
  data: string | null;
  triggered_by: string;
  created_at: string;
}

interface GateEvaluationRow {
  id: number;
  gate_id: string;
  task_id: string;
  attempt: number;
  result: GateResult;
  evaluator_agent: string;
  evaluator_backend: string;
  feedback: string | null;
  criteria_results: string | null;
  relay_session_id: string | null;
  evaluated_at: string;
}

interface CheckpointRow {
  id: number;
  goal_id: string | null;
  project_id: string;
  trigger_type: string;
  assessment: string;
  decisions: string | null;
  actions_taken: string | null;
  created_at: string;
}

interface GoalTreeNode {
  task_id: string;
  title: string;
  task_type: string;
  status: string;
  depth: number;
  expected_effort: string | null;
  gate_status: string;
  is_ready: boolean;
  blocked_by: string[];
  depends_on: string[];
  children: GoalTreeNode[];
}

export interface ClaimAndStartInput {
  task_id: string;
  agent_id: string;
  relay_session_id?: string;
  lock_duration_ms?: number;
}

export interface ExtendLockInput {
  task_id: string;
  relay_session_id?: string;
  extend_ms?: number;
}

export interface CompleteTaskInput {
  task_id: string;
  agent_id: string;
  actual_effort_ms?: number;
  result_summary?: string;
}

export interface GoalCleanupResult {
  goal_id: string;
  title: string;
  tasks_deleted: string[];
  summary: {
    total_tasks: number;
    total_effort_ms: number | null;
    result_summaries: Array<{ task_id: string; title: string; summary: string | null }>;
  };
}

export interface ProjectCleanupResult {
  project_id: string;
  name: string;
  goals_deleted: string[];
  summary: {
    total_goals: number;
    total_tasks: number;
    total_effort_ms: number | null;
  };
}

export interface CleanupResult {
  goal_cleaned?: GoalCleanupResult;
  project_cleaned?: ProjectCleanupResult;
}

export interface EscalateTaskInput {
  task_id: string;
  agent_id: string;
  reason: string;
  category:
    | 'scope_unclear'
    | 'technical_blocker'
    | 'resource_needed'
    | 'decision_required'
    | 'quality_concern';
  context?: {
    attempted_approaches?: string[];
    partial_results?: string;
    recommended_action?: string;
  };
}

export interface DecomposeTaskInput {
  task_id: string;
  agent_id: string;
  children: Array<{
    title: string;
    description?: string;
    priority?: Task['priority'];
    expected_effort?: ExpectedEffort;
    acceptance_criteria?: CreateTaskInput['acceptance_criteria'];
  }>;
  dependencies?: Array<{
    from_index: number;
    to_index: number;
    type?: 'finish_to_start' | 'start_to_start';
  }>;
}

export interface DelegateTaskInput {
  task_id: string;
  delegator_agent_id: string;
  delegate_agent_id: string;
  delegate_backend?: 'claude' | 'codex' | 'gemini';
  instructions: string;
  relay_session_id?: string;
  lock_duration_ms?: number;
}

export interface TriggerReplanInput {
  goal_id: string;
  agent_id: string;
  reason: string;
  scope_changes?: ScopeChange[];
}

export type ScopeChange =
  | {
      type: 'add_task';
      description: string;
      parent_task_id?: string;
      new_task: {
        title: string;
        description?: string;
        priority?: Task['priority'];
        expected_effort?: ExpectedEffort;
        acceptance_criteria?: CreateTaskInput['acceptance_criteria'];
      };
    }
  | {
      type: 'modify_task';
      description: string;
      task_id: string;
      modifications: {
        title?: string;
        priority?: Task['priority'];
        expected_effort?: ExpectedEffort;
        acceptance_criteria?: CreateTaskInput['acceptance_criteria'];
      };
    }
  | {
      type: 'remove_task';
      description: string;
      task_id: string;
    }
  | {
      type: 'add_dependency';
      description: string;
      task_id: string;
      depends_on: string;
      dependency_type?: 'finish_to_start' | 'start_to_start';
    }
  | {
      type: 'remove_dependency';
      description: string;
      task_id: string;
      depends_on: string;
    };

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  return JSON.parse(value) as T;
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function isSystemActor(agent_id: string | undefined | null): boolean {
  return !agent_id || agent_id === 'system';
}

function expectedEffortToMs(expected_effort: ExpectedEffort | null): number {
  if (!expected_effort) {
    return EFFORT_TO_MS.M;
  }

  return EFFORT_TO_MS[expected_effort];
}

export interface TasksRuntimeDependencies {
  access_control?: AccessControl;
  dependency_resolver?: DependencyResolver;
  event_emitter?: EventEmitter;
  id_generator?: IdGenerator;
  lock_manager?: LockManager;
  project_manager?: ProjectManager;
  queue_manager?: QueueManager;
  quality_gate_manager?: QualityGateManager;
  scheduler?: Scheduler;
  sprint_manager?: SprintManager;
  task_manager?: TaskManager;
}

export class TasksRuntime {
  private readonly db: Database.Database;
  private readonly accessControl: AccessControl;
  private readonly eventEmitter: EventEmitter;
  private readonly idGenerator: IdGenerator;
  private readonly dependencyResolver: DependencyResolver;
  private readonly qualityGateManager: QualityGateManager;
  private readonly taskManager: TaskManager;
  private readonly lockManager: LockManager;
  private readonly queueManager: QueueManager;
  private readonly projectManager: ProjectManager;
  private readonly sprintManager: SprintManager;
  private readonly scheduler: Scheduler;

  public constructor(db: Database.Database, deps: TasksRuntimeDependencies = {}) {
    this.db = db;

    this.accessControl = deps.access_control ?? new AccessControl(db);
    this.eventEmitter = deps.event_emitter ?? new EventEmitter(db);
    this.idGenerator = deps.id_generator ?? new IdGenerator(db);
    this.dependencyResolver =
      deps.dependency_resolver ?? new DependencyResolver(db, this.eventEmitter);
    this.qualityGateManager =
      deps.quality_gate_manager ?? new QualityGateManager(db, this.idGenerator, this.eventEmitter);
    this.taskManager =
      deps.task_manager ??
      new TaskManager(db, {
        access_control: this.accessControl,
        dependency_resolver: this.dependencyResolver,
        event_emitter: this.eventEmitter,
        id_generator: this.idGenerator,
        quality_gate_manager: this.qualityGateManager,
      });
    this.lockManager = deps.lock_manager ?? new LockManager(db, this.eventEmitter);
    this.queueManager =
      deps.queue_manager ?? new QueueManager(db, this.dependencyResolver, this.eventEmitter);
    this.projectManager = deps.project_manager ?? new ProjectManager(db, this.idGenerator);
    this.sprintManager =
      deps.sprint_manager ?? new SprintManager(db, this.idGenerator, this.eventEmitter);
    this.scheduler =
      deps.scheduler ??
      new Scheduler(db, this.idGenerator, this.taskManager, this.eventEmitter);
  }

  public create_task(input: CreateTaskInput, agent_id: string): Task {
    return this.taskManager.createTask(
      {
        ...input,
        created_by: input.created_by ?? agent_id,
      },
      agent_id,
    );
  }

  public update_task(task_id: string, input: UpdateTaskInput, agent_id: string): Task {
    return this.taskManager.updateTask(task_id, input, agent_id, agent_id);
  }

  public delete_task(task_id: string, agent_id: string): { task_id: string; deleted: true } {
    this.taskManager.deleteTask(task_id, agent_id, agent_id);
    return {
      task_id,
      deleted: true,
    };
  }

  public list_tasks(filters: ListTasksInput = {}): { tasks: Task[] } {
    return { tasks: this.taskManager.listTasks(filters) };
  }

  public add_dependency(input: {
    task_id: string;
    depends_on: string;
    type?: DependencyType;
    agent_id: string;
  }): { task_id: string; depends_on: string; type: DependencyType } {
    this.dependencyResolver.add_dependency({
      task_id: input.task_id,
      depends_on: input.depends_on,
      type: input.type,
      triggered_by: input.agent_id,
    });
    return {
      task_id: input.task_id,
      depends_on: input.depends_on,
      type: input.type ?? 'finish_to_start',
    };
  }

  public remove_dependency(input: {
    task_id: string;
    depends_on: string;
    agent_id: string;
  }): { task_id: string; depends_on: string; removed: true } {
    this.dependencyResolver.remove_dependency(input.task_id, input.depends_on, input.agent_id);
    return {
      task_id: input.task_id,
      depends_on: input.depends_on,
      removed: true,
    };
  }

  public create_project(input: CreateProjectInput): { project: Project } {
    return {
      project: this.projectManager.createProject(input),
    };
  }

  public get_project(project_id: string): { project: Project } {
    const project = this.projectManager.getProject(project_id);
    if (!project) {
      throw new TasksError('project_not_found', `project not found: ${project_id}`);
    }

    return { project };
  }

  public update_project(project_id: string, input: UpdateProjectInput): { project: Project } {
    return {
      project: this.projectManager.updateProject(project_id, input),
    };
  }

  public list_projects(): { projects: Project[] } {
    return {
      projects: this.projectManager.listProjects(),
    };
  }

  public delete_project(project_id: string): { project_id: string; deleted: true } {
    this.projectManager.deleteProject(project_id);
    return {
      project_id,
      deleted: true,
    };
  }

  public create_sprint(input: CreateSprintInput): { sprint: Sprint } {
    return {
      sprint: this.sprintManager.createSprint(input),
    };
  }

  public update_sprint(sprint_id: string, input: UpdateSprintInput): { sprint: Sprint } {
    return {
      sprint: this.sprintManager.updateSprint(sprint_id, input),
    };
  }

  public list_sprints(input: ListSprintsInput = {}): { sprints: Sprint[] } {
    return {
      sprints: this.sprintManager.listSprints(input),
    };
  }

  public complete_sprint(input: { sprint_id: string; agent_id?: string }): {
    sprint: Sprint;
    moved_tasks: string[];
  } {
    return this.sprintManager.completeSprint(input.sprint_id, input.agent_id ?? 'system');
  }

  public create_schedule(input: CreateScheduleInput): { schedule: Schedule } {
    return {
      schedule: this.scheduler.createSchedule(input),
    };
  }

  public get_schedule(schedule_id: string): { schedule: Schedule } {
    const schedule = this.scheduler.getSchedule(schedule_id);
    if (!schedule) {
      throw new TasksError('schedule_not_found', `schedule not found: ${schedule_id}`);
    }

    return {
      schedule,
    };
  }

  public update_schedule(schedule_id: string, input: UpdateScheduleInput): { schedule: Schedule } {
    return {
      schedule: this.scheduler.updateSchedule(schedule_id, input),
    };
  }

  public delete_schedule(schedule_id: string): { schedule_id: string; deleted: true } {
    this.scheduler.deleteSchedule(schedule_id);
    return {
      schedule_id,
      deleted: true,
    };
  }

  public list_schedules(project_id?: string): { schedules: Schedule[] } {
    return {
      schedules: this.scheduler.listSchedules(project_id),
    };
  }

  public run_scheduler(): { created_tasks: string[] } {
    return this.scheduler.checkAndRun();
  }

  public get_task(task_id: string, include_dependencies = true): {
    task: Task;
    lock: ReturnType<LockManager['get_lock']>;
    dependencies?: {
      upstream: Task[];
      downstream: Task[];
    };
    quality_gates: Array<{
      gate: QualityGate;
      latest_evaluation: Record<string, unknown> | null;
    }>;
    parent: { id: string; title: string; task_type: string } | null;
    children_count: number;
  } {
    const task = this.taskManager.getTask(task_id);
    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${task_id}`);
    }

    const lock = this.lockManager.get_lock(task_id);

    const qualityGates = this.qualityGateManager.list_quality_gates(task_id).map((gate) => {
      const latest = this.db
        .prepare(
          `
          SELECT id, gate_id, task_id, attempt, result, evaluator_agent,
                 evaluator_backend, feedback, criteria_results, relay_session_id, evaluated_at
          FROM gate_evaluations
          WHERE gate_id = ?
          ORDER BY attempt DESC
          LIMIT 1
          `,
        )
        .get(gate.id) as GateEvaluationRow | undefined;

      return {
        gate,
        latest_evaluation: latest
          ? {
              ...latest,
              criteria_results: parseJson(latest.criteria_results, []),
            }
          : null,
      };
    });

    const parent = task.parent_task_id
      ? ((this.db
          .prepare('SELECT id, title, task_type FROM tasks WHERE id = ? LIMIT 1')
          .get(task.parent_task_id) as
          | { id: string; title: string; task_type: string }
          | undefined) ?? null)
      : null;

    const children_count = (
      this.db
        .prepare('SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ?')
        .get(task.id) as { count: number }
    ).count;

    if (!include_dependencies) {
      return {
        task,
        lock,
        quality_gates: qualityGates,
        parent,
        children_count,
      };
    }

    const dependencyIds = this.dependencyResolver.list_dependencies(task_id);
    const upstream = dependencyIds.upstream
      .map((id) => this.taskManager.getTask(id))
      .filter((value): value is Task => value !== null);
    const downstream = dependencyIds.downstream
      .map((id) => this.taskManager.getTask(id))
      .filter((value): value is Task => value !== null);

    return {
      task,
      lock,
      dependencies: {
        upstream,
        downstream,
      },
      quality_gates: qualityGates,
      parent,
      children_count,
    };
  }

  public next_task(input: { project_id?: string; assignee?: string }): Task | null {
    return this.queueManager.next_task(input);
  }

  public get_events(input: {
    task_id?: string;
    project_id?: string;
    event_types?: string[];
    since?: string;
    limit?: number;
  } = {}): { events: TaskEvent[]; has_more: boolean } {
    const where: string[] = [];
    const values: Array<string | number> = [];

    if (input.task_id) {
      where.push('e.task_id = ?');
      values.push(input.task_id);
    }
    if (input.project_id) {
      where.push('t.project_id = ?');
      values.push(input.project_id);
    }
    if (input.event_types && input.event_types.length > 0) {
      where.push(`e.event_type IN (${input.event_types.map(() => '?').join(', ')})`);
      values.push(...input.event_types);
    }
    if (input.since) {
      const since = Date.parse(input.since);
      if (Number.isNaN(since)) {
        throw new TasksError('invalid_since', 'since must be valid ISO 8601 datetime');
      }
      where.push('e.created_at >= ?');
      values.push(new Date(since).toISOString());
    }

    const limit = this.normalizeLimit(input.limit, 50);
    const joins = input.project_id ? 'JOIN tasks t ON t.id = e.task_id' : '';
    const sql = [
      'SELECT e.id, e.task_id, e.event_type, e.data, e.triggered_by, e.created_at',
      'FROM task_events e',
      joins,
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      'ORDER BY e.id DESC',
      'LIMIT ?',
    ]
      .filter(Boolean)
      .join(' ');

    const rows = this.db.prepare(sql).all(...values, limit + 1) as TaskEventRow[];
    const has_more = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => this.toTaskEvent(row));
    return {
      events,
      has_more,
    };
  }

  public async poll_events(input: {
    cursor?: string;
    event_types?: string[];
    project_id?: string;
    timeout_ms?: number;
    limit?: number;
  } = {}): Promise<{ events: TaskEvent[]; next_cursor: string }> {
    const cursor = this.parseCursor(input.cursor);
    const timeout_ms = Math.max(0, input.timeout_ms ?? 0);
    const limit = this.normalizeLimit(input.limit, 50);
    const deadline = Date.now() + timeout_ms;

    for (;;) {
      const rows = this.selectEventsAfterCursor(cursor, {
        event_types: input.event_types,
        project_id: input.project_id,
        limit,
      });

      if (rows.length > 0 || timeout_ms === 0 || Date.now() >= deadline) {
        const events = rows.map((row) => this.toTaskEvent(row));
        return {
          events,
          next_cursor: events.length > 0 ? String(events[events.length - 1]?.id ?? cursor) : String(cursor),
        };
      }

      const wait_ms = Math.min(250, Math.max(0, deadline - Date.now()));
      if (wait_ms <= 0) {
        return {
          events: [],
          next_cursor: String(cursor),
        };
      }

      await new Promise((resolve) => setTimeout(resolve, wait_ms));
    }
  }

  public import_mdtm(input: {
    source_dir: string;
    default_project_id?: string;
    project_id?: string;
    clear_existing?: boolean;
  }): ImportMdtmResult {
    if (!input.source_dir || input.source_dir.trim() === '') {
      throw new TasksError('invalid_source_dir', 'source_dir is required');
    }

    return importMdtmToSqlite({
      source_dir: path.resolve(input.source_dir),
      db_path: this.resolveDatabasePath(),
      default_project_id: input.default_project_id ?? input.project_id,
      clear_existing: input.clear_existing ?? false,
    });
  }

  public export_mdtm(input: {
    target_dir: string;
    project_id?: string;
  }): ExportMdtmResult {
    if (!input.target_dir || input.target_dir.trim() === '') {
      throw new TasksError('invalid_target_dir', 'target_dir is required');
    }

    return exportSqliteToMdtm({
      db_path: this.resolveDatabasePath(),
      target_dir: path.resolve(input.target_dir),
      project_id: input.project_id,
    });
  }

  public assign_task(input: {
    task_id: string;
    assignee: string | null;
    agent_id: string;
  }): { task: Task } {
    return {
      task: this.taskManager.assignTask(input.task_id, input.assignee, input.agent_id, input.agent_id),
    };
  }

  public release_task(input: { task_id: string; agent_id: string }): {
    task_id: string;
    released: boolean;
  } {
    this.accessControl.ensure_task_action('release_task', input.task_id, input.agent_id);
    this.lockManager.release_lock(input.task_id, input.agent_id);

    const task = this.taskManager.getTask(input.task_id);
    if (task && task.status === 'in_progress') {
      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = ?,
              updated_at = ?,
              version = version + 1
          WHERE id = ?
          `,
        )
        .run('to_do', nowIso(), task.id);

      this.eventEmitter.emit_task_event({
        task_id: task.id,
        event_type: 'status_changed',
        data: {
          from: task.status,
          to: 'to_do',
          reason: 'manual_release',
        },
        triggered_by: input.agent_id,
      });
    }

    return {
      task_id: input.task_id,
      released: true,
    };
  }

  public extend_lock(input: ExtendLockInput): {
    success: true;
    extended: true;
    new_expires_at: string;
  } {
    const lock = this.lockManager.get_lock(input.task_id);
    if (!lock) {
      throw new TasksError('not_locked', `task is not locked: ${input.task_id}`);
    }

    if (
      input.relay_session_id &&
      lock.relay_session_id &&
      lock.relay_session_id !== input.relay_session_id
    ) {
      throw new TasksError('session_mismatch', 'lock relay_session_id mismatch', {
        task_id: input.task_id,
        expected_session_id: lock.relay_session_id,
        actual_session_id: input.relay_session_id,
      });
    }

    const extended = this.lockManager.extend_lock(input.task_id, input.extend_ms);
    return {
      success: true,
      extended: true,
      new_expires_at: extended.expires_at,
    };
  }

  public resolve_dependencies(task_id: string): {
    task_id: string;
    is_resolved: boolean;
    dependencies: { upstream: string[]; downstream: string[] };
  } {
    return {
      task_id,
      is_resolved: this.dependencyResolver.are_dependencies_resolved(task_id),
      dependencies: this.dependencyResolver.list_dependencies(task_id),
    };
  }

  public claim_and_start(input: ClaimAndStartInput): {
    task_id: string;
    new_status: 'in_progress';
    lock: { locked_at: string; expires_at: string };
    task: Task;
  } {
    this.accessControl.ensure_task_action('claim_and_start', input.task_id, input.agent_id);

    const task = this.taskManager.getTask(input.task_id);
    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${input.task_id}`);
    }

    if (task.task_type !== 'task') {
      throw new TasksError('invalid_task_type', 'goal cannot be claimed');
    }

    const existingLock = this.lockManager.get_lock(task.id);
    const hasActiveLock = Boolean(
      existingLock && new Date(existingLock.expires_at).getTime() > Date.now(),
    );
    const isReclaimableInProgress = task.status === 'in_progress' && !hasActiveLock;

    if (
      task.status === 'in_progress' &&
      hasActiveLock &&
      existingLock &&
      existingLock.agent_id !== input.agent_id
    ) {
      throw new TasksError('lock_conflict', 'task is already locked', {
        task_id: task.id,
        lock_holder: existingLock.agent_id,
        expires_at: existingLock.expires_at,
      });
    }

    if (
      task.status !== 'backlog' &&
      task.status !== 'to_do' &&
      !isReclaimableInProgress
    ) {
      throw new TasksError(
        'invalid_status',
        'only backlog/to_do task or stale in_progress task can be claimed',
        {
          status: task.status,
        },
      );
    }

    if (task.status !== 'in_progress' && !this.dependencyResolver.are_dependencies_resolved(task.id)) {
      throw new TasksError('dependency_not_resolved', 'unresolved dependencies block in_progress');
    }

    if (task.status !== 'in_progress') {
      const wip = this.taskManager.getProjectWip(task.project_id);
      if (wip.wip_count >= wip.wip_limit) {
        this.eventEmitter.emit_task_event({
          task_id: task.id,
          event_type: 'wip_limit_exceeded',
          data: {
            project_id: task.project_id,
            current: wip.wip_count,
            limit: wip.wip_limit,
            source: 'claim_and_start',
          },
          triggered_by: input.agent_id,
        });

        throw new TasksError('wip_limit_exceeded', 'Project WIP limit exceeded', {
          current: wip.wip_count,
          limit: wip.wip_limit,
        });
      }
    }

    const lock_duration_ms = input.lock_duration_ms ?? 3_600_000;
    const now = nowIso();
    const lock = {
      locked_at: now,
      expires_at: new Date(new Date(now).getTime() + lock_duration_ms).toISOString(),
    };

    const tx = this.db.transaction(() => {
      const currentLock = this.lockManager.get_lock(task.id);
      if (currentLock && new Date(currentLock.expires_at).getTime() > Date.now()) {
        throw new TasksError('lock_conflict', 'task is already locked', {
          task_id: task.id,
          lock_holder: currentLock.agent_id,
          expires_at: currentLock.expires_at,
        });
      }

      this.db.prepare('DELETE FROM task_locks WHERE task_id = ?').run(task.id);

      this.db
        .prepare(
          `
          INSERT INTO task_locks(task_id, agent_id, relay_session_id, locked_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
          `,
        )
        .run(
          task.id,
          input.agent_id,
          input.relay_session_id ?? null,
          lock.locked_at,
          lock.expires_at,
        );

      this.db
        .prepare(
          `
          UPDATE tasks
          SET assignee = ?,
              status = 'in_progress',
              updated_at = ?,
              version = version + 1
          WHERE id = ?
          `,
        )
        .run(input.agent_id, now, task.id);

      this.eventEmitter.emit_task_event({
        task_id: task.id,
        event_type: 'locked',
        data: {
          agent_id: input.agent_id,
          relay_session_id: input.relay_session_id ?? null,
          expires_at: lock.expires_at,
        },
        triggered_by: input.agent_id,
      });

      if (task.status !== 'in_progress') {
        this.eventEmitter.emit_task_event({
          task_id: task.id,
          event_type: 'status_changed',
          data: {
            from: task.status,
            to: 'in_progress',
          },
          triggered_by: input.agent_id,
        });
      }
      if (task.status === 'in_progress') {
        this.eventEmitter.emit_task_event({
          task_id: task.id,
          event_type: 'task_reclaimed',
          data: {
            previous_assignee: task.assignee,
            previous_lock_holder: currentLock?.agent_id ?? null,
          },
          triggered_by: input.agent_id,
        });
      }

      this.eventEmitter.emit_task_event({
        task_id: task.id,
        event_type: 'task_claimed',
        data: {
          agent_id: input.agent_id,
        },
        triggered_by: input.agent_id,
      });
    });

    tx();

    const updated = this.taskManager.getTask(task.id);
    if (!updated) {
      throw new TasksError('task_not_found', `task not found after claim: ${task.id}`);
    }

    return {
      task_id: task.id,
      new_status: 'in_progress',
      lock,
      task: updated,
    };
  }

  public complete_task(input: CompleteTaskInput):
    | {
        status: 'completed';
        task_id: string;
        new_status: 'review' | 'done';
        lock_released: boolean;
        parent_progress_updated: boolean;
        parent_auto_review: boolean;
      }
    | {
        status: 'already_completed';
        task_id: string;
        completed_at: string;
        new_status?: 'review' | 'done';
      }
    | {
        status: 'conflict';
        task_id: string;
        completed_by: string;
        completed_at: string;
        new_status?: 'review' | 'done';
      } {
    const task = this.taskManager.getTask(input.task_id);
    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${input.task_id}`);
    }

    const latestCompletedEvent = this.db
      .prepare(
        `
        SELECT id, task_id, event_type, data, triggered_by, created_at
        FROM task_events
        WHERE task_id = ?
          AND event_type = 'task_completed'
        ORDER BY id DESC
        LIMIT 1
        `,
      )
      .get(task.id) as TaskEventRow | undefined;

    if (task.status === 'done') {
      const completed_by = latestCompletedEvent?.triggered_by ?? task.assignee ?? 'unknown';
      const completed_at = latestCompletedEvent?.created_at ?? task.updated_at;

      if (completed_by === input.agent_id || isSystemActor(input.agent_id)) {
        return {
          status: 'already_completed',
          task_id: task.id,
          completed_at,
        };
      }

      return {
        status: 'conflict',
        task_id: task.id,
        completed_by,
        completed_at,
      };
    }

    this.accessControl.ensure_task_action('complete_task', task.id, input.agent_id);

    if (task.status !== 'in_progress') {
      throw new TasksError('invalid_status', 'only in_progress task can be completed', {
        status: task.status,
      });
    }

    const requiredGateCount = (
      this.db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM quality_gates
          WHERE task_id = ?
            AND enforcement_level = 'required'
          `,
        )
        .get(task.id) as { count: number }
    ).count;

    const skip_review = task.metadata?.skip_review === true;
    const nextStatus: 'review' | 'done' = skip_review ? 'done' : 'review';

    if (nextStatus === 'done') {
      this.ensureChildTasksDone(task.id);
    }

    const lock = this.lockManager.get_lock(task.id);
    const now = nowIso();

    const tx = this.db.transaction(() => {
      const updatedMetadata = {
        ...(task.metadata ?? {}),
        completion: {
          result_summary: input.result_summary ?? null,
          completed_by: input.agent_id,
          completed_at: now,
        },
      };

      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = ?,
              actual_effort_ms = ?,
              metadata = ?,
              updated_at = ?,
              version = version + 1
          WHERE id = ?
          `,
        )
        .run(
          nextStatus,
          input.actual_effort_ms ?? task.actual_effort_ms,
          JSON.stringify(updatedMetadata),
          now,
          task.id,
        );

      this.db.prepare('DELETE FROM task_locks WHERE task_id = ?').run(task.id);

      if (lock) {
        this.eventEmitter.emit_task_event({
          task_id: task.id,
          event_type: 'unlocked',
          data: {
            released_by: input.agent_id,
          },
          triggered_by: input.agent_id,
        });
      }

      this.eventEmitter.emit_task_event({
        task_id: task.id,
        event_type: 'status_changed',
        data: {
          from: task.status,
          to: nextStatus,
        },
        triggered_by: input.agent_id,
      });

      this.eventEmitter.emit_task_event({
        task_id: task.id,
        event_type: 'task_completed',
        data: {
          new_status: nextStatus,
          skip_review,
          required_gate_count: requiredGateCount,
        },
        triggered_by: input.agent_id,
      });
    });

    tx();

    if (nextStatus === 'done') {
      this.unblockResolvedDependents(task.id, input.agent_id);
      this.maybeRunCleanup(task.id, input.agent_id);
    }

    return {
      status: 'completed',
      task_id: task.id,
      new_status: nextStatus,
      lock_released: Boolean(lock),
      parent_progress_updated: Boolean(task.goal_id),
      parent_auto_review: false,
    };
  }

  public approve_task(input: {
    task_id: string;
    agent_id: string;
    result_summary?: string;
  }):
    | {
        status: 'approved';
        task_id: string;
        new_status: 'done';
        cleanup?: CleanupResult;
      }
    | {
        status: 'already_completed';
        task_id: string;
        completed_at: string;
      } {
    const task = this.taskManager.getTask(input.task_id);
    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${input.task_id}`);
    }

    const latestCompletion = this.db
      .prepare(
        `
        SELECT id, task_id, event_type, data, triggered_by, created_at
        FROM task_events
        WHERE task_id = ?
          AND event_type IN ('task_completed', 'task_approved')
        ORDER BY id DESC
        LIMIT 1
        `,
      )
      .get(task.id) as TaskEventRow | undefined;

    if (task.status === 'done') {
      return {
        status: 'already_completed',
        task_id: task.id,
        completed_at: latestCompletion?.created_at ?? task.updated_at,
      };
    }

    this.accessControl.ensure_task_action('approve_task', task.id, input.agent_id);

    if (task.status !== 'review') {
      throw new TasksError('invalid_status', 'only review task can be approved', {
        status: task.status,
      });
    }

    this.ensureChildTasksDone(task.id);
    this.qualityGateManager.assert_review_to_done_allowed(task.id, input.agent_id);

    const now = nowIso();
    const completion = (task.metadata?.completion ?? {}) as Record<string, unknown>;
    const updatedMetadata = {
      ...(task.metadata ?? {}),
      completion: {
        ...completion,
        result_summary: input.result_summary ?? completion.result_summary ?? null,
        approved_by: input.agent_id,
        approved_at: now,
      },
    };

    this.db
      .prepare(
        `
        UPDATE tasks
        SET status = ?,
            metadata = ?,
            updated_at = ?,
            version = version + 1
        WHERE id = ?
        `,
      )
      .run('done', JSON.stringify(updatedMetadata), now, task.id);

    this.eventEmitter.emit_task_event({
      task_id: task.id,
      event_type: 'status_changed',
      data: {
        from: task.status,
        to: 'done',
      },
      triggered_by: input.agent_id,
    });

    this.eventEmitter.emit_task_event({
      task_id: task.id,
      event_type: 'task_approved',
      data: {
        result_summary: input.result_summary ?? null,
      },
      triggered_by: input.agent_id,
    });

    this.unblockResolvedDependents(task.id, input.agent_id);
    const cleanup = this.maybeRunCleanup(task.id, input.agent_id);

    return {
      status: 'approved',
      task_id: task.id,
      new_status: 'done',
      ...(cleanup ? { cleanup } : {}),
    };
  }

  public block_task(input: {
    task_id: string;
    agent_id: string;
    reason: string;
    blocked_by?: string;
  }): { task_id: string; new_status: 'blocked' } {
    this.accessControl.ensure_task_action('block_task', input.task_id, input.agent_id);

    const task = this.taskManager.getTask(input.task_id);
    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${input.task_id}`);
    }

    if (task.status !== 'in_progress') {
      throw new TasksError('invalid_status', 'only in_progress task can be blocked', {
        status: task.status,
      });
    }

    const lock = this.lockManager.get_lock(task.id);
    if (lock && lock.agent_id !== input.agent_id) {
      throw new TasksError('lock_owner_mismatch', 'lock owned by another agent', {
        task_id: task.id,
        lock_holder: lock.agent_id,
      });
    }

    const now = nowIso();
    const updatedMetadata = {
      ...(task.metadata ?? {}),
      block: {
        reason: input.reason,
        blocked_by: input.blocked_by ?? null,
        blocked_at: now,
      },
    };

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = ?,
              metadata = ?,
              updated_at = ?,
              version = version + 1
          WHERE id = ?
          `,
        )
        .run('blocked', JSON.stringify(updatedMetadata), now, task.id);

      this.db.prepare('DELETE FROM task_locks WHERE task_id = ?').run(task.id);

      if (lock) {
        this.eventEmitter.emit_task_event({
          task_id: task.id,
          event_type: 'unlocked',
          data: {
            released_by: input.agent_id,
            reason: 'task_blocked',
          },
          triggered_by: input.agent_id,
        });
      }

      this.eventEmitter.emit_task_event({
        task_id: task.id,
        event_type: 'status_changed',
        data: {
          from: task.status,
          to: 'blocked',
          reason: input.reason,
          blocked_by: input.blocked_by ?? null,
        },
        triggered_by: input.agent_id,
      });

      this.eventEmitter.emit_task_event({
        task_id: task.id,
        event_type: 'task_blocked',
        data: {
          reason: input.reason,
          blocked_by: input.blocked_by ?? null,
        },
        triggered_by: input.agent_id,
      });
    });

    tx();

    return {
      task_id: task.id,
      new_status: 'blocked',
    };
  }

  public reopen_task(input: {
    task_id: string;
    agent_id: string;
    reason?: string;
  }): { task_id: string; new_status: 'to_do' } {
    this.accessControl.ensure_task_action('reopen_task', input.task_id, input.agent_id);

    const task = this.taskManager.getTask(input.task_id);
    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${input.task_id}`);
    }

    if (task.status !== 'review' && task.status !== 'blocked' && task.status !== 'escalated') {
      throw new TasksError('invalid_status', 'only review/blocked/escalated task can be reopened', {
        status: task.status,
      });
    }

    const now = nowIso();
    const lock = this.lockManager.get_lock(task.id);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = ?,
              updated_at = ?,
              version = version + 1
          WHERE id = ?
          `,
        )
        .run('to_do', now, task.id);

      this.db.prepare('DELETE FROM task_locks WHERE task_id = ?').run(task.id);

      if (lock) {
        this.eventEmitter.emit_task_event({
          task_id: task.id,
          event_type: 'unlocked',
          data: {
            released_by: input.agent_id,
            reason: 'task_reopened',
          },
          triggered_by: input.agent_id,
        });
      }

      this.eventEmitter.emit_task_event({
        task_id: task.id,
        event_type: 'status_changed',
        data: {
          from: task.status,
          to: 'to_do',
          reason: input.reason ?? null,
        },
        triggered_by: input.agent_id,
      });
    });

    tx();

    return {
      task_id: task.id,
      new_status: 'to_do',
    };
  }

  public archive_task(input: {
    task_id: string;
    agent_id: string;
  }): { task_id: string; new_status: 'archived'; descendants_archived: string[] } {
    this.accessControl.ensure_task_action('archive_task', input.task_id, input.agent_id);

    const task = this.taskManager.getTask(input.task_id);
    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${input.task_id}`);
    }

    const descendants = this.db
      .prepare(
        `
        WITH RECURSIVE descendants AS (
          SELECT id, status FROM tasks WHERE parent_task_id = ?
          UNION ALL
          SELECT t.id, t.status
          FROM tasks t
          INNER JOIN descendants d ON t.parent_task_id = d.id
        )
        SELECT id, status FROM descendants
        `,
      )
      .all(task.id) as Array<{ id: string; status: TaskStatus }>;

    const blockingIds = [
      ...(task.status === 'in_progress' ? [task.id] : []),
      ...descendants.filter((descendant) => descendant.status === 'in_progress').map((node) => node.id),
    ];
    if (blockingIds.length > 0) {
      throw new TasksError('descendant_in_progress', 'cannot archive while task is in_progress', {
        blocking_task_ids: blockingIds,
      });
    }

    const now = nowIso();
    const descendants_archived: string[] = [];
    const nodes = [{ id: task.id, status: task.status }, ...descendants];

    const tx = this.db.transaction(() => {
      for (const node of nodes) {
        if (node.status === 'archived') {
          continue;
        }

        this.db
          .prepare('UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ?')
          .run('archived', now, node.id);

        if (node.id !== task.id) {
          descendants_archived.push(node.id);
        }

        this.eventEmitter.emit_task_event({
          task_id: node.id,
          event_type: 'status_changed',
          data: {
            from: node.status,
            to: 'archived',
            reason: node.id === task.id ? 'archive_task' : 'cascade_archive',
            root_task_id: task.id,
          },
          triggered_by: input.agent_id,
        });
      }

      const locks = this.db
        .prepare(
          `
          SELECT task_id
          FROM task_locks
          WHERE task_id IN (${nodes.map(() => '?').join(', ')})
          `,
        )
        .all(...nodes.map((node) => node.id)) as Array<{ task_id: string }>;

      for (const lock of locks) {
        this.db.prepare('DELETE FROM task_locks WHERE task_id = ?').run(lock.task_id);
        this.eventEmitter.emit_task_event({
          task_id: lock.task_id,
          event_type: 'unlocked',
          data: {
            released_by: input.agent_id,
            reason: 'archived',
          },
          triggered_by: input.agent_id,
        });
      }
    });

    tx();

    this.maybeRunCleanup(task.id, input.agent_id);

    return {
      task_id: task.id,
      new_status: 'archived',
      descendants_archived,
    };
  }

  public purge_archived(input: {
    retention_hours?: number;
  }): { purged_count: number; retention_hours: number } {
    const retentionHours = input.retention_hours ?? 24;
    const retentionMs = retentionHours * 60 * 60 * 1000;
    const purged_count = this.taskManager.purgeArchived(retentionMs);

    return {
      purged_count,
      retention_hours: retentionHours,
    };
  }

  public escalate_task(input: EscalateTaskInput): {
    task_id: string;
    new_status: 'escalated';
    parent_task_id: string | null;
    parent_assignee: string | null;
  } {
    this.accessControl.ensure_task_action('escalate_task', input.task_id, input.agent_id);

    const task = this.taskManager.getTask(input.task_id);
    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${input.task_id}`);
    }

    if (task.status !== 'in_progress') {
      throw new TasksError('invalid_status', 'only in_progress task can be escalated', {
        status: task.status,
      });
    }

    const lock = this.lockManager.get_lock(task.id);
    if (!lock || lock.agent_id !== input.agent_id) {
      throw new TasksError('lock_owner_mismatch', 'lock owned by another agent', {
        task_id: task.id,
        lock_holder: lock?.agent_id ?? null,
      });
    }

    const metadata = {
      ...(task.metadata ?? {}),
      escalation: {
        reason: input.reason,
        category: input.category,
        context: input.context ?? null,
        escalated_at: nowIso(),
      },
    };

    this.db
      .prepare(
        `
        UPDATE tasks
        SET status = ?,
            metadata = ?,
            updated_at = ?,
            version = version + 1
        WHERE id = ?
        `,
      )
      .run('escalated', JSON.stringify(metadata), nowIso(), task.id);

    this.eventEmitter.emit_task_event({
      task_id: task.id,
      event_type: 'status_changed',
      data: {
        from: task.status,
        to: 'escalated',
      },
      triggered_by: input.agent_id,
    });

    this.eventEmitter.emit_task_event({
      task_id: task.id,
      event_type: 'task_escalated',
      data: {
        reason: input.reason,
        category: input.category,
      },
      triggered_by: input.agent_id,
    });

    const parent = task.parent_task_id ? this.taskManager.getTask(task.parent_task_id) : null;

    return {
      task_id: task.id,
      new_status: 'escalated',
      parent_task_id: task.parent_task_id,
      parent_assignee: parent?.assignee ?? null,
    };
  }

  public decompose_task(input: DecomposeTaskInput): {
    parent_task_id: string;
    new_wbs_version: number;
    children: Array<{ task_id: string; title: string; index: number }>;
    dependencies_created: number;
  } {
    this.accessControl.ensure_task_action('decompose_task', input.task_id, input.agent_id);

    const parent = this.taskManager.getTask(input.task_id);
    if (!parent) {
      throw new TasksError('task_not_found', `task not found: ${input.task_id}`);
    }

    if (input.children.length === 0) {
      throw new TasksError('invalid_children', 'children must include at least one item');
    }

    this.validateDecomposeDependencies(input.dependencies ?? [], input.children.length);

    const childIds = input.children.map(() => this.idGenerator.generate('TASK'));
    const now = nowIso();

    const tx = this.db.transaction(() => {
      for (const [index, child] of input.children.entries()) {
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
            childIds[index],
            child.title,
            child.description ?? '',
            'to_do',
            child.priority ?? 'medium',
            'task',
            parent.id,
            parent.goal_id ?? (parent.task_type === 'goal' ? parent.id : null),
            parent.depth + 1,
            parent.phase,
            parent.source_ref,
            child.expected_effort ?? null,
            null,
            1,
            'none',
            parent.project_id,
            parent.sprint_id,
            null,
            JSON.stringify(child.acceptance_criteria ?? []),
            JSON.stringify(null),
            1,
            input.agent_id,
            now,
            now,
          );
      }

      for (const dep of input.dependencies ?? []) {
        this.db
          .prepare(
            `
            INSERT INTO task_dependencies(task_id, depends_on, type, created_at)
            VALUES (?, ?, ?, ?)
            `,
          )
          .run(
            childIds[dep.to_index],
            childIds[dep.from_index],
            dep.type ?? 'finish_to_start',
            now,
          );
      }

      this.db
        .prepare('UPDATE tasks SET wbs_version = wbs_version + 1, updated_at = ? WHERE id = ?')
        .run(now, parent.id);

      this.eventEmitter.emit_task_event({
        task_id: parent.id,
        event_type: 'task_decomposed',
        data: {
          children_count: input.children.length,
          dependencies_count: input.dependencies?.length ?? 0,
        },
        triggered_by: input.agent_id,
      });
    });

    tx();

    const wbsVersion = this.db
      .prepare('SELECT wbs_version FROM tasks WHERE id = ?')
      .get(parent.id) as { wbs_version: number };

    return {
      parent_task_id: parent.id,
      new_wbs_version: wbsVersion.wbs_version,
      children: childIds.map((id, index) => ({
        task_id: id,
        title: input.children[index]?.title ?? '',
        index,
      })),
      dependencies_created: input.dependencies?.length ?? 0,
    };
  }

  public get_subtask_status(input: {
    parent_task_id: string;
    include_escalated?: boolean;
    status_filter?: TaskStatus[];
  }): {
    subtasks: Array<{
      task_id: string;
      title: string;
      status: string;
      assignee: string | null;
      has_children: boolean;
      escalation?: {
        reason: string;
        category: string;
        escalated_at: string;
      };
    }>;
    summary: {
      total: number;
      by_status: Record<string, number>;
    };
    actionable: Array<{
      task_id: string;
      action: 'resolve_escalation' | 'unblock' | 'assign' | 'review';
    }>;
  } {
    const includeEscalated = input.include_escalated ?? true;

    const rows = this.db
      .prepare(
        `
        SELECT id, title, status, assignee, metadata
        FROM tasks
        WHERE parent_task_id = ?
          AND task_type = 'task'
        ORDER BY created_at ASC
        `,
      )
      .all(input.parent_task_id) as Array<{
      id: string;
      title: string;
      status: TaskStatus;
      assignee: string | null;
      metadata: string | null;
    }>;

    const filtered = input.status_filter
      ? rows.filter((row) => input.status_filter?.includes(row.status))
      : rows;

    const subtasks = filtered.map((row) => {
      const hasChildren =
        (
          this.db
            .prepare('SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ?')
            .get(row.id) as { count: number }
        ).count > 0;

      const metadata = parseJson<Record<string, unknown>>(row.metadata, {});
      const escalationRaw = metadata.escalation as
        | { reason?: string; category?: string; escalated_at?: string }
        | undefined;

      return {
        task_id: row.id,
        title: row.title,
        status: row.status,
        assignee: row.assignee,
        has_children: hasChildren,
        escalation:
          includeEscalated && row.status === 'escalated' && escalationRaw
            ? {
                reason: escalationRaw.reason ?? 'unknown',
                category: escalationRaw.category ?? 'unknown',
                escalated_at: escalationRaw.escalated_at ?? '',
              }
            : undefined,
      };
    });

    const byStatus: Record<string, number> = {};
    const actionable: Array<{
      task_id: string;
      action: 'resolve_escalation' | 'unblock' | 'assign' | 'review';
    }> = [];

    for (const subtask of subtasks) {
      byStatus[subtask.status] = (byStatus[subtask.status] ?? 0) + 1;

      if (subtask.status === 'escalated') {
        actionable.push({ task_id: subtask.task_id, action: 'resolve_escalation' });
      } else if (subtask.status === 'blocked') {
        actionable.push({ task_id: subtask.task_id, action: 'unblock' });
      } else if (subtask.status === 'to_do' && !subtask.assignee) {
        actionable.push({ task_id: subtask.task_id, action: 'assign' });
      } else if (subtask.status === 'review') {
        actionable.push({ task_id: subtask.task_id, action: 'review' });
      }
    }

    return {
      subtasks,
      summary: {
        total: subtasks.length,
        by_status: byStatus,
      },
      actionable,
    };
  }

  public delegate_task(input: DelegateTaskInput): {
    task_id: string;
    assigned_to: string;
    claim: {
      new_status: 'in_progress';
      lock_expires_at: string;
    };
  } {
    this.accessControl.ensure_task_action('delegate_task', input.task_id, input.delegator_agent_id);

    const task = this.taskManager.getTask(input.task_id);
    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${input.task_id}`);
    }

    const metadata = {
      ...(task.metadata ?? {}),
      delegation: {
        delegator: input.delegator_agent_id,
        delegate_agent_id: input.delegate_agent_id,
        delegate_backend: input.delegate_backend ?? null,
        instructions: input.instructions,
        delegated_at: nowIso(),
      },
    };

    this.taskManager.updateTask(task.id, { metadata }, input.delegator_agent_id, input.delegator_agent_id);

    this.eventEmitter.emit_task_event({
      task_id: task.id,
      event_type: 'task_delegated',
      data: {
        delegate_agent_id: input.delegate_agent_id,
        delegate_backend: input.delegate_backend ?? null,
      },
      triggered_by: input.delegator_agent_id,
    });

    const claim = this.claim_and_start({
      task_id: task.id,
      agent_id: input.delegate_agent_id,
      relay_session_id: input.relay_session_id,
      lock_duration_ms: input.lock_duration_ms,
    });

    return {
      task_id: task.id,
      assigned_to: input.delegate_agent_id,
      claim: {
        new_status: claim.new_status,
        lock_expires_at: claim.lock.expires_at,
      },
    };
  }

  public stale_lock_cleanup(input: StaleLockCleanupInput): StaleLockCleanupOutput {
    return this.lockManager.stale_lock_cleanup(input);
  }

  public create_quality_gate(input: CreateQualityGateInput, agent_id: string): {
    gate_id: string;
    task_id: string;
    gate_type: string;
    enforcement_level: string;
    created_at: string;
  } {
    this.accessControl.ensure_task_action('update_task', input.task_id, agent_id);

    const gate = this.qualityGateManager.create_quality_gate(input, agent_id);
    return {
      gate_id: gate.id,
      task_id: gate.task_id,
      gate_type: gate.gate_type,
      enforcement_level: gate.enforcement_level,
      created_at: gate.created_at,
    };
  }

  public evaluate_quality_gate(input: {
    gate_id: string;
    result: 'pass' | 'fail';
    evaluator_agent: string;
    evaluator_backend: 'claude' | 'codex' | 'gemini';
    feedback?: string;
    criteria_results?: Array<{ criterion_id: string; result: 'pass' | 'fail'; detail: string }>;
    relay_session_id?: string;
  }) {
    const gate = this.qualityGateManager.get_quality_gate(input.gate_id);
    if (!gate) {
      throw new TasksError('gate_not_found', `quality gate not found: ${input.gate_id}`);
    }

    if (
      !isSystemActor(input.evaluator_agent) &&
      input.evaluator_agent !== gate.checker_agent
    ) {
      this.accessControl.ensure_task_action('update_task', gate.task_id, input.evaluator_agent);
    }

    return this.qualityGateManager.create_gate_evaluation(
      {
        gate_id: input.gate_id,
        result: input.result,
        evaluator_agent: input.evaluator_agent,
        evaluator_backend: input.evaluator_backend,
        feedback: input.feedback,
        criteria_results: input.criteria_results,
        relay_session_id: input.relay_session_id,
      },
      input.evaluator_agent,
    );
  }

  public get_quality_gate(input: { gate_id: string; include_history?: boolean }): {
    gate: QualityGate;
    latest_evaluation: Record<string, unknown> | null;
    history?: Record<string, unknown>[];
    remaining_retries: number;
  } {
    const gate = this.qualityGateManager.get_quality_gate(input.gate_id);
    if (!gate) {
      throw new TasksError('gate_not_found', `quality gate not found: ${input.gate_id}`);
    }

    const evaluations = this.db
      .prepare(
        `
        SELECT id, gate_id, task_id, attempt, result, evaluator_agent,
               evaluator_backend, feedback, criteria_results, relay_session_id, evaluated_at
        FROM gate_evaluations
        WHERE gate_id = ?
        ORDER BY attempt DESC
        `,
      )
      .all(gate.id) as GateEvaluationRow[];

    const history = evaluations.map((evaluation) => ({
      ...evaluation,
      criteria_results: parseJson(evaluation.criteria_results, []),
    }));

    const latest = history[0] ?? null;

    return {
      gate,
      latest_evaluation: latest,
      history: input.include_history ? history : undefined,
      remaining_retries: Math.max(0, gate.max_retries - evaluations.length),
    };
  }

  public list_quality_gates(input: {
    task_id?: string;
    goal_id?: string;
    enforcement_level?: 'required' | 'recommended';
    status?: 'pending' | 'passed' | 'failed';
  }): {
    gates: Array<{
      gate: QualityGate;
      latest_evaluation: Record<string, unknown> | null;
      task_title: string;
    }>;
    summary: {
      total: number;
      passed: number;
      failed: number;
      pending: number;
    };
  } {
    let gates = this.qualityGateManager.list_quality_gates(input.task_id);

    if (input.goal_id) {
      const goalTaskIds = this.db
        .prepare("SELECT id FROM tasks WHERE goal_id = ? AND task_type = 'task'")
        .all(input.goal_id) as Array<{ id: string }>;
      const ids = new Set(goalTaskIds.map((row) => row.id));
      gates = gates.filter((gate) => ids.has(gate.task_id));
    }

    if (input.enforcement_level) {
      gates = gates.filter((gate) => gate.enforcement_level === input.enforcement_level);
    }

    const withLatest = gates.map((gate) => {
      const latest = this.db
        .prepare(
          `
          SELECT id, gate_id, task_id, attempt, result, evaluator_agent,
                 evaluator_backend, feedback, criteria_results, relay_session_id, evaluated_at
          FROM gate_evaluations
          WHERE gate_id = ?
          ORDER BY attempt DESC
          LIMIT 1
          `,
        )
        .get(gate.id) as GateEvaluationRow | undefined;

      const task = this.taskManager.getTask(gate.task_id);
      const latestResult = latest ? latest.result : null;

      return {
        gate,
        latest_evaluation: latest
          ? {
              ...latest,
              criteria_results: parseJson(latest.criteria_results, []),
            }
          : null,
        latest_result: latestResult,
        task_title: task?.title ?? '',
      };
    });

    const filtered = input.status
      ? withLatest.filter((item) => {
          if (input.status === 'pending') {
            return !item.latest_result;
          }
          if (input.status === 'passed') {
            return item.latest_result === 'pass';
          }
          return item.latest_result === 'fail';
        })
      : withLatest;

    const summary = {
      total: filtered.length,
      passed: filtered.filter((item) => item.latest_result === 'pass').length,
      failed: filtered.filter((item) => item.latest_result === 'fail').length,
      pending: filtered.filter((item) => !item.latest_result).length,
    };

    return {
      gates: filtered.map(({ gate, latest_evaluation, task_title }) => ({
        gate,
        latest_evaluation,
        task_title,
      })),
      summary,
    };
  }

  public delete_quality_gate(input: {
    gate_id: string;
    force?: boolean;
    agent_id: string;
  }): {
    gate_id: string;
    task_id: string;
    deleted_evaluations: number;
    gate_status_updated: string;
  } {
    const gate = this.qualityGateManager.get_quality_gate(input.gate_id);
    if (!gate) {
      throw new TasksError('gate_not_found', `quality gate not found: ${input.gate_id}`);
    }

    this.accessControl.ensure_task_action('update_task', gate.task_id, input.agent_id);

    const evaluations = this.db
      .prepare('SELECT COUNT(*) AS count FROM gate_evaluations WHERE gate_id = ?')
      .get(gate.id) as { count: number };

    if (!input.force && evaluations.count > 0) {
      throw new TasksError(
        'gate_has_evaluations',
        'Cannot delete gate with evaluations unless force=true',
        {
          count: evaluations.count,
        },
      );
    }

    this.qualityGateManager.delete_quality_gate(gate.id, input.agent_id);

    const task = this.taskManager.getTask(gate.task_id);
    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${gate.task_id}`);
    }

    return {
      gate_id: gate.id,
      task_id: gate.task_id,
      deleted_evaluations: evaluations.count,
      gate_status_updated: task.gate_status,
    };
  }

  public create_checkpoint(input: {
    project_id: string;
    goal_id?: string;
    trigger_type: 'periodic' | 'milestone' | 'blocker' | 'replan' | 'manual';
    assessment: Record<string, unknown>;
    decisions?: Array<Record<string, unknown>>;
    actions_taken?: Array<Record<string, unknown>>;
    agent_id: string;
  }): {
    checkpoint_id: number;
    goal_id: string | null;
    project_id: string;
    trigger_type: string;
    assessment_summary: {
      progress_percent: number;
      on_track: boolean;
      depth_assessment: string;
    };
    created_at: string;
  } {
    this.ensureCheckpointAccess(input.project_id, input.goal_id ?? null, input.agent_id);

    const created_at = nowIso();
    const info = this.db
      .prepare(
        `
        INSERT INTO checkpoints(
          goal_id, project_id, trigger_type, assessment, decisions, actions_taken, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.goal_id ?? null,
        input.project_id,
        input.trigger_type,
        JSON.stringify(input.assessment),
        JSON.stringify(input.decisions ?? null),
        JSON.stringify(input.actions_taken ?? null),
        created_at,
      );

    return {
      checkpoint_id: Number(info.lastInsertRowid),
      goal_id: input.goal_id ?? null,
      project_id: input.project_id,
      trigger_type: input.trigger_type,
      assessment_summary: {
        progress_percent: Number((input.assessment.progress_percent as number | undefined) ?? 0),
        on_track: Boolean(input.assessment.on_track),
        depth_assessment: String(input.assessment.depth_assessment ?? 'unknown'),
      },
      created_at,
    };
  }

  public list_checkpoints(input: {
    project_id: string;
    goal_id?: string;
    trigger_type?: 'periodic' | 'milestone' | 'blocker' | 'replan' | 'manual';
    limit?: number;
  }): {
    checkpoints: Array<{
      id: number;
      goal_id: string | null;
      trigger_type: string;
      assessment: Record<string, unknown>;
      decisions: Array<Record<string, unknown>>;
      actions_taken: Array<Record<string, unknown>>;
      created_at: string;
    }>;
    total: number;
  } {
    const where: string[] = ['project_id = ?'];
    const values: Array<string | number> = [input.project_id];

    if (input.goal_id) {
      where.push('goal_id = ?');
      values.push(input.goal_id);
    }

    if (input.trigger_type) {
      where.push('trigger_type = ?');
      values.push(input.trigger_type);
    }

    const limit = input.limit ?? 20;

    const rows = this.db
      .prepare(
        `
        SELECT id, goal_id, project_id, trigger_type, assessment, decisions, actions_taken, created_at
        FROM checkpoints
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ?
        `,
      )
      .all(...values, limit) as CheckpointRow[];

    const total = this.db
      .prepare(`SELECT COUNT(*) AS count FROM checkpoints WHERE ${where.join(' AND ')}`)
      .get(...values) as { count: number };

    return {
      checkpoints: rows.map((row) => ({
        id: row.id,
        goal_id: row.goal_id,
        trigger_type: row.trigger_type,
        assessment: parseJson(row.assessment, {}),
        decisions: parseJson(row.decisions, []),
        actions_taken: parseJson(row.actions_taken, []),
        created_at: row.created_at,
      })),
      total: total.count,
    };
  }

  public trigger_replan(input: TriggerReplanInput): {
    goal_id: string;
    new_wbs_version: number;
    checkpoint_id: number;
    previous_progress: number;
    replan_summary: {
      tasks_added: number;
      tasks_removed: number;
      tasks_modified: number;
      dependencies_added: number;
      dependencies_removed: number;
    };
  } {
    const goal = this.taskManager.getTask(input.goal_id);
    if (!goal || goal.task_type !== 'goal') {
      throw new TasksError('goal_not_found', `goal not found: ${input.goal_id}`);
    }

    if (!isSystemActor(input.agent_id)) {
      if (goal.assignee !== input.agent_id && goal.created_by !== input.agent_id) {
        throw new TasksError('access_denied', 'only goal assignee or creator can trigger replan');
      }
    }

    const previous_progress = this.taskManager.getGoalProgressPercent(goal.id);

    const summary = {
      tasks_added: 0,
      tasks_removed: 0,
      tasks_modified: 0,
      dependencies_added: 0,
      dependencies_removed: 0,
    };

    for (const change of input.scope_changes ?? []) {
      if (change.type === 'add_task') {
        const parent_task_id = change.parent_task_id ?? goal.id;
        this.create_task(
          {
            title: change.new_task.title,
            description: change.new_task.description,
            priority: change.new_task.priority,
            expected_effort: change.new_task.expected_effort,
            acceptance_criteria: change.new_task.acceptance_criteria,
            task_type: 'task',
            parent_task_id,
            project_id: goal.project_id,
          },
          input.agent_id,
        );
        summary.tasks_added += 1;
      } else if (change.type === 'modify_task') {
        this.update_task(
          change.task_id,
          {
            title: change.modifications.title,
            priority: change.modifications.priority,
            expected_effort: change.modifications.expected_effort,
            acceptance_criteria: change.modifications.acceptance_criteria,
          },
          input.agent_id,
        );
        summary.tasks_modified += 1;
      } else if (change.type === 'remove_task') {
        this.archive_task({ task_id: change.task_id, agent_id: input.agent_id });
        summary.tasks_removed += 1;
      } else if (change.type === 'add_dependency') {
        this.dependencyResolver.add_dependency({
          task_id: change.task_id,
          depends_on: change.depends_on,
          type: change.dependency_type,
          triggered_by: input.agent_id,
        });
        summary.dependencies_added += 1;
      } else if (change.type === 'remove_dependency') {
        this.dependencyResolver.remove_dependency(
          change.task_id,
          change.depends_on,
          input.agent_id,
        );
        summary.dependencies_removed += 1;
      }
    }

    this.db
      .prepare('UPDATE tasks SET wbs_version = wbs_version + 1, updated_at = ? WHERE id = ?')
      .run(nowIso(), goal.id);

    const current = this.taskManager.getTask(goal.id);
    if (!current) {
      throw new TasksError('goal_not_found', `goal not found after replan: ${goal.id}`);
    }

    const assessment = {
      progress_percent: this.taskManager.getGoalProgressPercent(goal.id),
      reason: input.reason,
      replan_summary: summary,
    };

    const checkpoint = this.create_checkpoint({
      project_id: goal.project_id,
      goal_id: goal.id,
      trigger_type: 'replan',
      assessment,
      decisions: [
        {
          type: 'replan',
          description: input.reason,
          rationale: 'trigger_replan',
        },
      ],
      actions_taken: (input.scope_changes ?? []).map((change) => ({
        type: change.type,
        description: change.description,
      })),
      agent_id: input.agent_id,
    });

    this.eventEmitter.emit_task_event({
      task_id: goal.id,
      event_type: 'replan_triggered',
      data: {
        reason: input.reason,
        replan_summary: summary,
      },
      triggered_by: input.agent_id,
    });

    return {
      goal_id: goal.id,
      new_wbs_version: current.wbs_version,
      checkpoint_id: checkpoint.checkpoint_id,
      previous_progress,
      replan_summary: summary,
    };
  }

  public create_goal(input: {
    title: string;
    description?: string;
    project_id: string;
    acceptance_criteria?: CreateTaskInput['acceptance_criteria'];
    source_ref?: string;
    priority?: Task['priority'];
    agent_id: string;
  }): {
    goal_id: string;
    title: string;
    acceptance_criteria: CreateTaskInput['acceptance_criteria'];
    created_at: string;
  } {
    const goal = this.create_task(
      {
        title: input.title,
        description: input.description,
        project_id: input.project_id,
        acceptance_criteria: input.acceptance_criteria,
        source_ref: input.source_ref,
        priority: input.priority,
        task_type: 'goal',
        assignee: input.agent_id,
      },
      input.agent_id,
    );

    return {
      goal_id: goal.id,
      title: goal.title,
      acceptance_criteria: goal.acceptance_criteria,
      created_at: goal.created_at,
    };
  }

  public get_goal_progress(input: { goal_id: string; include_tree?: boolean }): {
    goal_id: string;
    title: string;
    status: string;
    progress_percent: number;
    wbs_version: number;
    tasks_summary: {
      total: number;
      by_status: Record<string, number>;
      by_depth: Record<number, number>;
    };
    quality_summary: {
      gates_total: number;
      gates_passed: number;
      gates_failed: number;
      gates_pending: number;
      pass_rate: number;
    };
    acceptance_summary: {
      total: number;
      verified: number;
      unverified: number;
      verification_rate: number;
    };
    depth_metrics: {
      avg_actual_effort_ms: number | null;
      effort_accuracy: number | null;
      child_task_ratio: number;
      checkpoint_count: number;
      replan_count: number;
    };
    tree?: GoalTreeNode[];
  } {
    const goal = this.taskManager.getTask(input.goal_id);
    if (!goal || goal.task_type !== 'goal') {
      throw new TasksError('goal_not_found', `goal not found: ${input.goal_id}`);
    }

    const tasks = this.db
      .prepare(
        `
        SELECT *
        FROM tasks
        WHERE id = ?
           OR goal_id = ?
        ORDER BY depth ASC, created_at ASC
        `,
      )
      .all(goal.id, goal.id) as Task[];

    const taskOnly = tasks.filter((task) => task.task_type === 'task');

    const by_status: Record<string, number> = {};
    const by_depth: Record<number, number> = {};

    for (const task of taskOnly) {
      by_status[task.status] = (by_status[task.status] ?? 0) + 1;
      by_depth[task.depth] = (by_depth[task.depth] ?? 0) + 1;
    }

    const gates = this.list_quality_gates({ goal_id: goal.id });
    const pass_rate =
      gates.summary.total === 0 ? 0 : roundToTwo((gates.summary.passed / gates.summary.total) * 100);

    const criteria = taskOnly.flatMap((task) => task.acceptance_criteria ?? []);
    const verified = criteria.filter((criterion) => criterion.verified).length;

    const avg_actual_effort_ms =
      taskOnly.filter((task) => task.actual_effort_ms !== null).length === 0
        ? null
        : roundToTwo(
            taskOnly
              .filter((task) => task.actual_effort_ms !== null)
              .reduce((sum, task) => sum + Number(task.actual_effort_ms ?? 0), 0) /
              taskOnly.filter((task) => task.actual_effort_ms !== null).length,
          );

    const effortAccuracyCandidates = taskOnly.filter(
      (task) => task.actual_effort_ms !== null && task.expected_effort !== null,
    );

    const effort_accuracy =
      effortAccuracyCandidates.length === 0
        ? null
        : roundToTwo(
            effortAccuracyCandidates.reduce((sum, task) => {
              const expected = expectedEffortToMs(task.expected_effort as ExpectedEffort);
              return sum + Number(task.actual_effort_ms ?? 0) / expected;
            }, 0) / effortAccuracyCandidates.length,
          );

    const taskIdsWithChildren = new Set(
      (
        this.db
          .prepare(
            `
            SELECT DISTINCT parent_task_id
            FROM tasks
            WHERE goal_id = ?
              AND parent_task_id IS NOT NULL
            `,
          )
          .all(goal.id) as Array<{ parent_task_id: string }>
      ).map((row) => row.parent_task_id),
    );

    const checkpointCount = (
      this.db
        .prepare('SELECT COUNT(*) AS count FROM checkpoints WHERE goal_id = ?')
        .get(goal.id) as { count: number }
    ).count;

    const replanCount = (
      this.db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM checkpoints
          WHERE goal_id = ?
            AND trigger_type = 'replan'
          `,
        )
        .get(goal.id) as { count: number }
    ).count;

    return {
      goal_id: goal.id,
      title: goal.title,
      status: goal.status,
      progress_percent: this.taskManager.getGoalProgressPercent(goal.id),
      wbs_version: goal.wbs_version,
      tasks_summary: {
        total: taskOnly.length,
        by_status,
        by_depth,
      },
      quality_summary: {
        gates_total: gates.summary.total,
        gates_passed: gates.summary.passed,
        gates_failed: gates.summary.failed,
        gates_pending: gates.summary.pending,
        pass_rate,
      },
      acceptance_summary: {
        total: criteria.length,
        verified,
        unverified: criteria.length - verified,
        verification_rate:
          criteria.length === 0 ? 0 : roundToTwo((verified / Math.max(1, criteria.length)) * 100),
      },
      depth_metrics: {
        avg_actual_effort_ms,
        effort_accuracy,
        child_task_ratio:
          taskOnly.length === 0
            ? 0
            : roundToTwo((taskIdsWithChildren.size / Math.max(1, taskOnly.length)) * 100),
        checkpoint_count: checkpointCount,
        replan_count: replanCount,
      },
      tree: input.include_tree
        ? this.list_goal_tree({ goal_id: goal.id, max_depth: -1 }).goal.children
        : undefined,
    };
  }

  public list_goal_tree(input: {
    goal_id: string;
    max_depth?: number;
    status_filter?: TaskStatus[];
    format?: 'tree' | 'flat';
  }): {
    goal: GoalTreeNode;
    summary: {
      total_tasks: number;
      total_child_tasks: number;
      progress_percent: number;
    };
    flat: Array<{
      task_id: string;
      title: string;
      depth: number;
      status: string;
      parent_task_id: string | null;
    }>;
  } {
    const goal = this.taskManager.getTask(input.goal_id);
    if (!goal || goal.task_type !== 'goal') {
      throw new TasksError('goal_not_found', `goal not found: ${input.goal_id}`);
    }

    const rows = this.db
      .prepare(
        `
        SELECT id, title, task_type, status, depth, expected_effort, gate_status, parent_task_id
        FROM tasks
        WHERE id = ?
           OR goal_id = ?
        ORDER BY depth ASC, created_at ASC
        `,
      )
      .all(goal.id, goal.id) as Array<{
      id: string;
      title: string;
      task_type: string;
      status: TaskStatus;
      depth: number;
      expected_effort: string | null;
      gate_status: string;
      parent_task_id: string | null;
    }>;

    const max_depth = input.max_depth ?? 2;

    const nodeMap = new Map<string, GoalTreeNode>();
    for (const row of rows) {
      if (max_depth >= 0 && row.depth > max_depth) {
        continue;
      }

      if (input.status_filter && !input.status_filter.includes(row.status)) {
        continue;
      }

      const deps = this.dependencyResolver.list_dependencies(row.id);
      const blocked_by = deps.upstream.filter(
        (upstream) => !this.dependencyResolver.are_dependencies_resolved(row.id) && upstream !== row.id,
      );

      nodeMap.set(row.id, {
        task_id: row.id,
        title: row.title,
        task_type: row.task_type,
        status: row.status,
        depth: row.depth,
        expected_effort: row.expected_effort,
        gate_status: row.gate_status,
        is_ready: row.status === 'to_do' && this.dependencyResolver.are_dependencies_resolved(row.id),
        blocked_by,
        depends_on: deps.upstream,
        children: [],
      });
    }

    for (const row of rows) {
      if (!nodeMap.has(row.id) || !row.parent_task_id) {
        continue;
      }
      const parent = nodeMap.get(row.parent_task_id);
      const child = nodeMap.get(row.id);
      if (parent && child) {
        parent.children.push(child);
      }
    }

    const root = nodeMap.get(goal.id);
    if (!root) {
      throw new TasksError('goal_not_found', `goal tree root missing: ${goal.id}`);
    }

    const flat = Array.from(nodeMap.values())
      .filter((node) => node.task_id !== goal.id)
      .map((node) => {
        const parent = rows.find((row) => row.id === node.task_id)?.parent_task_id ?? null;
        return {
          task_id: node.task_id,
          title: node.title,
          depth: node.depth,
          status: node.status,
          parent_task_id: parent,
        };
      });

    return {
      goal: root,
      summary: {
        total_tasks: flat.length,
        total_child_tasks: flat.filter((task) => task.depth > 1).length,
        progress_percent: this.taskManager.getGoalProgressPercent(goal.id),
      },
      flat,
    };
  }

  public get_execution_view(input: { goal_id: string }): {
    ready: Task[];
    in_progress: Task[];
    blocked: Array<Task & { blocked_by: string[] }>;
    done: Task[];
    dependency_edges: Array<{ from: string; to: string; type: 'finish_to_start' | 'start_to_start' }>;
  } {
    const goal = this.taskManager.getTask(input.goal_id);
    if (!goal || goal.task_type !== 'goal') {
      throw new TasksError('goal_not_found', `goal not found: ${input.goal_id}`);
    }

    const tasks = this.taskManager
      .listTasks({ goal_id: goal.id, task_type: 'task', limit: 10_000 })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    const ready = tasks.filter(
      (task) => task.status === 'to_do' && this.dependencyResolver.are_dependencies_resolved(task.id),
    );

    const in_progress = tasks.filter((task) => task.status === 'in_progress');

    const blocked = tasks
      .filter(
        (task) =>
          task.status === 'blocked' ||
          (task.status === 'to_do' && !this.dependencyResolver.are_dependencies_resolved(task.id)),
      )
      .map((task) => {
        const unresolved = this.dependencyResolver
          .list_dependencies(task.id)
          .upstream.filter((upstreamId) => {
            const upstream = this.taskManager.getTask(upstreamId);
            return upstream ? upstream.status !== 'done' && upstream.status !== 'archived' : false;
          });

        return {
          ...task,
          blocked_by: unresolved,
        };
      });

    const done = tasks.filter((task) => task.status === 'done' || task.status === 'archived');

    const taskSet = new Set(tasks.map((task) => task.id));
    const dependency_edges = (
      this.db
        .prepare(
          `
          SELECT task_id, depends_on, type
          FROM task_dependencies
          `,
        )
        .all() as Array<{ task_id: string; depends_on: string; type: 'finish_to_start' | 'start_to_start' }>
    )
      .filter((edge) => taskSet.has(edge.task_id) && taskSet.has(edge.depends_on))
      .map((edge) => ({
        from: edge.depends_on,
        to: edge.task_id,
        type: edge.type,
      }));

    return {
      ready,
      in_progress,
      blocked,
      done,
      dependency_edges,
    };
  }

  public dashboard(input: { project_id: string }): {
    project_id: string;
    goals: Array<{
      goal_id: string;
      title: string;
      progress_percent: number;
      tasks_summary: {
        total: number;
        done: number;
        in_progress: number;
        blocked: number;
        by_status: Record<string, number>;
      };
      quality_summary: {
        gates_total: number;
        gates_passed: number;
        gates_failed: number;
        gates_pending: number;
        pass_rate: number;
        aggregate_status: 'none' | 'pending' | 'failed' | 'passed';
      };
      depth_metrics: { avg_effort_ms: number | null; child_task_ratio: number };
      wbs_version: number;
      ready_count: number;
      blocked_count: number;
    }>;
    quality_overview: {
      total_gates: number;
      passed: number;
      failed: number;
      pending: number;
      overall_pass_rate: number;
    };
    latest_checkpoint: {
      id: number;
      trigger_type: string;
      on_track: boolean;
      depth_assessment: string;
      created_at: string;
    } | null;
  } {
    const goals = this.taskManager.listTasks({
      project_id: input.project_id,
      task_type: 'goal',
      limit: 10_000,
    });

    const goalItems = goals.map((goal) => {
      const tasks = this.taskManager.listTasks({
        goal_id: goal.id,
        task_type: 'task',
        limit: 10_000,
      });

      const doneCount = tasks.filter((task) => task.status === 'done' || task.status === 'archived').length;
      const inProgressCount = tasks.filter((task) => task.status === 'in_progress').length;
      const blockedCount = tasks.filter((task) => task.status === 'blocked').length;
      const byStatus = tasks.reduce<Record<string, number>>((acc, task) => {
        acc[task.status] = (acc[task.status] ?? 0) + 1;
        return acc;
      }, {});

      const readyCount = tasks.filter(
        (task) => task.status === 'to_do' && this.dependencyResolver.are_dependencies_resolved(task.id),
      ).length;

      const gates = this.list_quality_gates({ goal_id: goal.id });
      const passRate =
        gates.summary.total === 0 ? 0 : roundToTwo((gates.summary.passed / gates.summary.total) * 100);
      const aggregateStatus: 'none' | 'pending' | 'failed' | 'passed' =
        gates.summary.total === 0
          ? 'none'
          : gates.summary.failed > 0
            ? 'failed'
            : gates.summary.pending > 0
              ? 'pending'
              : 'passed';

      const avgEffortCandidates = tasks.filter((task) => task.actual_effort_ms !== null);
      const avgEffort =
        avgEffortCandidates.length === 0
          ? null
          : roundToTwo(
              avgEffortCandidates.reduce((sum, task) => sum + Number(task.actual_effort_ms ?? 0), 0) /
                avgEffortCandidates.length,
            );

      const childCarrier = new Set(
        (
          this.db
            .prepare('SELECT DISTINCT parent_task_id FROM tasks WHERE goal_id = ? AND parent_task_id IS NOT NULL')
            .all(goal.id) as Array<{ parent_task_id: string }>
        ).map((row) => row.parent_task_id),
      );

      return {
        goal_id: goal.id,
        title: goal.title,
        progress_percent: this.taskManager.getGoalProgressPercent(goal.id),
        tasks_summary: {
          total: tasks.length,
          done: doneCount,
          in_progress: inProgressCount,
          blocked: blockedCount,
          by_status: byStatus,
        },
        quality_summary: {
          gates_total: gates.summary.total,
          gates_passed: gates.summary.passed,
          gates_failed: gates.summary.failed,
          gates_pending: gates.summary.pending,
          pass_rate: passRate,
          aggregate_status: aggregateStatus,
        },
        depth_metrics: {
          avg_effort_ms: avgEffort,
          child_task_ratio:
            tasks.length === 0 ? 0 : roundToTwo((childCarrier.size / Math.max(tasks.length, 1)) * 100),
        },
        wbs_version: goal.wbs_version,
        ready_count: readyCount,
        blocked_count: blockedCount,
      };
    });

    const overallGates = this.list_quality_gates({});

    const latestCheckpoint = this.db
      .prepare(
        `
        SELECT id, trigger_type, assessment, created_at
        FROM checkpoints
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT 1
        `,
      )
      .get(input.project_id) as
      | { id: number; trigger_type: string; assessment: string; created_at: string }
      | undefined;

    return {
      project_id: input.project_id,
      goals: goalItems,
      quality_overview: {
        total_gates: overallGates.summary.total,
        passed: overallGates.summary.passed,
        failed: overallGates.summary.failed,
        pending: overallGates.summary.pending,
        overall_pass_rate:
          overallGates.summary.total === 0
            ? 0
            : roundToTwo((overallGates.summary.passed / overallGates.summary.total) * 100),
      },
      latest_checkpoint: latestCheckpoint
        ? {
            id: latestCheckpoint.id,
            trigger_type: latestCheckpoint.trigger_type,
            on_track: Boolean(parseJson<Record<string, unknown>>(latestCheckpoint.assessment, {}).on_track),
            depth_assessment: String(
              parseJson<Record<string, unknown>>(latestCheckpoint.assessment, {}).depth_assessment ??
                'unknown',
            ),
            created_at: latestCheckpoint.created_at,
          }
        : null,
    };
  }

  private normalizeLimit(value: number | undefined, fallback: number): number {
    if (value === undefined) {
      return fallback;
    }

    if (!Number.isFinite(value)) {
      return fallback;
    }

    return Math.min(500, Math.max(1, Math.trunc(value)));
  }

  private parseCursor(cursor: string | undefined): number {
    if (!cursor) {
      return 0;
    }

    if (!/^\d+$/.test(cursor)) {
      throw new TasksError('invalid_cursor', 'cursor must be a non-negative integer string');
    }

    const parsed = Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new TasksError('invalid_cursor', 'cursor is too large');
    }

    return parsed;
  }

  private selectEventsAfterCursor(
    cursor: number,
    input: {
      event_types?: string[];
      project_id?: string;
      limit: number;
    },
  ): TaskEventRow[] {
    const where: string[] = ['e.id > ?'];
    const values: Array<string | number> = [cursor];

    if (input.project_id) {
      where.push('t.project_id = ?');
      values.push(input.project_id);
    }
    if (input.event_types && input.event_types.length > 0) {
      where.push(`e.event_type IN (${input.event_types.map(() => '?').join(', ')})`);
      values.push(...input.event_types);
    }

    const joins = input.project_id ? 'JOIN tasks t ON t.id = e.task_id' : '';
    const sql = [
      'SELECT e.id, e.task_id, e.event_type, e.data, e.triggered_by, e.created_at',
      'FROM task_events e',
      joins,
      `WHERE ${where.join(' AND ')}`,
      'ORDER BY e.id ASC',
      'LIMIT ?',
    ]
      .filter(Boolean)
      .join(' ');

    return this.db.prepare(sql).all(...values, input.limit) as TaskEventRow[];
  }

  private toTaskEvent(row: TaskEventRow): TaskEvent {
    return {
      id: row.id,
      task_id: row.task_id,
      event_type: row.event_type,
      data: parseJson(row.data, null as Record<string, unknown> | null),
      triggered_by: row.triggered_by,
      created_at: row.created_at,
    };
  }

  private resolveDatabasePath(): string {
    const rows = this.db
      .prepare('PRAGMA database_list')
      .all() as Array<{ name: string; file: string }>;
    const main = rows.find((row) => row.name === 'main');
    if (!main || !main.file) {
      throw new TasksError(
        'db_path_unavailable',
        'database path is unavailable for migration tools',
      );
    }

    return main.file;
  }

  private ensureChildTasksDone(task_id: string): void {
    const incompleteChildren = this.db
      .prepare(
        `
        SELECT id
        FROM tasks
        WHERE parent_task_id = ?
          AND task_type = 'task'
          AND status NOT IN ('done', 'archived')
        `,
      )
      .all(task_id) as Array<{ id: string }>;

    if (incompleteChildren.length > 0) {
      throw new TasksError(
        'children_not_complete',
        'Child tasks must be done or archived before completing parent task',
        {
          incomplete_children: incompleteChildren.map((child) => child.id),
        },
      );
    }
  }

  private validateDecomposeDependencies(
    dependencies: Array<{ from_index: number; to_index: number }>,
    childCount: number,
  ): void {
    const adjacency = new Map<number, number[]>();

    for (const dep of dependencies) {
      if (dep.from_index === dep.to_index) {
        throw new TasksError('invalid_dependency', 'from_index and to_index must be different');
      }
      if (
        dep.from_index < 0 ||
        dep.to_index < 0 ||
        dep.from_index >= childCount ||
        dep.to_index >= childCount
      ) {
        throw new TasksError('invalid_dependency', 'dependency index out of bounds');
      }

      const outgoing = adjacency.get(dep.from_index) ?? [];
      outgoing.push(dep.to_index);
      adjacency.set(dep.from_index, outgoing);
    }

    const visiting = new Set<number>();
    const visited = new Set<number>();

    const dfs = (node: number): boolean => {
      if (visiting.has(node)) {
        return true;
      }
      if (visited.has(node)) {
        return false;
      }

      visiting.add(node);
      for (const next of adjacency.get(node) ?? []) {
        if (dfs(next)) {
          return true;
        }
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    };

    for (let index = 0; index < childCount; index += 1) {
      if (dfs(index)) {
        throw new TasksError('cyclic_dependency', 'dependencies include cycle');
      }
    }
  }

  private unblockResolvedDependents(task_id: string, triggered_by: string): void {
    const dependents = this.db
      .prepare('SELECT task_id FROM task_dependencies WHERE depends_on = ?')
      .all(task_id) as Array<{ task_id: string }>;

    for (const dependent of dependents) {
      const target = this.taskManager.getTask(dependent.task_id);
      if (!target || target.status !== 'blocked') {
        continue;
      }

      if (!this.dependencyResolver.are_dependencies_resolved(target.id)) {
        continue;
      }

      const lock = this.lockManager.get_lock(target.id);
      const now = nowIso();
      this.db
        .prepare(
          `
          UPDATE tasks
          SET status = ?,
              updated_at = ?,
              version = version + 1
          WHERE id = ?
          `,
        )
        .run('to_do', now, target.id);

      this.db.prepare('DELETE FROM task_locks WHERE task_id = ?').run(target.id);

      if (lock) {
        this.eventEmitter.emit_task_event({
          task_id: target.id,
          event_type: 'unlocked',
          data: {
            released_by: triggered_by,
            reason: 'dependency_resolved',
          },
          triggered_by,
        });
      }

      this.eventEmitter.emit_task_event({
        task_id: target.id,
        event_type: 'status_changed',
        data: {
          from: target.status,
          to: 'to_do',
          reason: 'dependency_resolved',
        },
        triggered_by,
      });

      this.eventEmitter.emit_task_event({
        task_id: target.id,
        event_type: 'dependency_resolved',
        data: {
          depends_on: task_id,
        },
        triggered_by,
      });

      this.eventEmitter.emit_task_event({
        task_id: target.id,
        event_type: 'unblocked',
        data: {
          reason: 'dependency_resolved',
        },
        triggered_by,
      });
    }
  }

  private maybeRunCleanup(task_id: string, triggered_by: string): CleanupResult | undefined {
    const task = this.taskManager.getTask(task_id);
    if (!task) {
      return undefined;
    }

    const goal_id =
      task.task_type === 'goal'
        ? task.id
        : task.goal_id;
    if (!goal_id) {
      return undefined;
    }

    const goalCleanup = this.cleanupGoalIfReady(goal_id, triggered_by);
    if (!goalCleanup) {
      return undefined;
    }

    const projectCleanup = this.cleanupProjectIfReady(goalCleanup.project_id);
    return {
      goal_cleaned: goalCleanup.result,
      ...(projectCleanup ? { project_cleaned: projectCleanup } : {}),
    };
  }

  private cleanupGoalIfReady(
    goal_id: string,
    triggered_by: string,
  ): { result: GoalCleanupResult; project_id: string } | null {
    const goal = this.taskManager.getTask(goal_id);
    if (!goal || goal.task_type !== 'goal' || goal.status === 'archived') {
      return null;
    }

    const tasks = this.db
      .prepare(
        `
        SELECT id, title, status, depth, actual_effort_ms, metadata
        FROM tasks
        WHERE goal_id = ?
          AND task_type = 'task'
        ORDER BY created_at ASC
        `,
      )
      .all(goal.id) as Array<{
      id: string;
      title: string;
      status: TaskStatus;
      depth: number;
      actual_effort_ms: number | null;
      metadata: string | null;
    }>;

    if (tasks.length === 0) {
      return null;
    }

    if (tasks.some((task) => task.status === 'in_progress')) {
      return null;
    }

    const lockCount = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM task_locks
        WHERE task_id IN (${[goal.id, ...tasks.map((task) => task.id)].map(() => '?').join(', ')})
        `,
      )
      .get(goal.id, ...tasks.map((task) => task.id)) as { count: number };

    if (lockCount.count > 0) {
      return null;
    }

    const allCompleted = tasks.every((task) => task.status === 'done' || task.status === 'archived');
    if (!allCompleted) {
      return null;
    }

    const totalEffortRaw = tasks.reduce((sum, task) => sum + (task.actual_effort_ms ?? 0), 0);
    const hasEffort = tasks.some((task) => task.actual_effort_ms !== null);
    const summary: GoalCleanupResult['summary'] = {
      total_tasks: tasks.length,
      total_effort_ms: hasEffort ? totalEffortRaw : null,
      result_summaries: tasks.map((task) => {
        const metadata = parseJson<Record<string, unknown>>(task.metadata, {});
        const completion = (metadata.completion ?? {}) as Record<string, unknown>;
        return {
          task_id: task.id,
          title: task.title,
          summary: typeof completion.result_summary === 'string' ? completion.result_summary : null,
        };
      }),
    };

    const now = nowIso();
    const goalMetadata = {
      ...(goal.metadata ?? {}),
      cleanup_summary: {
        ...summary,
        cleaned_at: now,
      },
    };

    const tx = this.db.transaction(() => {
      if (goal.status !== 'done') {
        this.db
          .prepare(
            `
            UPDATE tasks
            SET status = ?,
                metadata = ?,
                updated_at = ?,
                version = version + 1
            WHERE id = ?
            `,
          )
          .run('done', JSON.stringify(goalMetadata), now, goal.id);

        this.eventEmitter.emit_task_event({
          task_id: goal.id,
          event_type: 'status_changed',
          data: {
            from: goal.status,
            to: 'done',
            reason: 'goal_cleanup',
          },
          triggered_by,
        });
      } else {
        this.db
          .prepare(
            `
            UPDATE tasks
            SET metadata = ?,
                updated_at = ?,
                version = version + 1
            WHERE id = ?
            `,
          )
          .run(JSON.stringify(goalMetadata), now, goal.id);
      }

      const deleteById = this.db.prepare('DELETE FROM tasks WHERE id = ?');
      for (const task of [...tasks].sort((a, b) => b.depth - a.depth)) {
        deleteById.run(task.id);
      }
    });

    tx();

    return {
      result: {
        goal_id: goal.id,
        title: goal.title,
        tasks_deleted: tasks.map((task) => task.id),
        summary,
      },
      project_id: goal.project_id,
    };
  }

  private cleanupProjectIfReady(project_id: string): ProjectCleanupResult | null {
    const project = this.db
      .prepare('SELECT id, name FROM projects WHERE id = ? LIMIT 1')
      .get(project_id) as { id: string; name: string } | undefined;

    if (!project) {
      return null;
    }

    const goals = this.db
      .prepare(
        `
        SELECT id, status, metadata
        FROM tasks
        WHERE project_id = ?
          AND task_type = 'goal'
        ORDER BY created_at ASC
        `,
      )
      .all(project.id) as Array<{ id: string; status: TaskStatus; metadata: string | null }>;

    if (goals.length === 0) {
      return null;
    }

    if (!goals.every((goal) => goal.status === 'done')) {
      return null;
    }

    const inProgress = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM tasks
        WHERE project_id = ?
          AND status = 'in_progress'
        `,
      )
      .get(project.id) as { count: number };
    if (inProgress.count > 0) {
      return null;
    }

    const locks = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM task_locks l
        JOIN tasks t ON t.id = l.task_id
        WHERE t.project_id = ?
        `,
      )
      .get(project.id) as { count: number };
    if (locks.count > 0) {
      return null;
    }

    let total_tasks = 0;
    let total_effort_sum = 0;
    let hasEffort = false;

    for (const goal of goals) {
      const metadata = parseJson<Record<string, unknown>>(goal.metadata, {});
      const cleanup = (metadata.cleanup_summary ?? {}) as Record<string, unknown>;

      const summaryTasks =
        typeof cleanup.total_tasks === 'number' && Number.isFinite(cleanup.total_tasks)
          ? Math.max(0, Math.trunc(cleanup.total_tasks))
          : 0;
      const summaryEffort =
        typeof cleanup.total_effort_ms === 'number' && Number.isFinite(cleanup.total_effort_ms)
          ? Math.max(0, cleanup.total_effort_ms)
          : null;

      total_tasks += summaryTasks;
      if (summaryEffort !== null) {
        total_effort_sum += summaryEffort;
        hasEffort = true;
      }
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
          DELETE FROM tasks
          WHERE project_id = ?
            AND task_type = 'task'
          `,
        )
        .run(project.id);

      this.db
        .prepare(
          `
          DELETE FROM tasks
          WHERE project_id = ?
            AND task_type = 'goal'
          `,
        )
        .run(project.id);

      this.db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    });

    tx();

    return {
      project_id: project.id,
      name: project.name,
      goals_deleted: goals.map((goal) => goal.id),
      summary: {
        total_goals: goals.length,
        total_tasks,
        total_effort_ms: hasEffort ? total_effort_sum : null,
      },
    };
  }

  private ensureCheckpointAccess(project_id: string, goal_id: string | null, agent_id: string): void {
    if (isSystemActor(agent_id)) {
      return;
    }

    if (goal_id) {
      const goal = this.taskManager.getTask(goal_id);
      if (!goal || goal.task_type !== 'goal') {
        throw new TasksError('goal_not_found', `goal not found: ${goal_id}`);
      }

      if (goal.assignee !== agent_id && goal.created_by !== agent_id) {
        throw new TasksError('access_denied', 'only goal assignee or creator can create checkpoint');
      }
      return;
    }

    const owned = this.db
      .prepare(
        `
        SELECT 1
        FROM tasks
        WHERE project_id = ?
          AND (assignee = ? OR created_by = ?)
        LIMIT 1
        `,
      )
      .get(project_id, agent_id, agent_id) as { 1: number } | undefined;

    if (!owned) {
      throw new TasksError('access_denied', 'project checkpoint requires ownership in project');
    }
  }
}
