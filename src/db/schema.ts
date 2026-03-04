import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COUNTER_KEYS } from '../types/index.js';

interface MigrationRecord {
  version: string;
  checksum: string;
  applied_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveMigrationsDirectory(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, 'migrations'),
    path.resolve(process.cwd(), 'src/db/migrations'),
    path.resolve(process.cwd(), 'dist/db/migrations'),
  ];

  const dir = candidates.find((candidate) => existsSync(candidate));
  if (!dir) {
    throw new Error(`migrations directory not found: ${candidates.join(', ')}`);
  }

  return dir;
}

function checksumOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function ensureSchemaMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function applyMigrations(db: Database.Database): void {
  ensureSchemaMigrationsTable(db);

  const migrationsDir = resolveMigrationsDirectory();
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const getApplied = db.prepare<[string], MigrationRecord>(
    'SELECT version, checksum, applied_at FROM schema_migrations WHERE version = ?',
  );

  const insertApplied = db.prepare(
    'INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)',
  );

  for (const fileName of files) {
    const version = path.parse(fileName).name;
    const sql = readFileSync(path.join(migrationsDir, fileName), 'utf8');
    const checksum = checksumOf(sql);
    const existing = getApplied.get(version);

    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(`migration checksum mismatch: ${version}`);
      }
      continue;
    }

    const tx = db.transaction(() => {
      db.exec(sql);
      insertApplied.run(version, checksum, nowIso());
    });

    tx();
  }
}

function seedSystemCounters(db: Database.Database): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO system_counters(counter_key, next_value, updated_at) VALUES (?, ?, ?)',
  );

  const now = nowIso();
  const tx = db.transaction(() => {
    for (const key of COUNTER_KEYS) {
      insert.run(key, 1, now);
    }
  });

  tx();
}

function seedDefaultProject(db: Database.Database): void {
  const project = db.prepare('SELECT id FROM projects LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (project) {
    return;
  }

  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `
      INSERT INTO projects(id, name, description, metadata, wip_limit, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run('PROJ-001', 'Default Project', 'Bootstrapped by tasks init', null, 5, 1, now, now);

    db.prepare(
      `
      UPDATE system_counters
      SET next_value = CASE WHEN counter_key = 'PROJ' AND next_value < 2 THEN 2 ELSE next_value END,
          updated_at = ?
      WHERE counter_key = 'PROJ'
      `,
    ).run(now);
  });

  tx();
}

export interface OpenDatabaseOptions {
  db_path: string;
  initialize?: boolean;
}

export function openDatabase(options: OpenDatabaseOptions): Database.Database {
  const db = new Database(options.db_path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  if (options.initialize ?? true) {
    applyMigrations(db);
    seedSystemCounters(db);
    seedDefaultProject(db);
  }

  return db;
}

export function initializeDatabase(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  applyMigrations(db);
  seedSystemCounters(db);
  seedDefaultProject(db);
}
