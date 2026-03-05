import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';

import { openDatabase } from '../db/index.js';
import { TasksRuntime } from '../core/index.js';

import type { MemoryHookClient, MemoryNoteOutput, MemorySearchOutput, TaskHookClient } from './types.js';

const execFile = promisify(execFileCallback);
const DEFAULT_DB_PATH = path.resolve(process.cwd(), '.tasks/agentic-tasks.db');

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { raw: trimmed };
  }
}

function toSearchSummary(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }

  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const asRecord = payload as Record<string, unknown>;
  const directSummary = asRecord.summary;
  if (typeof directSummary === 'string') {
    return directSummary;
  }

  const items = asRecord.results;
  if (Array.isArray(items)) {
    const rendered = items
      .slice(0, 5)
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (!item || typeof item !== 'object') {
          return '';
        }

        const row = item as Record<string, unknown>;
        const title = typeof row.title === 'string' ? row.title : null;
        const snippet =
          typeof row.snippet === 'string'
            ? row.snippet
            : Array.isArray(row.snippets)
              ? String(row.snippets[0] ?? '')
              : null;

        if (title && snippet) {
          return `- ${title}: ${snippet}`;
        }
        if (title) {
          return `- ${title}`;
        }
        if (snippet) {
          return `- ${snippet}`;
        }
        return '';
      })
      .filter((line) => line.length > 0)
      .join('\n');

    return rendered;
  }

  return '';
}

export function createRuntimeTaskHookClient(db_path?: string): {
  client: TaskHookClient;
  close: () => void;
} {
  const db = openDatabase({
    db_path: db_path ?? process.env.AGENTIC_TASKS_DB_PATH ?? DEFAULT_DB_PATH,
    initialize: true,
  });
  const runtime = new TasksRuntime(db);

  return {
    client: {
      get_task(task_id) {
        const result = runtime.get_task(task_id, true);
        return result.task;
      },
      claim_and_start(input) {
        return runtime.claim_and_start(input);
      },
      complete_task(input) {
        return runtime.complete_task(input);
      },
      stale_lock_cleanup(input) {
        return runtime.stale_lock_cleanup(input);
      },
    },
    close: () => db.close(),
  };
}

export class NoopMemoryHookClient implements MemoryHookClient {
  public async memory_search(input: {
    query: string;
    task_id?: string;
    agent_id?: string;
    relay_session_id?: string;
  }): Promise<MemorySearchOutput> {
    return {
      summary: '',
      raw: {
        noop: true,
        input,
      },
    };
  }

  public async memory_note_new(input: {
    task_id?: string;
    relay_session_id?: string;
    agent_id?: string;
    snapshot_type?: string;
    title?: string;
  }): Promise<MemoryNoteOutput> {
    return {
      note_path: null,
      raw: {
        noop: true,
        input,
      },
    };
  }
}

export class MemoryCliHookClient implements MemoryHookClient {
  private readonly memoryDir: string | null;
  private readonly command: string;

  public constructor(memoryDir?: string | null, command?: string) {
    this.memoryDir = memoryDir ?? process.env.AGENTIC_MEMORY_DIR ?? null;
    this.command = command ?? process.env.AGENTIC_MEMORY_CLI ?? 'uvx';
  }

  public async memory_search(input: {
    query: string;
    task_id?: string;
    agent_id?: string;
    relay_session_id?: string;
  }): Promise<MemorySearchOutput> {
    const args = ['--from', 'agmemory', 'memory', 'search', '--query', input.query, '--json'];

    if (input.task_id) {
      args.push('--task-id', input.task_id);
    }
    if (input.agent_id) {
      args.push('--agent-id', input.agent_id);
    }
    if (input.relay_session_id) {
      args.push('--relay-session-id', input.relay_session_id);
    }
    if (this.memoryDir) {
      args.push('--memory-dir', this.memoryDir);
    }

    const { stdout } = await execFile(this.command, args, {
      timeout: toNumber(process.env.AGENTIC_MEMORY_TIMEOUT_MS, 30_000),
      maxBuffer: 4 * 1024 * 1024,
    });

    const payload = parseJsonOutput(stdout);
    return {
      summary: toSearchSummary(payload),
      raw: payload,
    };
  }

  public async memory_note_new(input: {
    task_id?: string;
    relay_session_id?: string;
    agent_id?: string;
    snapshot_type?: string;
    title?: string;
  }): Promise<MemoryNoteOutput> {
    const title =
      input.title ??
      `tasks-hook:${input.snapshot_type ?? 'incremental'}:${input.task_id ?? 'unknown-task'}`;

    const context = JSON.stringify({
      task_id: input.task_id ?? null,
      relay_session_id: input.relay_session_id ?? null,
      agent_id: input.agent_id ?? null,
      snapshot_type: input.snapshot_type ?? 'incremental',
    });

    const noteArgs = ['--from', 'agmemory', 'memory', 'note', 'new', '--title', title, '--context', context, '--json'];

    if (this.memoryDir) {
      noteArgs.push('--memory-dir', this.memoryDir);
    }

    const { stdout } = await execFile(this.command, noteArgs, {
      timeout: toNumber(process.env.AGENTIC_MEMORY_TIMEOUT_MS, 30_000),
      maxBuffer: 4 * 1024 * 1024,
    });

    const notePayload = parseJsonOutput(stdout) as Record<string, unknown>;
    const notePath =
      typeof notePayload.path === 'string'
        ? notePayload.path
        : typeof notePayload.note_path === 'string'
          ? notePayload.note_path
          : null;

    if (notePath && input.task_id) {
      const upsertArgs = ['--from', 'agmemory', 'memory', 'index', 'upsert', '--note', notePath, '--task-id', input.task_id, '--json'];
      if (input.agent_id) {
        upsertArgs.push('--agent-id', input.agent_id);
      }
      if (input.relay_session_id) {
        upsertArgs.push('--relay-session-id', input.relay_session_id);
      }
      if (this.memoryDir) {
        upsertArgs.push('--memory-dir', this.memoryDir);
      }

      await execFile(this.command, upsertArgs, {
        timeout: toNumber(process.env.AGENTIC_MEMORY_TIMEOUT_MS, 30_000),
        maxBuffer: 4 * 1024 * 1024,
      });
    }

    return {
      note_path: notePath,
      raw: notePayload,
    };
  }
}
