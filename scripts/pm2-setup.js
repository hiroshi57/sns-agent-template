#!/usr/bin/env node
/**
 * PM2 初回セットアップスクリプト
 *
 * 実行: npm run pm2:setup
 *
 * やること:
 *   1. npm run build （dist/ を生成）
 *   2. pm2-logrotate インストール + 設定（ログ肥大化防止）
 *   3. pm2 start ecosystem.config.js
 *   4. pm2 save （再起動後も設定を保持）
 *   5. Windows 自動起動の案内を表示
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');

function run(cmd, desc) {
  console.log(`\n▶ ${desc}`);
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit' });
}

function runSafe(cmd, desc) {
  try {
    run(cmd, desc);
  } catch (err) {
    console.warn(`  ⚠️  ${desc} に失敗しました（続行します）: ${err.message}`);
  }
}

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║   PM2 初回セットアップ                   ║');
console.log('╚══════════════════════════════════════════╝');

// ── 1. ビルド ─────────────────────────────────────────────────
run('npm run build', 'TypeScript ビルド（dist/ 生成）');

// ── 2. pm2-logrotate インストール・設定 ────────────────────────
// ログが肥大化してディスクを埋め尽くすのを防ぐ（教訓 #PM2-2）
runSafe('pm2 install pm2-logrotate', 'pm2-logrotate インストール');
runSafe('pm2 set pm2-logrotate:max_size 10M',   'ログ上限 10MB に設定');
runSafe('pm2 set pm2-logrotate:retain 7',        'ログ保持日数 7 日に設定');
runSafe('pm2 set pm2-logrotate:compress true',   'ログ圧縮 有効化');
runSafe('pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss', 'ログファイル日付形式');

// ── 3. ログ・状態ディレクトリ作成 ─────────────────────────────
const dirs = ['logs', 'data', 'state', 'tmp'];
for (const d of dirs) {
  const full = path.join(REPO_ROOT, d);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(full, { recursive: true });
    console.log(`  ✅ ${d}/ を作成しました`);
  }
}

// ── 4. PM2 起動 ───────────────────────────────────────────────
runSafe('pm2 delete ecosystem.config.js', '既存プロセスをクリア（存在しない場合は無視）');
run('pm2 start ecosystem.config.js', 'PM2 プロセス起動');

// ── 5. pm2 save （必須: 再起動後の自動復元に必要）──────────────
// これを忘れると PC 再起動後にプロセスが消える（教訓 #PM2-5）
run('pm2 save --force', 'プロセスリスト保存（pm2 resurrect 用）');

// ── 6. 起動確認 ───────────────────────────────────────────────
run('pm2 status', '起動状態確認');

// ── 7. Windows 自動起動の案内 ─────────────────────────────────
console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║   ✅ PM2 セットアップ完了                                    ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log('║                                                              ║');
console.log('║  Windows 再起動後も自動起動するには:                         ║');
console.log('║  PowerShell（管理者）で以下を実行:                          ║');
console.log('║                                                              ║');
console.log('║    powershell -ExecutionPolicy Bypass \\                     ║');
console.log('║      -File scripts\\pm2-windows-autostart.ps1               ║');
console.log('║                                                              ║');
console.log('║  ログの確認:                                                 ║');
console.log('║    npm run pm2:logs                                         ║');
console.log('║                                                              ║');
console.log('║  設定変更後の反映:                                           ║');
console.log('║    npm run pm2:restart                                      ║');
console.log('║                                                              ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
