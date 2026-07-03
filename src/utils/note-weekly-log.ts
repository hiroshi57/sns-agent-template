import fs from 'fs';
import path from 'path';
import { XCategory } from './x-category';
import { logger } from './logger';

const LOG_FILE = path.join(process.cwd(), 'data', 'note-weekly-log.json');

export interface NoteWeeklyItem {
  postedAt: string;  // ISO 8601
  url: string;
  title: string;
  summary: string;
  category: XCategory;
  imageUrl?: string;
}

interface NoteWeeklyLog {
  version: 1;
  items: NoteWeeklyItem[];
}

/** X.com 投稿済みアイテムを note 週次ログに追記する */
export function appendNoteWeeklyLog(item: NoteWeeklyItem): void {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const data = loadLog();
    // 同 URL の重複を防ぐ
    if (data.items.some(i => i.url === item.url)) return;
    data.items.push(item);
    fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`note 週次ログ書き込み失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 指定期間（デフォルト: 過去7日）のアイテムを取得する */
export function getRecentItems(daysBack = 7): NoteWeeklyItem[] {
  const data = loadLog();
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  return data.items.filter(i => new Date(i.postedAt).getTime() > cutoff);
}

/** ログを前週分として保持しつつ古いエントリを削除する（30日超を削除） */
export function pruneOldEntries(): void {
  try {
    const data = loadLog();
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    data.items = data.items.filter(i => new Date(i.postedAt).getTime() > cutoff);
    fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2), 'utf-8');
    logger.info(`note 週次ログ: ${data.items.length} 件 (30日超削除済み)`);
  } catch (err) {
    logger.warn(`note 週次ログ prune 失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadLog(): NoteWeeklyLog {
  if (!fs.existsSync(LOG_FILE)) return { version: 1, items: [] };
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    return JSON.parse(raw) as NoteWeeklyLog;
  } catch {
    return { version: 1, items: [] };
  }
}
