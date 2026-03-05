# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-03-05

### Added

- `approve_task` API: review → done (created_by/parent assignee only, self-review prohibited)
- `block_task` API: in_progress → blocked (assignee only, lock release)
- `reopen_task` API: review/blocked/escalated → to_do (created_by/parent assignee)
- `archive_task` API: → archived with cascade (created_by only)
- Auto-cleanup: delete child tasks when all done under a goal, delete project when all goals done
- Cleanup summary in `approve_task` response with task/effort aggregation
- Goal `assignee` auto-set to `agent_id` on `create_goal`
- CLI commands: `approve`, `block`, `reopen`, `archive`

### Changed

- `complete_task`: now only transitions `in_progress → review` (or `done` if metadata.skip_review)
- `update_task`: status field removed — use dedicated transition APIs instead

### Removed

- `status` parameter from `update_task` (BREAKING)
- `skip_review` parameter from `complete_task` (moved to task metadata)

## [0.1.7] - 2026-03-05

### Fixed

- Include `migrations/` directory in npm package (SQL files were missing from `dist/db/`)
- Build script now copies migration files to dist output

## [0.1.6] - 2026-03-05

### Added

- `next`, `assign`, `release` CLI commands
- `--agent-id` option to `task update` command
- `--parent-task-id` required option for `task create` with clear help text

### Fixed

- `deps resolve` now accepts both positional `<taskId>` and `--task-id` option
- `--help` examples updated to match actual working commands

## [0.1.5] - 2026-03-05

### Added

- CLI alias commands: `task create/list/update/get`, `goal create/list`, `dashboard`, `deps resolve/remove`
- Quick Start examples in `--help` output
- `goal_id` parameter for `create_task` MCP tool
- `depth` filter for `list_tasks` MCP tool
- `get_events` MCP tool for querying task events
- `poll_events` MCP tool for cursor-based event polling
- `import_mdtm` / `export_mdtm` MCP tools for MDTM migration

### Changed

- `next_task`: `project_id` is now optional (was required)

## [0.1.4] - 2026-03-05

### Added

- `list_tasks` MCP tool for filtered task listing (status, project, goal, parent, type, assignee)
- `add_dependency` MCP tool for adding dependencies between sibling tasks with cycle detection
- `remove_dependency` MCP tool for removing task dependencies

## [0.1.3] - 2026-03-05

### Added

- `mcp serve` CLI command for MCP server startup via stdio transport

### Fixed

- CI test timeout for CLI integration tests (increased to 30s)

## [0.1.2] - 2026-03-05

### Added

- `mcp serve` CLI command for MCP server startup via stdio transport (unpublished)

## [0.1.1] - 2026-03-05

### Fixed

- Scheduler test timezone dependency causing CI failures

## [0.1.0] - 2026-03-05

### Added

- Core task management (CRUD, status transitions, hierarchy, quality gates)
- SQLite-based storage with better-sqlite3
- Lock manager with TTL-based expiry
- Queue manager with priority-based task assignment
- Dependency resolver with cycle detection
- WIP limit enforcement
- Progress rollup calculation for goals
- Access control module
- Escalation transitions
- MCP server with full tool set (40+ tools)
- CLI with commander (init, create, get, update, delete, list, deps, migrate, project, sprint, schedule)
- Orchestration protocol tools (decompose, claim, complete, escalate, delegate)
- Quality gate tools with hard enforcement
- Checkpoint and replan tools
- Goal and hierarchy tools
- Relay hook integration (pre-spawn, on-session-complete, on-session-error, on-session-stale, on-context-threshold)
- MDTM migration (import/export/verify)
- Scheduler with cron-based task auto-generation
- Project CRUD
- Sprint CRUD with completion workflow
