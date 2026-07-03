/**
 * アフィリエイト投稿のスケジュールガード。
 *
 * pm2 は cron ジョブを登録(pm2 start)した瞬間に1回即実行する仕様のため、
 * 登録時の予定外投稿を防ぐ目的で「スケジュール対象曜日(既定: 月曜)以外は
 * 実投稿をスキップ」する。dryRun / force は曜日に関わらず常に許可。
 *
 * ※ ecosystem.config.js の cron_restart('0 3 * * 1' = 月曜) と曜日を揃えること。
 */
export interface AffiliateScheduleOpts {
  /** 判定基準時刻（既定: 現在） */
  now?: Date;
  /** 強制実行（手動投稿など） */
  force?: boolean;
  /** ドライラン（検証用・実投稿しない） */
  dryRun?: boolean;
  /** スケジュール対象曜日 0=日 .. 6=土（既定: 1=月） */
  scheduledDow?: number;
}

/** 実投稿してよい日かどうかを判定する */
export function shouldRunAffiliatePost(opts: AffiliateScheduleOpts = {}): boolean {
  const { now = new Date(), force = false, dryRun = false, scheduledDow = 1 } = opts;
  if (dryRun || force) return true;
  return now.getDay() === scheduledDow;
}
