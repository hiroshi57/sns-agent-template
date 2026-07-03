/**
 * ローカルの state/x-session.json を GitHub Secrets (X_SESSION_JSON) に保存する。
 *
 * 使い方:
 *   npm run x:save-secret
 *
 * 前提: gh CLI がインストール済みで `gh auth login` 済みであること。
 * インストール: https://cli.github.com/
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const SESSION_FILE = path.join(process.cwd(), 'state', 'x-session.json');

if (!fs.existsSync(SESSION_FILE)) {
  console.error('エラー: state/x-session.json が見つかりません。先に npm run x:setup を実行してください。');
  process.exit(1);
}

const session = fs.readFileSync(SESSION_FILE, 'utf-8');
let parsed: { cookies?: { name: string }[] };
try {
  parsed = JSON.parse(session);
} catch {
  console.error('エラー: state/x-session.json が不正な JSON です。');
  process.exit(1);
}

const authCookies = (parsed.cookies ?? []).filter(
  (c) => ['auth_token', 'ct0', 'twid'].includes(c.name)
);
if (authCookies.length < 3) {
  console.error(`エラー: セッションに認証 Cookie が不足しています (${authCookies.map(c => c.name).join(', ')})。`);
  console.error('先に npm run x:setup でログインし直してください。');
  process.exit(1);
}

console.log(`セッション確認: auth_token / ct0 / twid ✅`);
console.log('GitHub Secrets (X_SESSION_JSON) に保存中...');

try {
  // gh secret set は stdin から読み込む形式が最も安全
  execSync(`gh secret set X_SESSION_JSON`, {
    input: session,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log('✅ X_SESSION_JSON を GitHub Secrets に保存しました。');
  console.log('   次回の GitHub Actions 実行から新しいセッションが使われます。');
} catch (err) {
  console.error('エラー: gh CLI の実行に失敗しました。');
  console.error('gh CLI がインストールされているか確認してください: https://cli.github.com/');
  console.error('インストール後: gh auth login');
  process.exit(1);
}
