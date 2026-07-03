#!/usr/bin/env bash
# scripts/save-analytics.sh
#
# GitHub Actions 上で x-analytics.jsonl / x-slot-summary.jsonl を
# リポジトリに書き戻す。5スロット並列実行時の衝突を pull --rebase でリトライ。
#
# 使い方（workflow step の run: に記述）:
#   bash scripts/save-analytics.sh
#
# 必要な前提:
#   - actions/checkout@v4 で checkout 済み
#   - GITHUB_TOKEN が環境変数に設定済み（Actions はデフォルトで付与）
#   - git config user.name/email 済み（本スクリプト内で設定）

set -euo pipefail

ANALYTICS="data/x-analytics.jsonl"
SLOT_SUMMARY="data/x-slot-summary.jsonl"
MAX_RETRY=5
BRANCH="${GITHUB_REF_NAME:-main}"

# ── git 設定 ──────────────────────────────────────────────────
git config user.name  "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

# ── 対象ファイルが存在しない場合は空ファイルを作成 ────────────
mkdir -p data
[ -f "$ANALYTICS" ]     || echo "" > "$ANALYTICS"
[ -f "$SLOT_SUMMARY" ]  || echo "" > "$SLOT_SUMMARY"

# ── ステージング ──────────────────────────────────────────────
git add -f "$ANALYTICS" "$SLOT_SUMMARY"

# 差分がなければ終了
if git diff --staged --quiet; then
  echo "[save-analytics] 変更なし。スキップします。"
  exit 0
fi

# ── コミット ──────────────────────────────────────────────────
SLOT_LABEL="${SLOT:-unknown}"
git commit -m "chore: update analytics ${SLOT_LABEL} $(date -u +%Y-%m-%dT%H:%M:%SZ) [skip ci]"

# ── push（競合時は pull --rebase してリトライ）────────────────
for i in $(seq 1 $MAX_RETRY); do
  if git push origin "HEAD:${BRANCH}"; then
    echo "[save-analytics] push 成功（試行 ${i}/${MAX_RETRY}）"
    exit 0
  fi

  if [ "$i" -ge "$MAX_RETRY" ]; then
    echo "[save-analytics] push が ${MAX_RETRY} 回失敗しました。analytics の保存を断念します。"
    exit 1
  fi

  echo "[save-analytics] push 失敗（試行 ${i}/${MAX_RETRY}）。rebase してリトライします..."
  git fetch origin "${BRANCH}"
  git rebase "origin/${BRANCH}" || {
    # rebase 競合（JSONL の append 競合）は theirs で解決
    git checkout --theirs "$ANALYTICS" "$SLOT_SUMMARY" 2>/dev/null || true
    git add -f "$ANALYTICS" "$SLOT_SUMMARY"
    git rebase --continue
  }
  # rebase 後は自分のコミットを含む最新状態になっている
  WAIT=$(( (RANDOM % 10) + 5 ))
  echo "[save-analytics] ${WAIT}秒待機してリトライ..."
  sleep "$WAIT"
done

# ── 静的ダッシュボード再生成 ─────────────────────────────────────
# analytics push 成功後に docs/index.html を最新データで上書きし
# 追加コミットとして push する（失敗してもメイン処理には影響しない）
if command -v npx &> /dev/null && [ -f "scripts/generate-dashboard.ts" ]; then
  echo "[save-analytics] 静的ダッシュボードを再生成します..."
  npx ts-node scripts/generate-dashboard.ts && \
    git add -f docs/index.html && \
    git diff --staged --quiet || \
    git commit -m "chore: update dashboard $(date -u +%Y-%m-%dT%H:%M:%SZ) [skip ci]" && \
    git push origin "HEAD:${BRANCH}" && \
    echo "[save-analytics] ダッシュボード更新 push 完了" || \
    echo "[save-analytics] ダッシュボード更新スキップ（変更なし or エラー）"
fi
