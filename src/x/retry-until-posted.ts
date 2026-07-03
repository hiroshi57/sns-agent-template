/**
 * X.com ログイン制限解除を待ってから自動投稿するスクリプト
 *
 * 使い方:
 *   npx ts-node src/x/retry-until-posted.ts [--slot slot07]
 *
 * 5分おきにログインを試み、成功したら即座に投稿する。
 * 制限中は待機してリトライし続ける。
 */
import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';

const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5分

const args = process.argv.slice(2);
const slotArgIdx = args.indexOf('--slot');
const slot = slotArgIdx >= 0 ? args[slotArgIdx + 1] : 'slot07';

async function tryPost(): Promise<'success' | 'rate_limited' | 'error'> {
  return new Promise((resolve) => {
    const child = spawn(
      'npx', ['ts-node', path.join(__dirname, '../index-x.ts'), '--once', '--force', '--slot', slot],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: true }
    );

    let output = '';
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); process.stdout.write(d); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); process.stderr.write(d); });

    child.on('close', (code) => {
      if (output.includes('一時的に制限') || output.includes('temporarily locked') || output.includes('Too many')) {
        resolve('rate_limited');
      } else if (code === 0 || output.includes('投稿完了') || output.includes('成功:')) {
        resolve('success');
      } else {
        resolve('error');
      }
    });
  });
}

async function main() {
  let attempt = 1;
  logger.info(`X.com 制限解除待機モード — スロット: ${slot}`);
  logger.info('制限が解除されるまで5分おきにリトライします。Ctrl+C で停止。');

  while (true) {
    logger.info(`\n[試行 ${attempt}] ${new Date().toLocaleTimeString('ja-JP')} — ログイン試行中...`);
    const result = await tryPost();

    if (result === 'success') {
      logger.info('投稿成功！');
      process.exit(0);
    } else if (result === 'rate_limited') {
      logger.warn(`制限中 — ${RETRY_INTERVAL_MS / 60000}分後にリトライします...`);
      await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
      attempt++;
    } else {
      logger.error('予期しないエラー — 5分後にリトライします...');
      await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
      attempt++;
    }
  }
}

main().catch(err => {
  logger.error(`エラー: ${err}`);
  process.exit(1);
});
