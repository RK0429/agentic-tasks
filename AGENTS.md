# agentic-tasks

## 概要

AI エージェント向けタスク管理システム。MCP サーバー・SQLite ストレージ・オーケストレーションプロトコルを提供する。

## 技術スタック

- Runtime: Node.js >= 22
- Package manager: pnpm
- Language: TypeScript（ESM）
- Test: vitest
- Build: tsc
- DB: better-sqlite3
- Lint: eslint + prettier

## コマンド

- `pnpm install` -- 依存関係のインストール
- `pnpm build` -- ビルド
- `pnpm typecheck` -- 型チェック
- `pnpm test` -- テスト実行
- `pnpm lint` -- lint

## テスト

- `pnpm test` -- 全テスト実行（vitest）
- `pnpm test -- <テストファイル>` -- 指定ファイルのテスト
- `pnpm test -- -t "<テスト名パターン>"` -- テスト名でフィルタ

## Git 規約

- Conventional Commits（`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`）
- `main` 直接コミット（ブランチ運用なし）

## パブリッシュ手順

`@rk0429/agentic-tasks` の npm パブリッシュは GitHub Actions（`.github/workflows/publish.yml`）で自動実行される。ローカルから `npm publish` を直接実行しない。

1. `package.json` の `version` を更新する
2. `CHANGELOG.md` に該当バージョンのエントリを追加する
3. 変更をコミット・プッシュする
4. タグを作成してプッシュする: `git tag v<version> && git push origin v<version>`
5. GitHub Actions が自動で テスト → ビルド → npm publish → GitHub Release を実行する
6. ワークフロー完了後、ワークスペースルートで submodule ref を更新・プッシュする
