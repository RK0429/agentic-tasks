export const TASK_STATUSES = [
  'backlog',
  'to_do',
  'in_progress',
  'review',
  'done',
  'blocked',
  'escalated',
  'archived',
] as const;

export const TASK_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

export const TASK_TYPES = ['goal', 'task'] as const;

export const DELIVERY_PHASES = [
  'analysis',
  'requirements',
  'design',
  'wbs',
  'risk',
  'implementation',
  'review',
  'integration',
] as const;

export const EXPECTED_EFFORTS = ['XS', 'S', 'M', 'L', 'XL'] as const;

export const GATE_STATUSES = ['none', 'pending', 'passed', 'failed'] as const;

export const GATE_TYPES = [
  'code_review',
  'test',
  'security',
  'deploy',
  'acceptance',
  'custom',
] as const;

export const ENFORCEMENT_LEVELS = ['required', 'recommended'] as const;

export const GATE_RESULTS = ['pass', 'fail'] as const;

export const DEPENDENCY_TYPES = ['finish_to_start', 'start_to_start'] as const;
export const SPRINT_STATUSES = ['planned', 'active', 'completed'] as const;

export const COUNTER_KEYS = ['TASK', 'GOAL', 'GATE', 'PROJ', 'SPRINT', 'SCHED'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskType = (typeof TASK_TYPES)[number];
export type DeliveryPhase = (typeof DELIVERY_PHASES)[number];
export type ExpectedEffort = (typeof EXPECTED_EFFORTS)[number];
export type GateStatus = (typeof GATE_STATUSES)[number];
export type GateType = (typeof GATE_TYPES)[number];
export type EnforcementLevel = (typeof ENFORCEMENT_LEVELS)[number];
export type GateResult = (typeof GATE_RESULTS)[number];
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];
export type SprintStatus = (typeof SPRINT_STATUSES)[number];
export type CounterKey = (typeof COUNTER_KEYS)[number];

export interface AcceptanceCriterion {
  id: string;
  description: string;
  type: 'functional' | 'non_functional' | 'technical' | 'ux';
  verified: boolean;
  verified_by: string | null;
  verified_at: string | null;
}

export interface ExitCriterion {
  id: string;
  description: string;
  type: 'automated' | 'manual' | 'hybrid';
  evaluator: string;
}

export interface CriterionResult {
  criterion_id: string;
  result: GateResult;
  detail: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  task_type: TaskType;
  parent_task_id: string | null;
  goal_id: string | null;
  depth: number;
  phase: DeliveryPhase | null;
  source_ref: string | null;
  expected_effort: ExpectedEffort | null;
  actual_effort_ms: number | null;
  wbs_version: number;
  gate_status: GateStatus;
  project_id: string;
  sprint_id: string | null;
  assignee: string | null;
  acceptance_criteria: AcceptanceCriterion[];
  metadata: Record<string, unknown> | null;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface QualityGate {
  id: string;
  task_id: string;
  gate_type: GateType;
  enforcement_level: EnforcementLevel;
  exit_criteria: ExitCriterion[];
  checker_agent: string;
  checker_backend: string | null;
  max_retries: number;
  created_at: string;
}

export interface GateEvaluation {
  id: number;
  gate_id: string;
  task_id: string;
  attempt: number;
  result: GateResult;
  evaluator_agent: string;
  evaluator_backend: 'claude' | 'codex' | 'gemini';
  feedback: string | null;
  criteria_results: CriterionResult[];
  relay_session_id: string | null;
  evaluated_at: string;
}

export interface TaskDependency {
  task_id: string;
  depends_on: string;
  type: DependencyType;
  created_at: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  task_type?: TaskType;
  parent_task_id?: string | null;
  goal_id?: string;
  project_id?: string;
  sprint_id?: string | null;
  status?: TaskStatus;
  assignee?: string | null;
  acceptance_criteria?: AcceptanceCriterion[] | null;
  metadata?: Record<string, unknown> | null;
  created_by?: string | null;
  phase?: DeliveryPhase | null;
  source_ref?: string | null;
  expected_effort?: ExpectedEffort | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  sprint_id?: string | null;
  assignee?: string | null;
  acceptance_criteria?: AcceptanceCriterion[] | null;
  metadata?: Record<string, unknown> | null;
  phase?: DeliveryPhase | null;
  source_ref?: string | null;
  expected_effort?: ExpectedEffort | null;
  actual_effort_ms?: number | null;
  parent_task_id?: string | null;
}

export interface ListTasksInput {
  status?: TaskStatus;
  project_id?: string;
  goal_id?: string;
  depth?: number;
  parent_task_id?: string;
  task_type?: TaskType;
  assignee?: string;
  limit?: number;
  offset?: number;
}

export interface CreateQualityGateInput {
  task_id: string;
  gate_type: GateType;
  enforcement_level?: EnforcementLevel;
  exit_criteria: ExitCriterion[];
  checker_agent: string;
  checker_backend?: string | null;
  max_retries?: number;
}

export interface UpdateQualityGateInput {
  gate_type?: GateType;
  enforcement_level?: EnforcementLevel;
  exit_criteria?: ExitCriterion[];
  checker_agent?: string;
  checker_backend?: string | null;
  max_retries?: number;
}

export interface CreateGateEvaluationInput {
  gate_id: string;
  result: GateResult;
  evaluator_agent: string;
  evaluator_backend: 'claude' | 'codex' | 'gemini';
  feedback?: string | null;
  criteria_results?: CriterionResult[];
  relay_session_id?: string | null;
}

export interface TaskLock {
  task_id: string;
  agent_id: string;
  relay_session_id: string | null;
  locked_at: string;
  expires_at: string;
}

export interface TaskEvent {
  id: number;
  task_id: string;
  event_type: string;
  data: Record<string, unknown> | null;
  triggered_by: string;
  created_at: string;
}

export interface TasksErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  metadata: Record<string, unknown> | null;
  wip_limit: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  metadata?: Record<string, unknown> | null;
  wip_limit?: number;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  metadata?: Record<string, unknown> | null;
  wip_limit?: number;
}

export interface Sprint {
  id: string;
  project_id: string;
  name: string;
  description: string;
  phase_number: number;
  start_date: string;
  end_date: string;
  status: SprintStatus;
  created_at: string;
}

export interface CreateSprintInput {
  project_id: string;
  name: string;
  description?: string;
  phase_number?: number;
  start_date: string;
  end_date: string;
  status?: SprintStatus;
}

export interface UpdateSprintInput {
  name?: string;
  description?: string;
  phase_number?: number;
  start_date?: string;
  end_date?: string;
  status?: SprintStatus;
}

export interface ListSprintsInput {
  project_id?: string;
  status?: SprintStatus;
}

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  task_template: CreateTaskInput;
  project_id: string;
  enabled: boolean;
  max_instances: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

export interface CreateScheduleInput {
  name: string;
  cron: string;
  task_template: CreateTaskInput;
  project_id: string;
  enabled?: boolean;
  max_instances?: number;
  next_run_at?: string | null;
}

export interface UpdateScheduleInput {
  name?: string;
  cron?: string;
  task_template?: CreateTaskInput;
  project_id?: string;
  enabled?: boolean;
  max_instances?: number;
  last_run_at?: string | null;
  next_run_at?: string | null;
}
