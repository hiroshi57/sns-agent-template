'use strict';

// ─────────────────────────────────────────────────────────────────
// PM2 エコシステム設定
//
// ⚠️ NG: 絶対パスを直接書かない（PC が変わると即クラッシュ）
//   誤: cwd: 'C:/Users/YOUR_USERNAME/...'
//   正: cwd: REPO_ROOT  （__dirname から自動解決）
//
// ⚠️ cron_restart は UTC 基準で記述する
//   JST 06:00 → UTC 21:00 → '0 21 * * *'
//   JST 07:00 → UTC 22:00 → '0 22 * * *'
//   ※ Asia/Tokyo を指定しても pm2 の cron_restart は UTC 固定
//
// ▶ 初回セットアップ:
//   npm run pm2:setup
//
// ▶ 起動:
//   npm run pm2:start
//
// ▶ 設定変更後の反映:
//   npm run pm2:restart
// ─────────────────────────────────────────────────────────────────

const path = require('path');

// このファイルが置かれているディレクトリ = リポジトリルート
// 絶対パスのハードコードを根絶し、どの PC でも動作するようにする
const REPO_ROOT = __dirname;

// ── メモリ上限の目安（Playwright は最大 1G 消費することがある）──
// 超えると pm2 が自動再起動してメモリリークを抑止する
const MEM_MEDIUM  = '500M';   // Playwright + 短時間スクリプト
const MEM_HEAVY   = '1G';     // Playwright + 長時間・全スロット処理

module.exports = {
  apps: [

    // ────────────────────────────────────────────────────────────
    // X セッション維持
    //   毎朝 06:00 JST (= UTC 21:00 前日) に Cookie を更新
    //   x-daily-all の 1 時間前に実行して失効を防ぐ
    // ────────────────────────────────────────────────────────────
    {
      name: 'x-session-keepalive',
      script: path.join(REPO_ROOT, 'dist/x/session-keepalive.js'),
      cwd: REPO_ROOT,

      // JST 06:00 = UTC 21:00 前日 → '0 21 * * *'
      cron_restart: '0 21 * * *',
      autorestart: false,           // 実行後は停止（常駐しない）
      max_memory_restart: MEM_MEDIUM,

      out_file:   path.join(REPO_ROOT, 'logs/pm2-keepalive-out.log'),
      error_file: path.join(REPO_ROOT, 'logs/pm2-keepalive-err.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      env: { NODE_ENV: 'production' },
    },

    // ────────────────────────────────────────────────────────────
    // X 全スロット一括投稿
    //   毎朝 07:00 JST (= UTC 22:00 前日) に起動
    //   post-all-slots.ts が各スロット時刻まで内部待機して投稿
    //     07:00 slot07 / 11:00 slot11 / 13:00 slot12
    //     16:00 slot14 / 18:00 slot17
    // ────────────────────────────────────────────────────────────
    {
      name: 'x-daily-all',
      script: path.join(REPO_ROOT, 'dist/x/post-all-slots.js'),
      cwd: REPO_ROOT,

      // JST 07:00 = UTC 22:00 前日 → '0 22 * * *'
      cron_restart: '0 22 * * *',
      autorestart: false,           // 全スロット終了後は自然終了
      max_memory_restart: MEM_HEAVY,

      out_file:   path.join(REPO_ROOT, 'logs/pm2-x-daily-out.log'),
      error_file: path.join(REPO_ROOT, 'logs/pm2-x-daily-err.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      env: { NODE_ENV: 'production' },
    },

    // ────────────────────────────────────────────────────────────
    // Instagram 自動投稿（常駐・node-cron 管理）
    //   平日 08:00 / 14:30 / 18:00 JST に投稿（index-instagram.ts で制御）
    //   ※ 初回: npm run instagram:setup
    // ────────────────────────────────────────────────────────────
    {
      name: 'chatwork-instagram',
      script: path.join(REPO_ROOT, 'dist/index-instagram.js'),
      cwd: REPO_ROOT,

      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: MEM_HEAVY,

      out_file:   path.join(REPO_ROOT, 'logs/pm2-instagram-out.log'),
      error_file: path.join(REPO_ROOT, 'logs/pm2-instagram-err.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      env: { NODE_ENV: 'production' },
    },

    // ────────────────────────────────────────────────────────────
    // TikTok 自動投稿（常駐・node-cron 管理）
    //   平日 12:00 / 19:00 JST に投稿（index-tiktok.ts で制御）
    //   ※ 初回: npm run tiktok:setup
    // ────────────────────────────────────────────────────────────
    {
      name: 'chatwork-tiktok',
      script: path.join(REPO_ROOT, 'dist/index-tiktok.js'),
      cwd: REPO_ROOT,

      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: MEM_HEAVY,

      out_file:   path.join(REPO_ROOT, 'logs/pm2-tiktok-out.log'),
      error_file: path.join(REPO_ROOT, 'logs/pm2-tiktok-err.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      env: { NODE_ENV: 'production' },
    },

    // ────────────────────────────────────────────────────────────
    // note 日次まとめ記事（常駐・node-cron 管理）
    //   毎日 07:30 JST に投稿（index-note.ts で制御）
    // ────────────────────────────────────────────────────────────
    {
      name: 'chatwork-note',
      script: path.join(REPO_ROOT, 'dist/index-note.js'),
      cwd: REPO_ROOT,

      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: MEM_MEDIUM,

      out_file:   path.join(REPO_ROOT, 'logs/pm2-note-out.log'),
      error_file: path.join(REPO_ROOT, 'logs/pm2-note-err.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      env: { NODE_ENV: 'production' },
    },

  ],
};
