# GitViewer

Jasper ライクな GitHub Issue/PR ウォッチャー。Tauri 2 + React で軽量に動作し、認証は GitHub CLI (`gh`) に委譲します。

## 特徴(計画)

- **Stream**: GitHub 検索クエリ単位でチェック対象をコントロール
- **Filter**: Stream 内をローカルで絞り込み(API を消費しない)
- **gh 認証**: トークンは `gh auth token` から都度取得し、メモリ上にのみ保持
- **GitHub 操作**: gh でできる操作を可能な限りアプリ内から実行
- **ブランチグラフ**: ブランチ状況を DAG で可視化
- **軽量**: Rust バックエンド + SQLite、フロントは表示に専念

## 必要環境

- [GitHub CLI](https://cli.github.com)(`gh auth login` 済みであること)
- Node.js 22+ / Rust 1.90+(開発時)

## 開発

```sh
npm install
npm run tauri dev
```

### テスト

```sh
# Rust 統合テスト(gh の実認証とネットワークを使用)
cd src-tauri && cargo test -- --ignored

# 型チェック + フロントビルド
npm run build
```

## ロードマップ

| フェーズ | 内容 | 状態 |
|---|---|---|
| M0 | 基盤: gh 認証 + 固定クエリで一覧表示 | ✅ |
| M1 | Stream CRUD・ポーリング・SQLite・未読管理・通知 | ✅ |
| M2 | 詳細ペインと GitHub 操作(gh でできることを網羅) | ✅ |
| M3 | アプリ内ブラウザ統合 | 予定 |
| M4 | ブランチグラフ | 予定 |
| M5 | 配布(mac 署名 → Windows/Linux) | 予定 |
