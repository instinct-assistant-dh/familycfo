import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { today } from '../../analytics/common.js';
import { toApi } from '../crud.js';
import { safeJsonParse } from '../validate.js';

/**
 * Pension and long-term savings (pension funds, managers' insurance, study funds, provident funds): every product
 * with its latest value, fees, tracks and deposits, and the latest imported report's own totals.
 */
const TYPES = ['pension', 'keren_hishtalmut', 'kupat_gemel'];
type Row = Record<string, any>;

export function pensionRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/pension', async () => {
    const asOf = today();
    const products = (db.prepare(`
      SELECT a.*, s.value, s.date AS value_date FROM assets a
      LEFT JOIN asset_snapshots s ON s.id = (SELECT id FROM asset_snapshots WHERE asset_id = a.id ORDER BY date DESC, id DESC LIMIT 1)
      WHERE a.archived = 0 AND a.type IN (${TYPES.map(() => '?').join(',')})
      ORDER BY CASE a.type WHEN 'pension' THEN 0 WHEN 'keren_hishtalmut' THEN 1 ELSE 2 END, s.value DESC
    `).all(...TYPES) as Row[]).map((a): Row => {
      const deposits = (db.prepare(`SELECT value_date, salary_month, salary, employee, employer, severance, total FROM asset_deposits
        WHERE asset_id = ? ORDER BY value_date`).all(a.id) as Row[]).map(toApi);
      const { details, ...rest } = a;
      return {
        ...toApi(rest),
        details: safeJsonParse(details, null),
        deposits,
        liquidNow: a.type === 'keren_hishtalmut' && !!a.liquidity_date && a.liquidity_date <= asOf,
      };
    });

    const reports = (db.prepare(`SELECT * FROM pension_reports ORDER BY as_of DESC, id DESC`).all() as Row[])
      // documentPath: where the data chat opens the report file (its docs/ copy of data/)
      .map((r): Row => ({ ...toApi(r), summary: safeJsonParse(r.summary, {}), documentPath: r.file_path ? `docs/${r.file_path}` : null }));

    const sum = (list: Row[], f: (p: Row) => number) => list.reduce((s, p) => s + f(p), 0);
    const value = (p: Row) => Number(p.value ?? 0);
    const inactive = products.filter(p => p.status === 'inactive');
    const liquidStudy = products.filter(p => p.liquidNow);
    return {
      products,
      report: reports[0] ?? null,
      reports: reports.map(r => ({ id: r.id, asOf: r.asOf, source: r.source, memberId: r.memberId })),
      totals: {
        value: sum(products, value),
        byType: Object.fromEntries(TYPES.map(t => [t, sum(products.filter(p => p.type === t), value)])),
        monthlyDeposits: sum(products, p => Number(p.monthlyDeposit ?? 0)),
        expectedAnnuity: sum(products, p => Number(p.expectedAnnuity ?? 0)),
        active: products.length - inactive.length,
        inactive: { count: inactive.length, value: sum(inactive, value) },
        liquidStudyFunds: { count: liquidStudy.length, value: sum(liquidStudy, value) },
      },
    };
  });
}
