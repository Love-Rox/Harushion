# GitViewer 開発ガイド

Jasper ライクな GitHub Issue/PR ウォッチャー(Tauri 2 + React 19 + TypeScript)。

## アーキテクチャ方針

- **ロジックとデータは Rust 側**(`src-tauri/src/`)、React は表示に専念する
- 認証は gh CLI に委譲: `gh auth token` で取得、**メモリ保持のみ・ディスク保存禁止**
- GitHub API は GraphQL 主体(`github.rs` の `AppState::graphql`)
- 依存は最小限に保つ。重量級ライブラリ(D3 等)は入れない

## コマンド

- 開発起動: `npm run tauri dev`
- 型チェック+フロントビルド: `npm run build`
- Rust チェック: `cd src-tauri && cargo check`
- 統合テスト(gh 実認証+ネットワーク使用): `cd src-tauri && cargo test -- --ignored`

## ロードマップ

README.md のロードマップ表を参照。M2 では「gh でできる操作の網羅」が目標。
