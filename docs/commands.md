# コマンド一覧

## X 投稿

```bash
npm run x:once                       # slot07 を手動実行
npm run x:once -- --slot slot11      # 指定スロット手動実行
npm run x:dry-run                    # dry-run（投稿しない）
npm run x:dev                        # スケジューラー常駐起動
npm run x:report                     # 週次レポート表示
```

## PDCA

```bash
npm run pdca:analyze                 # KPI 分析 → strategy.json 更新
npm run pdca:analyze -- --dry-run    # 分析のみ（保存しない）
npm run pdca:analyze -- --days=14    # 14日分で分析
npm run pdca:status                  # KPI + 現在の戦略を表示
npm run pdca:reset                   # 戦略をデフォルトにリセット
```

## セッション管理

```bash
npm run x:setup                      # X セッション初期化（初回）
```
