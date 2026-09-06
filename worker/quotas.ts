import type { SiteLimits } from '../shared/contracts';
import { HttpError } from './core';

export interface Charges { uploads?: number; downloads?: number; classA?: number; classB?: number }
type Metric = keyof Charges;
type Window = 'day' | 'month';

/** Admission counters, not Cloudflare billing estimates. Never refund an R2
 * attempt: a timeout can occur after Cloudflare has processed the operation. */
export function consumeBudget(sql: SqlStorage, limits: SiteLimits, charges: Charges, now = Date.now()) {
  const date = new Date(now);
  const ends = {
    day: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
    month: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
  const rules: [Metric, Window, number, string][] = [
    ['uploads', 'day', limits.uploadsPerDay, '今日全站上传'],
    ['downloads', 'day', limits.downloadsPerDay, '今日全站下载'],
    ['downloads', 'month', limits.downloadsPerMonth, '本月全站下载'],
    ['classA', 'day', limits.r2ClassAPerDay, '今日全站存储写入'],
    ['classA', 'month', limits.r2ClassAPerMonth, '本月全站存储写入'],
    ['classB', 'day', limits.r2ClassBPerDay, '今日全站存储读取'],
    ['classB', 'month', limits.r2ClassBPerMonth, '本月全站存储读取'],
  ];
  const writes: { id: string; used: number; due: number }[] = [];
  // Check every affected counter before changing any of them. The caller runs
  // this synchronously in its SQLite transaction with the operation reservation.
  for (const [metric, window, maximum, label] of rules) {
    const amount = charges[metric] ?? 0;
    if (amount === 0) continue;
    const id = `${metric}:${window}`;
    const row = sql.exec<{ used: number; due: number }>('SELECT used, due FROM budgets WHERE id = ?', id).toArray()[0];
    const used = row && row.due > now ? row.used : 0;
    if (used > maximum - amount) {
      throw new HttpError(429, 'SITE_QUOTA_EXCEEDED', `${label}额度已用完，请在额度重置后重试。`, Math.max(1, Math.ceil((ends[window] - now) / 1000)));
    }
    writes.push({ id, used: used + amount, due: ends[window] });
  }
  for (const row of writes) {
    sql.exec('INSERT INTO budgets(id, used, due) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET used=excluded.used, due=excluded.due', row.id, row.used, row.due);
  }
}
