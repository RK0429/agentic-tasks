import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';

import type {
  AcceptanceCriterion,
  DeliveryPhase,
  ExpectedEffort,
  Task,
  TaskPriority,
  TaskStatus,
  TaskType,
} from '../types/index.js';

const TASK_ID_PATTERN = /^(TASK|GOAL)-\d{3,}$/;

const STATUS_MAP: Record<string, TaskStatus> = {
  backlog: 'backlog',
  todo: 'to_do',
  to_do: 'to_do',
  'to-do': 'to_do',
  open: 'to_do',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  doing: 'in_progress',
  review: 'review',
  in_review: 'review',
  done: 'done',
  completed: 'done',
  closed: 'done',
  blocked: 'blocked',
  escalated: 'escalated',
  archived: 'archived',
  canceled: 'archived',
  cancelled: 'archived',
};

const PRIORITY_MAP: Record<string, TaskPriority> = {
  critical: 'critical',
  p0: 'critical',
  urgent: 'critical',
  high: 'high',
  p1: 'high',
  medium: 'medium',
  normal: 'medium',
  p2: 'medium',
  low: 'low',
  p3: 'low',
};

const VALID_PHASES = new Set<DeliveryPhase>([
  'analysis',
  'requirements',
  'design',
  'wbs',
  'risk',
  'implementation',
  'review',
  'integration',
]);

const VALID_EFFORTS = new Set<ExpectedEffort>(['XS', 'S', 'M', 'L', 'XL']);

export interface MdtmTaskDraft {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  task_type: TaskType;
  assignee: string | null;
  depends_on: string[];
  parent_task_id: string | null;
  goal_id: string | null;
  project_id: string | null;
  sprint_id: string | null;
  phase: DeliveryPhase | null;
  source_ref: string | null;
  expected_effort: ExpectedEffort | null;
  acceptance_criteria: AcceptanceCriterion[];
  metadata: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  wbs_version: number;
  gate_status: Task['gate_status'];
  source_path: string;
  inferred_parent_task_id: string | null;
  inferred_goal_id: string | null;
}

export interface ParseMdtmResult {
  tasks: MdtmTaskDraft[];
  warnings: string[];
}

function walkMarkdownFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(full));
      continue;
    }

    if (entry.isFile() && full.endsWith('.md')) {
      files.push(full);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toTaskType(value: unknown, id: string): TaskType {
  const explicit = asString(value)?.toLowerCase();
  if (explicit === 'goal' || explicit === 'task') {
    return explicit;
  }

  return id.startsWith('GOAL-') ? 'goal' : 'task';
}

function toTaskStatus(value: unknown): TaskStatus {
  const mapped = asString(value);
  if (!mapped) {
    return 'backlog';
  }

  return STATUS_MAP[mapped.toLowerCase()] ?? 'backlog';
}

function toTaskPriority(value: unknown): TaskPriority {
  const mapped = asString(value);
  if (!mapped) {
    return 'medium';
  }

  return PRIORITY_MAP[mapped.toLowerCase()] ?? 'medium';
}

function toTaskIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item))
      .filter((item) => TASK_ID_PATTERN.test(item));
  }

  const single = asString(value);
  if (!single) {
    return [];
  }

  if (single.includes(',')) {
    return single
      .split(',')
      .map((item) => item.trim())
      .filter((item) => TASK_ID_PATTERN.test(item));
  }

  return TASK_ID_PATTERN.test(single) ? [single] : [];
}

function toAcceptanceCriteria(value: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const output: AcceptanceCriterion[] = [];
  for (const raw of value) {
    const row = asRecord(raw);
    if (!row) {
      continue;
    }

    const id = asString(row.id);
    const description = asString(row.description);
    const type = asString(row.type);

    if (!id || !description) {
      continue;
    }

    if (
      type !== 'functional' &&
      type !== 'non_functional' &&
      type !== 'technical' &&
      type !== 'ux'
    ) {
      continue;
    }

    output.push({
      id,
      description,
      type,
      verified: Boolean(row.verified),
      verified_by: asString(row.verified_by),
      verified_at: asString(row.verified_at),
    });
  }

  return output;
}

function toPhase(value: unknown): DeliveryPhase | null {
  const phase = asString(value);
  if (!phase) {
    return null;
  }

  return VALID_PHASES.has(phase as DeliveryPhase) ? (phase as DeliveryPhase) : null;
}

function toExpectedEffort(value: unknown): ExpectedEffort | null {
  const effort = asString(value);
  if (!effort) {
    return null;
  }

  return VALID_EFFORTS.has(effort as ExpectedEffort) ? (effort as ExpectedEffort) : null;
}

function toWbsVersion(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return 1;
}

function toGateStatus(value: unknown): Task['gate_status'] {
  const gate = asString(value);
  if (!gate) {
    return 'none';
  }

  if (gate === 'none' || gate === 'pending' || gate === 'passed' || gate === 'failed') {
    return gate;
  }

  return 'none';
}

function inferPathHints(relativePath: string): {
  inferred_parent_task_id: string | null;
  inferred_goal_id: string | null;
} {
  const segments = relativePath.split(path.sep).slice(0, -1);
  const taskSegments = segments.filter((segment) => TASK_ID_PATTERN.test(segment));

  const inferred_parent_task_id =
    taskSegments.length > 0 ? taskSegments[taskSegments.length - 1] ?? null : null;

  const inferred_goal_id = taskSegments.find((segment) => segment.startsWith('GOAL-')) ?? null;

  return {
    inferred_parent_task_id,
    inferred_goal_id,
  };
}

export function parseMdtmDirectory(source_dir: string): ParseMdtmResult {
  const markdownFiles = walkMarkdownFiles(source_dir);
  const warnings: string[] = [];

  const tasks = markdownFiles.map((filePath): MdtmTaskDraft => {
    const content = readFileSync(filePath, 'utf8');
    const parsed = matter(content);
    const data = asRecord(parsed.data) ?? {};
    const relativePath = path.relative(source_dir, filePath);
    const stat = statSync(filePath);

    const frontmatterId = asString(data.id);
    const fileStem = path.basename(filePath, '.md');
    const id = frontmatterId ?? (TASK_ID_PATTERN.test(fileStem) ? fileStem : null);

    if (!id || !TASK_ID_PATTERN.test(id)) {
      throw new Error(`invalid or missing task id: ${relativePath}`);
    }

    const status = toTaskStatus(data.status);
    if (asString(data.status) && !STATUS_MAP[asString(data.status)!.toLowerCase()]) {
      warnings.push(`status mapped to backlog: ${id} (${String(data.status)})`);
    }

    const priority = toTaskPriority(data.priority);
    if (asString(data.priority) && !PRIORITY_MAP[asString(data.priority)!.toLowerCase()]) {
      warnings.push(`priority mapped to medium: ${id} (${String(data.priority)})`);
    }

    const { inferred_parent_task_id, inferred_goal_id } = inferPathHints(relativePath);

    return {
      id,
      title: asString(data.title) ?? id,
      description: parsed.content.trim(),
      status,
      priority,
      task_type: toTaskType(data.task_type ?? data.type, id),
      assignee: asString(data.assignee),
      depends_on: toTaskIds(data.depends_on),
      parent_task_id: asString(data.parent_task_id),
      goal_id: asString(data.goal_id),
      project_id: asString(data.project_id),
      sprint_id: asString(data.sprint_id),
      phase: toPhase(data.phase),
      source_ref: asString(data.source_ref),
      expected_effort: toExpectedEffort(data.expected_effort),
      acceptance_criteria: toAcceptanceCriteria(data.acceptance_criteria),
      metadata: asRecord(data.metadata),
      created_by: asString(data.created_by),
      created_at: asString(data.created_at) ?? stat.mtime.toISOString(),
      updated_at: asString(data.updated_at) ?? stat.mtime.toISOString(),
      wbs_version: toWbsVersion(data.wbs_version),
      gate_status: toGateStatus(data.gate_status),
      source_path: relativePath,
      inferred_parent_task_id,
      inferred_goal_id,
    };
  });

  return {
    tasks,
    warnings,
  };
}
