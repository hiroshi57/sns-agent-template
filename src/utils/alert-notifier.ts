/**
 * KPI アラート通知ユーティリティ  (#23)
 *
 * KPI が N 日連続未達の場合に通知を送信する。
 *
 * サポートする通知先（GitHub Secrets または .env で設定）:
 *   LINE_NOTIFY_TOKEN    … LINE Notify API トークン
 *   SLACK_WEBHOOK_URL    … Slack Incoming Webhook URL
 *   DISCORD_WEBHOOK_URL  … Discord Webhook URL
 *
 * 設定方法:
 *   GitHub → Settings → Secrets に上記いずれかを追加するだけで有効になる
 */
import axios from 'axios';
import { logger } from './logger';

/**
 * 任意の通知先にアラートを送信する。
 * 設定されている通知先が1つもない場合は警告ログを出す。
 */
export async function sendKpiAlert(title: string, body: string): Promise<void> {
  const message = `${title}\n${body}`;
  const sent: string[] = [];

  // ── LINE Notify ──────────────────────────────────────────────
  const lineToken = process.env['LINE_NOTIFY_TOKEN'];
  if (lineToken) {
    try {
      await axios.post(
        'https://notify-api.line.me/api/notify',
        new URLSearchParams({ message: `\n${message}` }).toString(),
        {
          headers: {
            Authorization: `Bearer ${lineToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 10000,
        }
      );
      sent.push('LINE');
    } catch (err) {
      logger.warn(`[Alert] LINE 通知失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Slack Incoming Webhook ────────────────────────────────────
  const slackUrl = process.env['SLACK_WEBHOOK_URL'];
  if (slackUrl) {
    try {
      await axios.post(slackUrl, { text: message }, { timeout: 10000 });
      sent.push('Slack');
    } catch (err) {
      logger.warn(`[Alert] Slack 通知失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Discord Webhook ───────────────────────────────────────────
  const discordUrl = process.env['DISCORD_WEBHOOK_URL'];
  if (discordUrl) {
    try {
      await axios.post(discordUrl, { content: message }, { timeout: 10000 });
      sent.push('Discord');
    } catch (err) {
      logger.warn(`[Alert] Discord 通知失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (sent.length > 0) {
    logger.info(`[Alert] 通知送信完了: ${sent.join(', ')}`);
  } else {
    logger.warn(
      '[Alert] 通知先が未設定です。' +
      'LINE_NOTIFY_TOKEN / SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL ' +
      'のいずれかを GitHub Secrets に設定してください。'
    );
  }
}
