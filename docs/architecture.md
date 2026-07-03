# アーキテクチャ（5層構造）

```
Layer 1  CLAUDE.md           Memory   — ルール・文脈
Layer 2  skills/             Skills   — 再利用可能なタスク定義
Layer 3  src/hooks/          Hooks    — ガードレール（投稿前チェック）
Layer 4  src/agents/         Agents   — KPI/分析/PDCA 専門エージェント
Layer 5  data/ + .github/    Plugins  — 永続データ + Cron 自動化
```

## Self-Improving Loop

```
[Do]    runSlot()                 5スロット投稿
  ↓     logSlotSummary()          KPI記録
[Check] collectKpis()             7日間集計
  ↓
[Act]   analyzeAndUpdateStrategy()  Claude が戦略更新
  ↓     saveStrategy() → data/strategy.json
[Plan]  loadStrategy()            翌朝の投稿に反映
```

## ファイルマップ

```
src/agents/
  kpi-collector.ts      KPI 集計（analytics + summary → KpiReport）
  strategy-analyzer.ts  Claude Sonnet でインサイト生成 → StrategyUpdate
  pdca-controller.ts    PDCA オーケストレーター（runPdcaCycle）

src/utils/
  strategy-store.ts     data/strategy.json I/O + getEffectiveThemes()
  analytics-logger.ts   AnalyticsRecord + SlotRunSummary 追記・読込
  pii-filter.ts         2段階 PII 除去（正規表現 + Claude Haiku）
  quality-scorer.ts     Chatwork 候補を 1-5 点でスコアリング

src/pipeline/runner.ts  buildSlotBatch（戦略ウェイト・テーマ上書き対応）
src/rss/reader.ts       スロット別 RSS フィード（30+ ソース）
src/index-x.ts          メインスケジューラー + Plan/Do/Check 統合
src/pdca.ts             CLI: pdca:analyze / pdca:status / pdca:reset

.github/workflows/
  x-daily-transfer.yml  5スロット投稿（平日 5 cron, 自動スロット判定）
  pdca-cycle.yml        PDCA 分析（毎夜 22:00 JST）

data/                   ← .gitignore 済み（runtime のみ）
  strategy.json         現在の戦略（PDCA が更新）
  x-analytics.jsonl     投稿単体ログ
  x-slot-summary.jsonl  スロット実行サマリー
  pdca-history.jsonl    PDCA 実行履歴
```

## GitHub Secrets

| Secret | 用途 |
|--------|------|
| `X_EMAIL` / `X_PASSWORD` / `X_USERNAME` / `X_PHONE` | X ログイン |
| `X_SESSION_JSON` | セッション永続化 |
| `CHATWORK_API_TOKEN` / `CHATWORK_ROOM_ID` / `CHATWORK_TARGET_ACCOUNT_IDS` | Chatwork |
| `ANTHROPIC_API_KEY` | Claude API |
