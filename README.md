# agentic-tasks

agentic-tasks は AI エージェント向けのタスク管理システムです。  
Phase 1（Core Foundation）として、SQLite スキーマ、コアモジュール、CLI、テストを実装しています。

## 技術スタック

- Node.js >= 20
- TypeScript (strict)
- SQLite (`better-sqlite3`)
- CLI (`commander`)
- Test (`vitest`)

## セットアップ

```bash
pnpm install
pnpm build
```

## CLI

```bash
# DB 初期化
pnpm tasks init

# goal 作成
pnpm tasks create --title "Goal" --task-type goal --project-id PROJ-001

# task 作成
pnpm tasks create --title "Task 1" --task-type task --parent-task-id GOAL-001 --project-id PROJ-001

# 取得
pnpm tasks get TASK-001

# 更新
pnpm tasks update TASK-001 --status to_do

# 一覧
pnpm tasks list --project-id PROJ-001

# 削除
pnpm tasks delete TASK-001

# 依存関係追加
pnpm tasks deps add --task-id TASK-002 --depends-on TASK-001

# 依存関係一覧
pnpm tasks deps list TASK-002
```

必要に応じて `--db <path>` で DB パスを指定できます（デフォルト: `.tasks/agentic-tasks.db`）。

## テスト

```bash
pnpm test
pnpm typecheck
```

## ディレクトリ

```text
agentic-tasks/
├── src/
│   ├── core/
│   ├── db/
│   │   ├── schema.ts
│   │   └── migrations/
│   ├── mcp-server/
│   ├── cli/
│   ├── types/
│   └── index.ts
├── tests/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```
