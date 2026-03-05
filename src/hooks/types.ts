import type { StaleCleanupReason } from '../core/lock-manager.js';
import type { Task } from '../types/index.js';

export interface RelayHookInput {
  event: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

export interface HookResult {
  success: boolean;
  event: string;
  session_id: string | null;
  warnings: string[];
  actions: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TaskHookClient {
  get_task(task_id: string): Task | null;
  claim_and_start(input: {
    task_id: string;
    agent_id: string;
    relay_session_id?: string;
    lock_duration_ms?: number;
  }): {
    task_id: string;
    new_status: 'in_progress';
    lock: { locked_at: string; expires_at: string };
    task: Task;
  };
  complete_task(input: {
    task_id: string;
    agent_id: string;
    actual_effort_ms?: number;
    result_summary?: string;
    skip_review?: boolean;
  }):
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
      };
  stale_lock_cleanup(input: {
    stale_session_ids?: string[];
    relay_session_id?: string;
    reason: StaleCleanupReason;
    agent_id?: string;
  }): {
    cleaned_up: boolean;
    released_tasks: Array<{
      task_id: string;
      previous_status: Task['status'];
      new_status: 'to_do';
    }>;
    events_emitted: number;
    normalized_reason:
      | 'heartbeat_timeout'
      | 'process_crash'
      | 'context_overflow'
      | 'session_timeout'
      | 'manual_cleanup';
    released: string[];
    errors: string[];
  };
}

export interface MemorySearchOutput {
  summary: string;
  raw: unknown;
}

export interface MemoryNoteOutput {
  note_path: string | null;
  raw: unknown;
}

export interface MemoryHookClient {
  memory_search(input: {
    query: string;
    task_id?: string;
    agent_id?: string;
    relay_session_id?: string;
  }): Promise<MemorySearchOutput>;
  memory_note_new(input: {
    task_id?: string;
    relay_session_id?: string;
    agent_id?: string;
    snapshot_type?: string;
    title?: string;
  }): Promise<MemoryNoteOutput>;
}

export interface HookDependencies {
  tasks: TaskHookClient;
  memory: MemoryHookClient;
  log: (message: string, payload?: Record<string, unknown>) => void;
}
