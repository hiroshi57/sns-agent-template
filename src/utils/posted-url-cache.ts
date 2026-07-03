import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const DEFAULT_CACHE_FILE = path.join(process.cwd(), 'data', 'posted-urls.json');

interface CacheEntry {
  url: string;
  postedAt: string; // ISO 8601
}

interface CacheData {
  version: 1;
  entries: CacheEntry[];
}

/**
 * 投稿済み URL のキャッシュを管理する。
 * 同じ URL が Chatwork に再共有されても二重投稿を防ぐ。
 *
 * デフォルトのデータは `data/posted-urls.json` に永続化される。
 * X 投稿用など別サービス向けには cacheFile を指定して分離できる。
 *
 * @example
 *   // Forte.AI 用（デフォルト）
 *   const cache = new PostedUrlCache();
 *   // X 投稿用
 *   const xCache = new PostedUrlCache('data/x-posted-urls.json');
 */
export class PostedUrlCache {
  private data: CacheData;
  private cacheFile: string;

  constructor(cacheFile?: string) {
    this.cacheFile = cacheFile
      ? path.isAbsolute(cacheFile)
        ? cacheFile
        : path.join(process.cwd(), cacheFile)
      : DEFAULT_CACHE_FILE;
    this.data = this.load();
  }

  // ----------------------------------------------------------------
  // 公開 API
  // ----------------------------------------------------------------

  /** URL が既に投稿済みかどうかを確認する */
  has(url: string): boolean {
    return this.data.entries.some((e) => e.url === url);
  }

  /**
   * URL を投稿済みとして記録する。
   * すでに記録済みの場合は何もしない。
   */
  add(url: string): void {
    if (this.has(url)) return;
    this.data.entries.push({ url, postedAt: new Date().toISOString() });
    this.save();
    logger.info(`投稿済みキャッシュに追加: ${url}`);
  }

  /** キャッシュのエントリ数 */
  get size(): number {
    return this.data.entries.length;
  }

  /**
   * 指定日数より古いエントリを削除して JSON を保存する。
   * @param daysToKeep この日数以内の投稿のみ保持（デフォルト: 90日）
   * @returns 削除されたエントリ数
   */
  pruneOld(daysToKeep = 90): number {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter(
      (e) => new Date(e.postedAt).getTime() >= cutoff
    );
    const removed = before - this.data.entries.length;
    if (removed > 0) {
      this.save();
      logger.info(`投稿済みキャッシュ: ${removed} 件の古いエントリを削除（保持期間: ${daysToKeep}日）`);
    }
    return removed;
  }

  // ----------------------------------------------------------------
  // 内部実装
  // ----------------------------------------------------------------

  private load(): CacheData {
    const dir = path.dirname(this.cacheFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.cacheFile)) {
      return { version: 1, entries: [] };
    }

    try {
      const raw = fs.readFileSync(this.cacheFile, 'utf-8');
      const parsed = JSON.parse(raw) as CacheData;
      logger.info(`投稿済みキャッシュ読み込み: ${parsed.entries.length} 件 (${this.cacheFile})`);
      // 500 件超えたら 90 日以前の古いエントリを自動削除（ファイル肥大化防止）
      if (parsed.entries.length > 500) {
        const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
        const before = parsed.entries.length;
        parsed.entries = parsed.entries.filter(
          (e) => new Date(e.postedAt).getTime() >= cutoff
        );
        if (parsed.entries.length < before) {
          logger.info(`投稿済みキャッシュ: 自動クリーンアップ ${before - parsed.entries.length} 件削除 → ${parsed.entries.length} 件`);
          fs.writeFileSync(this.cacheFile, JSON.stringify(parsed, null, 2), 'utf-8');
        }
      }
      return parsed;
    } catch (err) {
      logger.warn(`キャッシュファイル読み込みエラー（空で初期化）: ${err instanceof Error ? err.message : String(err)}`);
      return { version: 1, entries: [] };
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.cacheFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`キャッシュファイル書き込みエラー: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
