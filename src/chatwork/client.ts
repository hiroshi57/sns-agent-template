import axios from 'axios';
import { logger } from '../utils/logger';

const CHATWORK_API_BASE = 'https://api.chatwork.com/v2';

export interface ChatworkMessage {
  message_id: string;
  account: {
    account_id: number;
    name: string;
    avatar_image_url: string;
  };
  body: string;
  send_time: number;
  update_time: number;
}

/**
 * Chatwork API クライアント
 */
export class ChatworkClient {
  private headers: Record<string, string>;

  constructor(apiToken: string) {
    this.headers = { 'X-ChatWorkToken': apiToken };
  }

  /**
   * ルームのメッセージ一覧を取得する
   * @param roomId - チャットルームID
   * @param force - 1: 最新200件を強制取得 / 0: 未取得のみ
   * @param _retry - 内部リトライカウント（直接指定しない）
   */
  async getMessages(roomId: string, force = 0, _retry = 0): Promise<ChatworkMessage[]> {
    const url = `${CHATWORK_API_BASE}/rooms/${roomId}/messages?force=${force}`;
    logger.info(`Chatwork メッセージ取得: roomId=${roomId}${_retry > 0 ? ` (リトライ ${_retry}/3)` : ''}`);

    const res = await axios.get<ChatworkMessage[] | null>(url, {
      headers: this.headers,
      // 204 No Content（未読なし）と 429 レート制限を正常として扱う（throw させない）
      validateStatus: (s) => s < 500,
    });

    // 429 レート制限: exponential backoff でリトライ（最大 3 回）
    if (res.status === 429) {
      if (_retry >= 3) {
        throw new Error(`Chatwork API レート制限 (429): ${_retry} 回リトライ後も解除されず`);
      }
      // Retry-After ヘッダーがあればそれを使用、なければ指数的に増加（2s → 4s → 8s）
      const retryAfterHeader = res.headers['retry-after'];
      const waitSec = retryAfterHeader
        ? parseInt(String(retryAfterHeader), 10)
        : Math.pow(2, _retry + 1);
      logger.warn(`Chatwork API 429 レート制限 → ${waitSec}秒後にリトライ (${_retry + 1}/3)...`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      return this.getMessages(roomId, force, _retry + 1);
    }

    // 204 または空レスポンスは空配列として扱う
    if (res.status === 204 || !res.data || !Array.isArray(res.data)) {
      logger.info('新着メッセージなし (0 件)');
      return [];
    }

    logger.info(`取得件数: ${res.data.length} 件`);
    return res.data;
  }

  /**
   * メッセージ本文から URL を抽出する
   */
  static extractUrls(body: string): string[] {
    // Chatwork のリンク記法: [link]URL[/link] または 生URL
    const linkTagPattern = /\[link\](https?:\/\/[^\s\[\]]+)\[\/link\]/g;
    const plainUrlPattern = /(?<!\[link\])(https?:\/\/[^\s\[\]）」\)]+)/g;

    const urls: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = linkTagPattern.exec(body)) !== null) {
      urls.push(match[1]);
    }
    while ((match = plainUrlPattern.exec(body)) !== null) {
      urls.push(match[1]);
    }

    return [...new Set(urls)]; // 重複排除
  }

  /**
   * 転送対象メッセージかどうかを判定する
   *
   * ✅ 対象: URL を含むメッセージすべて
   * ✅ 対象（任意）: targetAccountIds が指定されていれば、そのアカウントの投稿のみ
   * ❌ 除外: 「DSでもAIでもないが」のように AI/DS 無関係を明示したメッセージ
   *
   * @param message - Chatwork メッセージ
   * @param targetAccountIds - 転送対象の account_id リスト（空の場合は全員）
   */
  static isTransferTarget(
    message: ChatworkMessage,
    targetAccountIds: number[] = []
  ): boolean {
    // ① URL を含まないメッセージは除外
    const urls = ChatworkClient.extractUrls(message.body);
    if (urls.length === 0) return false;

    // ② 投稿者フィルタ（指定がある場合のみ）
    if (targetAccountIds.length > 0) {
      const isTargetAuthor = targetAccountIds.includes(message.account.account_id);
      if (!isTargetAuthor) return false;
    }

    // ③ AI・DS と無関係であることを明示するフレーズが含まれる場合は除外
    const EXCLUDE_PHRASES = [
      'DSでもAIでもないが',
      'DSでもAIでもない',
      'AIでもDSでもないが',
      'AIでもDSでもない',
    ];

    const isExcluded = EXCLUDE_PHRASES.some((phrase) => message.body.includes(phrase));
    if (isExcluded) return false;

    return true;
  }
}
