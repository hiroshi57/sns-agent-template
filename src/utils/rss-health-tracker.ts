/**
 * RSS ソース死活監視 (#41)
 *
 * 各 RSS ソースの取得成否を記録し、3回連続で失敗したソースを
 * 「死亡」とみなしてスキップリストに追加する。
 *
 * 状態は data/rss-dead-sources.json に永続化する。
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const FAIL_THRESHOLD = 3;  // 連続失敗でスキップリスト入り
const REVIVE_HOURS = 24;   // 24時間後に自動復活を試みる

interface SourceRecord {
  consecutiveFails: number;
  lastFailAt: string | null;
  deadSince: string | null;
}

interface State {
  version: number;
  sources: Record<string, SourceRecord>;
}

export class RssHealthTracker {
  private state: State;
  private readonly stateFile: string;

  constructor(stateFile?: string) {
    // モジュールレベルで固定すると jest の process.cwd() モックが効かないため
    // コンストラクタで評価する
    this.stateFile = stateFile ?? path.join(process.cwd(), 'data', 'rss-dead-sources.json');
    this.state = this.load();
  }

  private load(): State {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, 'utf-8');
        return JSON.parse(raw) as State;
      }
    } catch {
      // 破損していたらリセット
    }
    return { version: 1, sources: {} };
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      logger.warn(`RssHealthTracker: 状態保存失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * ソースの取得結果を記録する。
   * @param source RSS ソース名（url または識別子）
   * @param ok     取得成功なら true、失敗なら false
   */
  record(source: string, ok: boolean): void {
    const rec = this.state.sources[source] ?? {
      consecutiveFails: 0,
      lastFailAt: null,
      deadSince: null,
    };

    if (ok) {
      // 成功: 連続失敗カウントをリセット、死亡状態も解除
      if (rec.consecutiveFails > 0 || rec.deadSince) {
        logger.info(`RssHealth: 復活 [${source}]`);
      }
      rec.consecutiveFails = 0;
      rec.lastFailAt = null;
      rec.deadSince = null;
    } else {
      // 失敗
      rec.consecutiveFails += 1;
      rec.lastFailAt = new Date().toISOString();
      if (rec.consecutiveFails >= FAIL_THRESHOLD && !rec.deadSince) {
        rec.deadSince = new Date().toISOString();
        logger.warn(`RssHealth: 死亡判定 [${source}] (${rec.consecutiveFails}回連続失敗)`);
      }
    }

    this.state.sources[source] = rec;
  }

  /**
   * ソースがスキップ対象（死亡状態）かどうかを返す。
   * 死亡から REVIVE_HOURS 以上経過した場合は自動復活を試みる（isDead=false を返す）。
   */
  isDead(source: string): boolean {
    const rec = this.state.sources[source];
    if (!rec || !rec.deadSince) return false;

    const deadMs = Date.now() - new Date(rec.deadSince).getTime();
    const reviveMs = REVIVE_HOURS * 60 * 60 * 1000;

    if (deadMs > reviveMs) {
      // 自動復活: カウントをリセットして再試行させる
      logger.info(`RssHealth: 自動復活を試みます [${source}]`);
      rec.consecutiveFails = 0;
      rec.deadSince = null;
      return false;
    }

    return true;
  }

  /**
   * 現在死亡中のソース一覧を返す。
   */
  getDeadSources(): Array<{ source: string; deadSince: string; consecutiveFails: number }> {
    return Object.entries(this.state.sources)
      .filter(([, rec]) => rec.deadSince !== null)
      .map(([source, rec]) => ({
        source,
        deadSince: rec.deadSince!,
        consecutiveFails: rec.consecutiveFails,
      }))
      .sort((a, b) => a.deadSince.localeCompare(b.deadSince));
  }

  /**
   * 週次レポート文字列を生成する（pdca-cycle 等から呼び出す）。
   */
  buildWeeklyReport(): string {
    const dead = this.getDeadSources();
    if (dead.length === 0) return '✅ すべての RSS ソースが正常動作中です。';

    const lines = [`⚠️ 死亡中の RSS ソース: ${dead.length}件`];
    for (const { source, deadSince, consecutiveFails } of dead) {
      lines.push(`  - ${source} (${consecutiveFails}回失敗, since ${deadSince.slice(0, 10)})`);
    }
    return lines.join('\n');
  }
}

/** シングルトンインスタンス（モジュール間で共有） */
export const rssHealthTracker = new RssHealthTracker();
