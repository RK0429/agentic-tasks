import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';

import {
  AccessControl,
  DependencyResolver,
  EventEmitter,
  IdGenerator,
  LockManager,
  QualityGateManager,
  QueueManager,
  TaskManager,
  TasksRuntime,
  openDatabase,
} from '../src/index.js';

export interface TestContext {
  db: Database.Database;
  db_path: string;
  accessControl: AccessControl;
  taskManager: TaskManager;
  dependencyResolver: DependencyResolver;
  qualityGateManager: QualityGateManager;
  idGenerator: IdGenerator;
  lockManager: LockManager;
  queueManager: QueueManager;
  runtime: TasksRuntime;
  cleanup: () => void;
}

export function createTestContext(): TestContext {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentic-tasks-test-'));
  const db_path = path.join(dir, 'tasks.db');

  const db = openDatabase({ db_path, initialize: true });
  const eventEmitter = new EventEmitter(db);
  const idGenerator = new IdGenerator(db);
  const accessControl = new AccessControl(db);
  const dependencyResolver = new DependencyResolver(db, eventEmitter);
  const qualityGateManager = new QualityGateManager(db, idGenerator, eventEmitter);
  const taskManager = new TaskManager(db, {
    access_control: accessControl,
    event_emitter: eventEmitter,
    id_generator: idGenerator,
    dependency_resolver: dependencyResolver,
    quality_gate_manager: qualityGateManager,
  });
  const lockManager = new LockManager(db, eventEmitter);
  const queueManager = new QueueManager(db, dependencyResolver, eventEmitter);
  const runtime = new TasksRuntime(db, {
    access_control: accessControl,
    dependency_resolver: dependencyResolver,
    event_emitter: eventEmitter,
    id_generator: idGenerator,
    lock_manager: lockManager,
    queue_manager: queueManager,
    quality_gate_manager: qualityGateManager,
    task_manager: taskManager,
  });

  return {
    db,
    db_path,
    accessControl,
    taskManager,
    dependencyResolver,
    qualityGateManager,
    idGenerator,
    lockManager,
    queueManager,
    runtime,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
