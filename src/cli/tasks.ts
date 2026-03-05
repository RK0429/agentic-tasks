#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import {
  DependencyResolver,
  EventEmitter,
  IdGenerator,
  QualityGateManager,
  TaskManager,
  TasksRuntime,
  TasksError,
} from '../core/index.js';
import { openDatabase } from '../db/index.js';
import { startMcpServer } from '../mcp-server/index.js';
import { exportSqliteToMdtm, importMdtmToSqlite, verifyMigration } from '../migration/index.js';
import type {
  DeliveryPhase,
  DependencyType,
  ExpectedEffort,
  TaskPriority,
  TaskStatus,
  TaskType,
} from '../types/index.js';

const DEFAULT_DB_PATH = path.resolve(process.cwd(), '.tasks/agentic-tasks.db');

interface Context {
  close: () => void;
  taskManager: TaskManager;
  dependencyResolver: DependencyResolver;
  runtime: TasksRuntime;
}

interface TaskCreateCommandOptions {
  title: string;
  description?: string;
  priority?: TaskPriority;
  taskType?: TaskType;
  parentTaskId?: string;
  projectId?: string;
  sprintId?: string;
  phase?: DeliveryPhase;
  sourceRef?: string;
  expectedEffort?: ExpectedEffort;
  assignee?: string;
  acceptanceCriteria?: string;
  metadata?: string;
  createdBy?: string;
  agentId?: string;
}

interface TaskUpdateCommandOptions {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  sprintId?: string;
  assignee?: string;
  acceptanceCriteria?: string;
  metadata?: string;
  phase?: DeliveryPhase;
  sourceRef?: string;
  expectedEffort?: ExpectedEffort;
  actualEffortMs?: string;
  agentId?: string;
}

interface TaskListCommandOptions {
  status?: TaskStatus;
  projectId?: string;
  goalId?: string;
  parentTaskId?: string;
  taskType?: TaskType;
  assignee?: string;
  limit: string;
  offset: string;
}

interface DependencyAddCommandOptions {
  taskId: string;
  dependsOn: string;
  type?: DependencyType;
}

function parseJson(value: string | undefined, fieldName: string): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new TasksError('invalid_json', `${fieldName} must be valid JSON`);
  }
}

function createContext(db_path: string): Context {
  mkdirSync(path.dirname(db_path), { recursive: true });

  const db = openDatabase({ db_path, initialize: true });
  const eventEmitter = new EventEmitter(db);
  const idGenerator = new IdGenerator(db);
  const dependencyResolver = new DependencyResolver(db, eventEmitter);
  const qualityGateManager = new QualityGateManager(db, idGenerator, eventEmitter);
  const taskManager = new TaskManager(db, {
    event_emitter: eventEmitter,
    id_generator: idGenerator,
    dependency_resolver: dependencyResolver,
    quality_gate_manager: qualityGateManager,
  });
  const runtime = new TasksRuntime(db, {
    event_emitter: eventEmitter,
    id_generator: idGenerator,
    dependency_resolver: dependencyResolver,
    quality_gate_manager: qualityGateManager,
    task_manager: taskManager,
  });

  return {
    close: () => db.close(),
    taskManager,
    dependencyResolver,
    runtime,
  };
}

function resolveDbPath(command: Command): string {
  let current: Command | undefined = command;
  while (current?.parent) {
    current = current.parent;
  }
  return current?.opts().db ?? DEFAULT_DB_PATH;
}

function configureTaskCreateCommand(
  command: Command,
  options: {
    requireParentTaskId?: boolean;
  } = {},
): Command {
  const configured = command
    .requiredOption('--title <title>', 'title')
    .option('--description <description>', 'description')
    .option('--priority <priority>', 'priority: critical|high|medium|low', 'medium')
    .option('--task-type <task_type>', 'task_type: goal|task', 'task');

  if (options.requireParentTaskId) {
    configured.requiredOption(
      '--parent-task-id <parent_task_id>',
      'parent_task_id (required for task create)',
    );
  } else {
    configured.option('--parent-task-id <parent_task_id>', 'parent_task_id');
  }

  return configured
    .option('--project-id <project_id>', 'project_id')
    .option('--sprint-id <sprint_id>', 'sprint_id')
    .option('--phase <phase>', 'phase')
    .option('--source-ref <source_ref>', 'source_ref')
    .option('--expected-effort <expected_effort>', 'expected_effort: XS|S|M|L|XL')
    .option('--assignee <assignee>', 'assignee')
    .option('--acceptance-criteria <json>', 'acceptance_criteria JSON array')
    .option('--metadata <json>', 'metadata JSON object')
    .option('--created-by <created_by>', 'created_by');
}

function configureTaskUpdateCommand(command: Command): Command {
  return command
    .option('--title <title>', 'title')
    .option('--description <description>', 'description')
    .option('--status <status>', 'status')
    .option('--priority <priority>', 'priority')
    .option('--sprint-id <sprint_id>', 'sprint_id')
    .option('--assignee <assignee>', 'assignee')
    .option('--acceptance-criteria <json>', 'acceptance_criteria JSON array')
    .option('--metadata <json>', 'metadata JSON object')
    .option('--phase <phase>', 'phase')
    .option('--source-ref <source_ref>', 'source_ref')
    .option('--expected-effort <expected_effort>', 'expected_effort')
    .option('--actual-effort-ms <actual_effort_ms>', 'actual_effort_ms')
    .option('--agent-id <agent_id>', 'agent_id', 'system');
}

function configureTaskListCommand(command: Command): Command {
  return command
    .option('--status <status>', 'status')
    .option('--project-id <project_id>', 'project_id')
    .option('--goal-id <goal_id>', 'goal_id')
    .option('--parent-task-id <parent_task_id>', 'parent_task_id')
    .option('--task-type <task_type>', 'task_type')
    .option('--assignee <assignee>', 'assignee')
    .option('--limit <limit>', 'limit', '100')
    .option('--offset <offset>', 'offset', '0');
}

function runTaskCreate(db_path: string, options: TaskCreateCommandOptions): void {
  const context = createContext(db_path);

  try {
    const task = context.taskManager.createTask({
      title: options.title,
      description: options.description,
      priority: options.priority,
      task_type: options.taskType,
      parent_task_id: options.parentTaskId,
      project_id: options.projectId,
      sprint_id: options.sprintId,
      phase: options.phase,
      source_ref: options.sourceRef,
      expected_effort: options.expectedEffort,
      assignee: options.assignee,
      acceptance_criteria: parseJson(options.acceptanceCriteria, 'acceptance_criteria') as never,
      metadata: parseJson(options.metadata, 'metadata') as never,
      created_by: options.createdBy ?? options.agentId,
    });

    printResult({ success: true, task });
  } finally {
    context.close();
  }
}

function runTaskGet(db_path: string, id: string): void {
  const context = createContext(db_path);

  try {
    const task = context.taskManager.getTask(id);
    if (!task) {
      throw new TasksError('task_not_found', `task not found: ${id}`);
    }
    printResult({ success: true, task });
  } finally {
    context.close();
  }
}

function runTaskUpdate(db_path: string, id: string, options: TaskUpdateCommandOptions): void {
  const context = createContext(db_path);

  try {
    const updates = {
      title: options.title,
      description: options.description,
      status: options.status as TaskStatus | undefined,
      priority: options.priority,
      sprint_id: options.sprintId,
      assignee: options.assignee,
      acceptance_criteria: parseJson(options.acceptanceCriteria, 'acceptance_criteria') as never,
      metadata: parseJson(options.metadata, 'metadata') as never,
      phase: options.phase,
      source_ref: options.sourceRef,
      expected_effort: options.expectedEffort,
      actual_effort_ms: options.actualEffortMs ? Number(options.actualEffortMs) : undefined,
    };

    const task = context.runtime.update_task(id, updates, options.agentId ?? 'system');
    printResult({ success: true, task });
  } finally {
    context.close();
  }
}

function runTaskList(db_path: string, options: TaskListCommandOptions): void {
  const context = createContext(db_path);

  try {
    const tasks = context.taskManager.listTasks({
      status: options.status,
      project_id: options.projectId,
      goal_id: options.goalId,
      parent_task_id: options.parentTaskId,
      task_type: options.taskType,
      assignee: options.assignee,
      limit: Number(options.limit),
      offset: Number(options.offset),
    });

    printResult({ success: true, tasks });
  } finally {
    context.close();
  }
}

function runDependencyAdd(db_path: string, options: DependencyAddCommandOptions): void {
  const context = createContext(db_path);

  try {
    context.dependencyResolver.add_dependency({
      task_id: options.taskId,
      depends_on: options.dependsOn,
      type: options.type,
    });
    printResult({
      success: true,
      dependency: {
        task_id: options.taskId,
        depends_on: options.dependsOn,
        type: options.type ?? 'finish_to_start',
      },
    });
  } finally {
    context.close();
  }
}

function runDependencyList(db_path: string, id: string): void {
  const context = createContext(db_path);

  try {
    const dependencies = context.dependencyResolver.list_dependencies(id);
    printResult({ success: true, task_id: id, dependencies });
  } finally {
    context.close();
  }
}

function printResult(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function handleCliError(error: unknown): never {
  if (error instanceof TasksError) {
    printResult({
      success: false,
      error: {
        code: error.code,
        message: error.message,
      },
      details: error.details,
    });
    process.exit(1);
  }

  const message = error instanceof Error ? error.message : String(error);
  printResult({
    success: false,
    error: {
      code: 'unknown_error',
      message,
    },
  });
  process.exit(1);
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('tasks')
    .description('agentic-tasks CLI')
    .option('--db <path>', 'SQLite database path', DEFAULT_DB_PATH)
    .showHelpAfterError()
    .addHelpText(
      'after',
      `
Examples:
  $ agentic-tasks init
  $ agentic-tasks project create --name 'My Project'
  $ agentic-tasks goal create --title 'Goal 1' --project-id PROJ-001 --agent-id agent1
  $ agentic-tasks task create --title 'Task 1' --parent-task-id GOAL-001 --project-id PROJ-001 --agent-id agent1
  $ agentic-tasks task list --project-id PROJ-001
  $ agentic-tasks next --project-id PROJ-001 --assignee agent1
  $ agentic-tasks dashboard --project-id PROJ-001
`,
    );

  program
    .command('init')
    .description('DB 初期化')
    .action(function action() {
      const db_path = this.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);
      context.close();
      printResult({ success: true, db_path });
    });

  configureTaskCreateCommand(program.command('create').description('タスク作成')).action(function action(options) {
    const db_path = resolveDbPath(this);
    runTaskCreate(db_path, options as TaskCreateCommandOptions);
  });

  program
    .command('get <id>')
    .description('タスク取得')
    .action(function action(id: string) {
      const db_path = resolveDbPath(this);
      runTaskGet(db_path, id);
    });

  configureTaskUpdateCommand(program.command('update <id>').description('タスク更新')).action(
    function action(id: string, options) {
      const db_path = resolveDbPath(this);
      runTaskUpdate(db_path, id, options as TaskUpdateCommandOptions);
    },
  );

  program
    .command('delete <id>')
    .description('タスク削除')
    .action(function action(id: string) {
      const db_path = this.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        context.taskManager.deleteTask(id);
        printResult({ success: true, deleted: true, task_id: id });
      } finally {
        context.close();
      }
    });

  configureTaskListCommand(program.command('list').description('タスク一覧')).action(function action(options) {
    const db_path = resolveDbPath(this);
    runTaskList(db_path, options as TaskListCommandOptions);
  });

  const task = program.command('task').description('タスク操作');

  configureTaskCreateCommand(task.command('create').description('タスク作成（エイリアス）'), {
    requireParentTaskId: true,
  })
    .option('--agent-id <agent_id>', 'agent_id')
    .action(function action(options) {
      const db_path = resolveDbPath(this);
      runTaskCreate(db_path, {
        ...(options as TaskCreateCommandOptions),
        taskType: (options as TaskCreateCommandOptions).taskType ?? 'task',
      });
    });

  configureTaskListCommand(task.command('list').description('タスク一覧（エイリアス）')).action(
    function action(options) {
      const db_path = resolveDbPath(this);
      runTaskList(db_path, options as TaskListCommandOptions);
    },
  );

  configureTaskUpdateCommand(task.command('update <id>').description('タスク更新（エイリアス）')).action(
    function action(id: string, options) {
      const db_path = resolveDbPath(this);
      runTaskUpdate(db_path, id, options as TaskUpdateCommandOptions);
    },
  );

  task
    .command('get <id>')
    .description('タスク取得（エイリアス）')
    .action(function action(id: string) {
      const db_path = resolveDbPath(this);
      runTaskGet(db_path, id);
    });

  const goal = program.command('goal').description('ゴール操作');

  configureTaskCreateCommand(goal.command('create').description('ゴール作成（エイリアス）'))
    .option('--agent-id <agent_id>', 'agent_id')
    .action(function action(options) {
      const db_path = resolveDbPath(this);
      runTaskCreate(db_path, {
        ...(options as TaskCreateCommandOptions),
        taskType: 'goal',
      });
    });

  configureTaskListCommand(goal.command('list').description('ゴール一覧（エイリアス）')).action(
    function action(options) {
      const db_path = resolveDbPath(this);
      runTaskList(db_path, {
        ...(options as TaskListCommandOptions),
        taskType: 'goal',
      });
    },
  );

  program
    .command('dashboard')
    .description('プロジェクトダッシュボード取得')
    .requiredOption('--project-id <project_id>', 'project_id')
    .action(function action(options) {
      const db_path = resolveDbPath(this);
      const context = createContext(db_path);

      try {
        const result = context.runtime.dashboard({
          project_id: options.projectId,
        });
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  program
    .command('next')
    .description('次に着手可能なタスクを取得')
    .option('--project-id <project_id>', 'project_id')
    .option('--assignee <assignee>', 'assignee')
    .action(function action(options) {
      const db_path = resolveDbPath(this);
      const context = createContext(db_path);

      try {
        const task = context.runtime.next_task({
          project_id: options.projectId as string | undefined,
          assignee: options.assignee as string | undefined,
        });
        printResult({ success: true, task });
      } finally {
        context.close();
      }
    });

  program
    .command('assign <task-id>')
    .description('タスクの担当者を割り当て')
    .requiredOption('--assignee <assignee>', 'assignee')
    .requiredOption('--agent-id <agent_id>', 'agent_id')
    .action(function action(taskId: string, options) {
      const db_path = resolveDbPath(this);
      const context = createContext(db_path);

      try {
        const result = context.runtime.assign_task({
          task_id: taskId,
          assignee: options.assignee as string,
          agent_id: options.agentId as string,
        });
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  program
    .command('release <task-id>')
    .description('タスクロックを解放')
    .requiredOption('--agent-id <agent_id>', 'agent_id')
    .action(function action(taskId: string, options) {
      const db_path = resolveDbPath(this);
      const context = createContext(db_path);

      try {
        const result = context.runtime.release_task({
          task_id: taskId,
          agent_id: options.agentId as string,
        });
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  const project = program.command('project').description('プロジェクト操作');

  project
    .command('create')
    .description('プロジェクト作成')
    .requiredOption('--name <name>', 'name')
    .option('--description <description>', 'description')
    .option('--wip-limit <wip_limit>', 'wip_limit', '5')
    .option('--metadata <json>', 'metadata JSON object')
    .action(function action(options) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const result = context.runtime.create_project({
          name: options.name,
          description: options.description,
          wip_limit: Number(options.wipLimit),
          metadata: parseJson(options.metadata, 'metadata') as never,
        });
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  project
    .command('list')
    .description('プロジェクト一覧')
    .action(function action() {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const result = context.runtime.list_projects();
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  project
    .command('get <id>')
    .description('プロジェクト取得')
    .action(function action(id: string) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const result = context.runtime.get_project(id);
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  project
    .command('update <id>')
    .description('プロジェクト更新')
    .option('--name <name>', 'name')
    .option('--description <description>', 'description')
    .option('--wip-limit <wip_limit>', 'wip_limit')
    .option('--metadata <json>', 'metadata JSON object')
    .action(function action(id: string, options) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const updates = {
          name: options.name as string | undefined,
          description: options.description as string | undefined,
          wip_limit: options.wipLimit ? Number(options.wipLimit) : undefined,
          metadata: Object.prototype.hasOwnProperty.call(options, 'metadata')
            ? (parseJson(options.metadata, 'metadata') as never)
            : undefined,
        };
        const result = context.runtime.update_project(id, updates);
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  project
    .command('delete <id>')
    .description('プロジェクト削除')
    .action(function action(id: string) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const result = context.runtime.delete_project(id);
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  const sprint = program.command('sprint').description('スプリント操作');

  sprint
    .command('create')
    .description('スプリント作成')
    .requiredOption('--name <name>', 'name')
    .requiredOption('--project-id <project_id>', 'project_id')
    .requiredOption('--start-date <start_date>', 'start_date (YYYY-MM-DD)')
    .requiredOption('--end-date <end_date>', 'end_date (YYYY-MM-DD)')
    .option('--description <description>', 'description')
    .option('--phase-number <phase_number>', 'phase_number (0-7)', '0')
    .option('--status <status>', 'status: planned|active|completed', 'planned')
    .action(function action(options) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const result = context.runtime.create_sprint({
          project_id: options.projectId,
          name: options.name,
          description: options.description,
          phase_number: Number(options.phaseNumber),
          start_date: options.startDate,
          end_date: options.endDate,
          status: options.status,
        });
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  sprint
    .command('list')
    .description('スプリント一覧')
    .option('--project-id <project_id>', 'project_id')
    .option('--status <status>', 'status: planned|active|completed')
    .action(function action(options) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const result = context.runtime.list_sprints({
          project_id: options.projectId,
          status: options.status,
        });
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  sprint
    .command('complete <id>')
    .description('スプリント完了（未完了タスクをスプリントから外す）')
    .option('--agent-id <agent_id>', 'agent_id', 'system')
    .action(function action(id: string, options) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const result = context.runtime.complete_sprint({
          sprint_id: id,
          agent_id: options.agentId,
        });
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  const schedule = program.command('schedule').description('スケジュール操作');

  schedule
    .command('create')
    .description('スケジュール作成')
    .requiredOption('--name <name>', 'name')
    .requiredOption('--task-template <json>', 'task_template JSON object')
    .requiredOption('--project-id <project_id>', 'project_id')
    .option('--cron <cron>', 'cron expression')
    .option('--cron-expression <cron_expression>', 'cron expression')
    .option('--max-instances <max_instances>', 'max_instances', '1')
    .option('--disabled', 'create as disabled')
    .action(function action(options) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const cron = options.cronExpression ?? options.cron;
        if (!cron) {
          throw new TasksError('invalid_cron_expression', '--cron or --cron-expression is required');
        }

        const result = context.runtime.create_schedule({
          name: options.name,
          cron,
          task_template: parseJson(options.taskTemplate, 'task_template') as never,
          project_id: options.projectId,
          enabled: !options.disabled,
          max_instances: Number(options.maxInstances),
        });
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  schedule
    .command('list')
    .description('スケジュール一覧')
    .option('--project-id <project_id>', 'project_id')
    .action(function action(options) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const result = context.runtime.list_schedules(options.projectId as string | undefined);
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  schedule
    .command('update <id>')
    .description('スケジュール更新')
    .option('--name <name>', 'name')
    .option('--cron <cron>', 'cron expression')
    .option('--cron-expression <cron_expression>', 'cron expression')
    .option('--task-template <json>', 'task_template JSON object')
    .option('--project-id <project_id>', 'project_id')
    .option('--max-instances <max_instances>', 'max_instances')
    .option('--enable', 'enable schedule')
    .option('--disable', 'disable schedule')
    .action(function action(id: string, options) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const cron = options.cronExpression ?? options.cron;
        const enabled =
          options.enable === true ? true : options.disable === true ? false : undefined;

        const result = context.runtime.update_schedule(id, {
          name: options.name as string | undefined,
          cron: cron as string | undefined,
          task_template: options.taskTemplate
            ? (parseJson(options.taskTemplate, 'task_template') as never)
            : undefined,
          project_id: options.projectId as string | undefined,
          max_instances: options.maxInstances ? Number(options.maxInstances) : undefined,
          enabled,
        });
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  schedule
    .command('delete <id>')
    .description('スケジュール削除')
    .action(function action(id: string) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const result = context.runtime.delete_schedule(id);
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  schedule
    .command('run')
    .description('期限到来したスケジュールを手動実行')
    .action(function action() {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const result = context.runtime.run_scheduler();
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  const deps = program.command('deps').description('依存関係操作');

  deps
    .command('add')
    .description('依存関係追加')
    .requiredOption('--task-id <task_id>', 'task_id')
    .requiredOption('--depends-on <depends_on>', 'depends_on')
    .option('--type <type>', 'type: finish_to_start|start_to_start', 'finish_to_start')
    .action(function action(options) {
      const db_path = resolveDbPath(this);
      runDependencyAdd(db_path, options as DependencyAddCommandOptions);
    });

  deps
    .command('list <id>')
    .description('依存関係一覧')
    .action(function action(id: string) {
      const db_path = resolveDbPath(this);
      runDependencyList(db_path, id);
    });

  deps
    .command('resolve [taskId]')
    .description('依存関係の解決状態を確認')
    .option('--task-id <task_id>', 'task_id')
    .action(function action(taskId: string | undefined, options) {
      const resolvedTaskId = taskId ?? (options.taskId as string | undefined);
      if (!resolvedTaskId) {
        throw new TasksError('invalid_task_id', 'task_id is required');
      }

      const db_path = resolveDbPath(this);
      const context = createContext(db_path);

      try {
        const result = context.runtime.resolve_dependencies(resolvedTaskId);
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  deps
    .command('remove')
    .description('依存関係削除')
    .requiredOption('--task-id <task_id>', 'task_id')
    .requiredOption('--depends-on <depends_on>', 'depends_on')
    .option('--agent-id <agent_id>', 'agent_id', 'system')
    .action(function action(options) {
      const db_path = resolveDbPath(this);
      const context = createContext(db_path);

      try {
        const result = context.runtime.remove_dependency({
          task_id: options.taskId,
          depends_on: options.dependsOn,
          agent_id: options.agentId,
        });
        printResult({ success: true, ...result });
      } finally {
        context.close();
      }
    });

  const migrate = program.command('migrate').description('MDTM <-> SQLite migration tools');

  migrate
    .command('import <sourceDir>')
    .description('Import MDTM markdown files into SQLite')
    .option('--default-project-id <project_id>', 'default project id', 'PROJ-001')
    .option('--clear-existing', 'clear existing tasks before import', false)
    .action(function action(sourceDir: string, options) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const result = importMdtmToSqlite({
        source_dir: path.resolve(sourceDir),
        db_path,
        default_project_id: options.defaultProjectId,
        clear_existing: Boolean(options.clearExisting),
      });

      printResult({
        success: true,
        ...result,
      });
    });

  migrate
    .command('export <targetDir>')
    .description('Export SQLite tasks into MDTM markdown format')
    .option('--project-id <project_id>', 'project id filter')
    .action(function action(targetDir: string, options) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const result = exportSqliteToMdtm({
        db_path,
        target_dir: path.resolve(targetDir),
        project_id: options.projectId as string | undefined,
      });

      printResult({
        success: true,
        ...result,
      });
    });

  migrate
    .command('verify')
    .description('Verify migration integrity checks on current SQLite DB')
    .action(function action() {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const result = verifyMigration(db_path);
      printResult({
        success: result.passed,
        ...result,
      });
    });

  // --- MCP Server ---
  const mcp = program.command('mcp').description('MCP server commands');

  mcp
    .command('serve')
    .description('Start MCP server (stdio transport)')
    .action(async function action() {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      await startMcpServer({ db_path });
    });

  await program.parseAsync(process.argv);
}

main().catch(handleCliError);
