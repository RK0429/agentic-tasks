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
  TasksError,
} from '../core/index.js';
import { openDatabase } from '../db/index.js';
import type { TaskStatus } from '../types/index.js';

const DEFAULT_DB_PATH = path.resolve(process.cwd(), '.tasks/agentic-tasks.db');

interface Context {
  close: () => void;
  taskManager: TaskManager;
  dependencyResolver: DependencyResolver;
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

  return {
    close: () => db.close(),
    taskManager,
    dependencyResolver,
  };
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
    .showHelpAfterError();

  program
    .command('init')
    .description('DB 初期化')
    .action(function action() {
      const db_path = this.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);
      context.close();
      printResult({ success: true, db_path });
    });

  program
    .command('create')
    .description('タスク作成')
    .requiredOption('--title <title>', 'title')
    .option('--description <description>', 'description')
    .option('--priority <priority>', 'priority: critical|high|medium|low', 'medium')
    .option('--task-type <task_type>', 'task_type: goal|task', 'task')
    .option('--parent-task-id <parent_task_id>', 'parent_task_id')
    .option('--project-id <project_id>', 'project_id')
    .option('--sprint-id <sprint_id>', 'sprint_id')
    .option('--phase <phase>', 'phase')
    .option('--source-ref <source_ref>', 'source_ref')
    .option('--expected-effort <expected_effort>', 'expected_effort: XS|S|M|L|XL')
    .option('--assignee <assignee>', 'assignee')
    .option('--acceptance-criteria <json>', 'acceptance_criteria JSON array')
    .option('--metadata <json>', 'metadata JSON object')
    .option('--created-by <created_by>', 'created_by')
    .action(function action(options) {
      const db_path = this.parent?.opts().db ?? DEFAULT_DB_PATH;
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
          acceptance_criteria: parseJson(
            options.acceptanceCriteria,
            'acceptance_criteria',
          ) as never,
          metadata: parseJson(options.metadata, 'metadata') as never,
          created_by: options.createdBy,
        });

        printResult({ success: true, task });
      } finally {
        context.close();
      }
    });

  program
    .command('get <id>')
    .description('タスク取得')
    .action(function action(id: string) {
      const db_path = this.parent?.opts().db ?? DEFAULT_DB_PATH;
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
    });

  program
    .command('update <id>')
    .description('タスク更新')
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
    .action(function action(id: string, options) {
      const db_path = this.parent?.opts().db ?? DEFAULT_DB_PATH;
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

        const task = context.taskManager.updateTask(id, updates);
        printResult({ success: true, task });
      } finally {
        context.close();
      }
    });

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

  program
    .command('list')
    .description('タスク一覧')
    .option('--status <status>', 'status')
    .option('--project-id <project_id>', 'project_id')
    .option('--goal-id <goal_id>', 'goal_id')
    .option('--parent-task-id <parent_task_id>', 'parent_task_id')
    .option('--task-type <task_type>', 'task_type')
    .option('--assignee <assignee>', 'assignee')
    .option('--limit <limit>', 'limit', '100')
    .option('--offset <offset>', 'offset', '0')
    .action(function action(options) {
      const db_path = this.parent?.opts().db ?? DEFAULT_DB_PATH;
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
    });

  const deps = program.command('deps').description('依存関係操作');

  deps
    .command('add')
    .description('依存関係追加')
    .requiredOption('--task-id <task_id>', 'task_id')
    .requiredOption('--depends-on <depends_on>', 'depends_on')
    .option('--type <type>', 'type: finish_to_start|start_to_start', 'finish_to_start')
    .action(function action(options) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
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
            type: options.type,
          },
        });
      } finally {
        context.close();
      }
    });

  deps
    .command('list <id>')
    .description('依存関係一覧')
    .action(function action(id: string) {
      const db_path = this.parent?.parent?.opts().db ?? DEFAULT_DB_PATH;
      const context = createContext(db_path);

      try {
        const dependencies = context.dependencyResolver.list_dependencies(id);
        printResult({ success: true, task_id: id, dependencies });
      } finally {
        context.close();
      }
    });

  await program.parseAsync(process.argv);
}

main().catch(handleCliError);
