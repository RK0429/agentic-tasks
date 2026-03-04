CREATE TABLE IF NOT EXISTS system_counters (
  counter_key TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL CHECK (next_value >= 1),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata TEXT,
  wip_limit INTEGER NOT NULL DEFAULT 5 CHECK (wip_limit >= 1),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sprints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  phase_number INTEGER NOT NULL CHECK (phase_number BETWEEN 0 AND 7),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'completed')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('backlog', 'to_do', 'in_progress', 'review', 'done', 'blocked', 'escalated', 'archived')),
  priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  task_type TEXT NOT NULL DEFAULT 'task' CHECK (task_type IN ('goal', 'task')),
  parent_task_id TEXT,
  goal_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  phase TEXT CHECK (phase IN ('analysis', 'requirements', 'design', 'wbs', 'risk', 'implementation', 'review', 'integration')),
  source_ref TEXT,
  expected_effort TEXT CHECK (expected_effort IN ('XS', 'S', 'M', 'L', 'XL')),
  actual_effort_ms INTEGER,
  wbs_version INTEGER NOT NULL DEFAULT 1,
  gate_status TEXT NOT NULL DEFAULT 'none' CHECK (gate_status IN ('none', 'pending', 'passed', 'failed')),
  project_id TEXT NOT NULL,
  sprint_id TEXT,
  assignee TEXT,
  acceptance_criteria TEXT,
  metadata TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
  FOREIGN KEY (goal_id) REFERENCES tasks(id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE SET NULL,
  CHECK (task_type != 'goal' OR parent_task_id IS NULL),
  CHECK (task_type != 'task' OR parent_task_id IS NOT NULL),
  CHECK (task_type != 'goal' OR goal_id IS NULL),
  CHECK (task_type != 'task' OR goal_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('finish_to_start', 'start_to_start')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality_gates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  gate_type TEXT NOT NULL CHECK (gate_type IN ('code_review', 'test', 'security', 'deploy', 'acceptance', 'custom')),
  enforcement_level TEXT NOT NULL CHECK (enforcement_level IN ('required', 'recommended')),
  exit_criteria TEXT NOT NULL,
  checker_agent TEXT NOT NULL,
  checker_backend TEXT,
  max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries BETWEEN 1 AND 10),
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gate_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  result TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
  evaluator_agent TEXT NOT NULL,
  evaluator_backend TEXT NOT NULL CHECK (evaluator_backend IN ('claude', 'codex', 'gemini')),
  feedback TEXT,
  criteria_results TEXT,
  relay_session_id TEXT,
  evaluated_at TEXT NOT NULL,
  FOREIGN KEY (gate_id) REFERENCES quality_gates(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE (gate_id, attempt)
);

CREATE TABLE IF NOT EXISTS task_locks (
  task_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  relay_session_id TEXT,
  locked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  data TEXT,
  triggered_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT,
  project_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('periodic', 'milestone', 'blocker', 'replan', 'manual')),
  assessment TEXT NOT NULL,
  decisions TEXT,
  actions_taken TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  task_template TEXT NOT NULL,
  project_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  max_instances INTEGER NOT NULL DEFAULT 1 CHECK (max_instances >= 1),
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_goal_id ON tasks(goal_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on);
CREATE INDEX IF NOT EXISTS idx_quality_gates_task_id ON quality_gates(task_id);
CREATE INDEX IF NOT EXISTS idx_gate_evaluations_gate_attempt ON gate_evaluations(gate_id, attempt DESC);
CREATE INDEX IF NOT EXISTS idx_task_events_task_created_at ON task_events(task_id, created_at DESC);
