# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
