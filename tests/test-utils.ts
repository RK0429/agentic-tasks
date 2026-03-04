import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';

import {
  DependencyResolver,
  EventEmitter,
  IdGenerator,
  QualityGateManager,
  TaskManager,
  openDatabase,
} from '../src/index.js';

export interface TestContext {
  db: Database.Database;
  db_path: string;
  taskManager: TaskManager;
  dependencyResolver: DependencyResolver;
  qualityGateManager: QualityGateManager;
  idGenerator: IdGenerator;
  cleanup: () => void;
}

export function createTestContext(): TestContext {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentic-tasks-test-'));
  const db_path = path.join(dir, 'tasks.db');

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
    db,
    db_path,
    taskManager,
    dependencyResolver,
    qualityGateManager,
    idGenerator,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
