# sns-agent-template

> Chatwork / RSS のニュースを Claude で要約し、X / Instagram / TikTok / note へ自動投稿する
> **PDCA 自走型 SNS 配信エージェント** のテンプレートリポジトリ。

## 特徴

- 🤖 **Claude による要約・品質スコアリング** — ニュースを 150 字前後の投稿文に自動変換
- 🔁 **PDCA 自走ループ** — KPI を毎夜集計し、Claude が投稿戦略（テーマ配分・時間帯）を自動更新
- 📊 **マルチ SNS 対応** — X（1日5スロット）/ Instagram / TikTok / note
- 💰 **アフィリエイトランキング投稿** — 製品 JSON を書くだけで週次ランキングを自動投稿
- 🛡️ **PII 自動除去** — 正規表現 + Claude Haiku の2段階フィルター
- ⏰ **GitHub Actions / PM2 両対応** — サーバー不要のクラウド運用も、常駐運用も可

## クイックスタート

```bash
# 1. 依存のインストール
npm install
npx playwright install chromium

# 2. 環境変数の設定
cp env.example .env
#    → .env を開いて各アカウント情報を記入（コメントに取得手順あり）

# 3. アフィリエイト製品データ（任意）
cp data/affiliate-products.example.json data/affiliate-products.json
#    → 自分のアフィリエイトIDに書き換える

# 4. 各 SNS のセッション初期化（ブラウザが開くので手動ログイン）
npm run x:setup
npm run instagram:setup   # 使う場合のみ
npm run tiktok:setup      # 使う場合のみ
npm run note:setup        # 使う場合のみ

# 5. 動作確認（投稿されない dry-run）
npm run x:dry-run

# 6. 本番投稿
npm run x:once
```

## GitHub Actions で運用する場合

1. このテンプレートから自分のリポジトリを作成（**Private 推奨**）
2. `Settings → Secrets and variables → Actions` に `.env` と同名の Secrets を登録
   - 必須: `ANTHROPIC_API_KEY` / `X_EMAIL` / `X_PASSWORD` / `X_USERNAME` / `X_SESSION_JSON`
   - Chatwork 入力を使う場合: `CHATWORK_API_TOKEN` / `CHATWORK_ROOM_ID` / `CHATWORK_TARGET_ACCOUNT_IDS`
   - セッション自動更新: `GH_PAT`（repo + secrets scope）
3. `X_SESSION_JSON` はローカルで `npm run x:setup` 実行後の `state/x-session.json` の中身を登録
4. ワークフローは `.github/workflows/` 参照（スロット時刻は各 yml の cron を編集）

## 主要コマンド

```bash
npm run x:once            # 手動で1スロット投稿
npm run x:dry-run         # dry-run（投稿しない）
npm run pdca:analyze      # KPI 分析 → 戦略更新
npm run pdca:status       # KPI と現在の戦略を表示
npm run dashboard         # ローカルダッシュボード起動
npm test                  # テスト実行
```

## アーキテクチャ

```
Chatwork / RSS → 品質スコアリング → Claude 要約 → PII フィルター → 各 SNS へ投稿
                                                        ↓
                    戦略更新 ← Claude 分析 ← KPI 集計 ← 投稿ログ（PDCA ループ）
```

詳細は [docs/architecture.md](docs/architecture.md) / [docs/commands.md](docs/commands.md) を参照。

## セキュリティ

- `.env` / `state/`（セッション Cookie）/ `data/` の一部は `.gitignore` 済み — **絶対にコミットしないこと**
- push / PR ごとに [gitleaks](https://github.com/gitleaks/gitleaks) が秘密情報を自動スキャン
- 投稿前に PII（メール・電話・住所）を2段階で自動除去

## 免責・注意事項

- X / Instagram / TikTok / note への自動投稿は各サービスの利用規約の範囲内で利用してください。
  Playwright によるブラウザ自動操作は各サービスの仕様変更により動作しなくなる場合があります。
- 本テンプレートの利用により生じたアカウント制限等について作者は責任を負いません。

## ライセンス

商用利用可・再配布不可（詳細は購入時のライセンス条項を参照）
