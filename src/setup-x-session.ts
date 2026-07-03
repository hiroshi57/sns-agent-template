/**
 * X.com セッション初期設定スクリプト
 *
 * 使い方:
 *   npx ts-node src/setup-x-session.ts
 *
 * ブラウザが開くので X.com に手動でログインしてください。
 * ホーム画面が表示されたら Enter を押すと state/x-session.json が保存されます。
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const SESSION_FILE = path.join(process.cwd(), 'state', 'x-session.json');

async function main() {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  X.com セッション初期設定');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ブラウザが開きます。X.com にログインしてください。');
  console.log('  ホーム画面が表示されたら Enter を押してください。');
  console.log('');

  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded' });

  // ユーザーが手動でログインするのを待つ
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  await new Promise<void>((resolve) => {
    rl.question('\nX.com のホーム画面が表示されたら Enter を押してください: ', () => {
      rl.close();
      resolve();
    });
  });

  const currentUrl = page.url();
  if (!currentUrl.includes('x.com/home') && !currentUrl.includes('x.com/i/')) {
    console.log(`⚠️  現在のURL: ${currentUrl}`);
    console.log('   ホーム画面ではないかもしれませんが、セッションを保存します...');
  }

  await context.storageState({ path: SESSION_FILE });
  await browser.close();

  console.log('');
  console.log(`✅ セッション保存完了: ${SESSION_FILE}`);
  console.log('');
  console.log('次のコマンドで X への投稿を実行できます:');
  console.log('  npm run x:once');
  console.log('');
}

main().catch((err) => {
  console.error('エラー:', err);
  process.exit(1);
});
