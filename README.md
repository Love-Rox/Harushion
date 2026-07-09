# GitViewer

GitHub の Issue/PR を Stream(検索クエリ)単位でウォッチするデスクトップクライアント。Tauri 2 + React で軽量に動作し、認証は GitHub CLI (`gh`) に委譲します。

## 特徴(計画)

- **Stream**: GitHub 検索クエリ単位でチェック対象をコントロール
- **Filter**: Stream 内をローカルで絞り込み(API を消費しない)
- **gh 認証**: トークンは `gh auth token` から都度取得し、メモリ上にのみ保持
- **GitHub 操作**: gh でできる操作を可能な限りアプリ内から実行
- **アプリ内ブラウザ**: github.com 専用ウィンドウで閲覧(ログイン状態は WebView に保持)。外部ブラウザで開くことも可能
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
# フロントの単体テスト (Vitest)
npm run test

# リント / フォーマット (Oxlint / Oxfmt)
npm run lint
npm run fmt

# 型チェック + フロントビルド (TS7 + Vite+/Rolldown)
npm run build

# Rust 統合テスト(gh の実認証とネットワークを使用)
cd src-tauri && cargo test -- --ignored
```

> ツールチェーンは [Vite+](https://github.com/voidzero-dev/vite-plus)(`vp`)に統一。`.npmrc` の `legacy-peer-deps` は vite-plus 0.2.x が TypeScript 7 を peer range に含めていないための暫定措置。

## ロードマップ

| フェーズ | 内容                                            | 状態 |
| -------- | ----------------------------------------------- | ---- |
| M0       | 基盤: gh 認証 + 固定クエリで一覧表示            | ✅   |
| M1       | Stream CRUD・ポーリング・SQLite・未読管理・通知 | ✅   |
| M2       | 詳細ペインと GitHub 操作(gh でできることを網羅) | ✅   |
| M3       | アプリ内ブラウザ統合(WebviewWindow 方式)        | ✅   |
| M4       | ブランチグラフ                                  | ✅   |
| M5       | 配布(mac 署名 → Windows/Linux)                  | 予定 |
