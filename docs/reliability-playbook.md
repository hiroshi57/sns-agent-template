# 信頼性プレイブック — 配信を「失敗させない」ための施策集

> **作成日**: 2026-07-02
> **目的**: 2026-07-01〜02 に発生した「全配信停止」事故を教訓に、
> 失敗の根本原因を潰し、明後日以降の完全自動運転を無停止で回すための施策と手順。

---

## 事故の教訓（2026-07-01〜02 に実際に起きたこと）

| # | 障害 | 原因 | 影響 | 状態 |
|---|------|------|------|------|
| 1 | ワークフロー6本が startup_failure | Chatwork通知の複数行文字列が `run: \|` ブロックをカラム0で破壊 | X/note/IG/TikTok/health-check/失敗通知が丸1日全停止 | ✅ 修正済（NL=$'\n' 化） |
| 2 | 全 SNS が投稿 0 件 | `ANTHROPIC_API_KEY` がローカル・GitHub Secrets 両方で 401 失効 | Claude 要約が全滅 → 投稿不能 | ⏳ **キー再発行待ち（ユーザー）** |
| 3 | 二重投稿リスク | note/IG/TikTok が pm2 常駐 ＋ GitHub Actions 両方で稼働 | キー復旧後に二重投稿 | ✅ 解消（GitHub Actions側を disable、pm2に一元化） |
| 4 | ダッシュボード常に0件 | MicroApps 配信ログが CI コンテナ内で消失 | ゲーム配信実績が可視化されず | ✅ 修正済（git 書き戻し追加） |

---

## 施策1: YAML 破損の自動検出（実装済み）

- `scripts/validate-workflows.py` で全ワークフローの YAML 構文を検証
- `ci.yml` が push/PR 時に自動実行 → 破損したら**マージ前に CI が落ちる**
- **ルール**: ワークフロー内の複数行メッセージは必ず `NL=$'\n'` を定義して1行文字列にする
- **手動確認**: ワークフロー編集後は `python scripts/validate-workflows.py` を実行

## 施策2: APIキー失効の早期検知（既存 + 強化方針）

- `health-check.yml`（毎日 08:00 JST）が ANTHROPIC_API_KEY を叩き、401 なら Chatwork にアラート
- 各投稿ワークフローも実行前にキー検証（401 で即 fail → 失敗通知）
- **運用ルール**:
  - キーは失効前提で扱う。Chatwork にキーアラートが来たら即再発行
  - 再発行時は **GitHub Secrets と ローカル `.env` の両方**を更新する（pm2 はローカル .env を使うため）
  - 予備キーを1本用意し、失効時に即差し替えられるようにする（将来）

## 施策3: 単一経路の原則（二重投稿防止）

各チャネルは **pm2 か GitHub Actions のどちらか一方のみ**が担当する。

| チャネル | 担当（2026-07-02 以降） | 備考 |
|---------|----------------------|------|
| X（5スロット＋ネタ＋アフィリエイト） | GitHub Actions `x-daily-transfer.yml` | pm2 x-daily-all は stopped |
| MicroApps（ゲーム） | GitHub Actions `micro-apps-promo.yml` | pm2 になし |
| note | pm2 `chatwork-note` | GitHub Actions `note-daily` は **disabled** |
| Instagram | pm2 `chatwork-instagram` | GitHub Actions `instagram-daily` は **disabled** |
| TikTok | pm2 `chatwork-tiktok` | GitHub Actions `tiktok-daily` は **disabled** |

- **ルール**: 新しい配信先を追加するときは、必ずどちらか一方に決める。両方に置かない。
- pm2 側は `pm2 save` 済み。PC 再起動後も同じ構成で復活する。

## 施策4: セッション失効への耐性（既存）

- `x-session-refresh.yml`（毎朝 06:30 JST）と pm2 `x-session-keepalive` が Cookie を更新
- 失効時は `npm run x:setup` / `npm run note:setup` で手動再ログイン

## 施策5: サイレント失敗の可視化（既存）

- 各ワークフローに「投稿0件アラート」（成功終了でも0件なら Chatwork 通知）
- `notify-on-failure.yml` が主要ワークフロー失敗時に Chatwork/LINE/Slack へ通知
- 配信ダッシュボード（`npm run dashboard:delivery`）で4配信の実績を集計

---

## 完全自動運転チェックリスト（明後日以降に無停止で回すため）

- [ ] **ANTHROPIC_API_KEY を再発行**し、GitHub Secrets ＋ ローカル `.env` を更新 ← **最優先・唯一の残ブロッカー**
- [x] 全ワークフローの YAML 構文 OK（`python scripts/validate-workflows.py`）
- [x] CI に YAML 構文チェックを追加（今後の破損を自動ブロック）
- [x] 二重投稿の解消（pm2 と GitHub Actions の担当を分離）
- [x] pm2 構成を `pm2 save` で永続化
- [ ] キー更新後に slot11 を手動実行し、X 投稿＋ネタ＋アフィリエイトのデータ蓄積を確認
- [ ] キー更新後に health-check が ✅ を返すことを確認

*最終更新: 2026-07-02*
