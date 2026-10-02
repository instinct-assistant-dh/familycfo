import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { importPensionReport } from '../src/import/pensionReport.js';
import { netWorth } from '../src/analytics/networth.js';
import { transactionRoutes } from '../src/server/routes/transactions.js';
import { addAccount, testDb } from './helpers.js';

let db: DB;
beforeEach(() => { db = testDb(); });
afterEach(() => db.close());

// Expected-failure regressions describe required behavior, not approval of the current bug.
// Vitest fails these tests if the defect is fixed, prompting removal of `.fails`.
describe('confirmed defects awaiting separate production fixes', () => {
  it.fails('pension re-import must not duplicate deposits with an unknown salary month', () => {
    db.prepare("UPDATE members SET name='Invented member' WHERE id=1").run();
    const r = { asOf: '2026-09-01', member: 'Invented member', source: 'Synthetic', summary: { totalSavings: 100 },
      products: [{ type: 'pension' as const, name: 'Invented', provider: 'Provider', policyNumber: 'TEST', balance: 100, status: 'active' as const,
        deposits: [['2026-08-01', null, null, null, null, null, 10] as [string, null, null, null, null, null, number]] }] };
    importPensionReport(db, r); importPensionReport(db, r);
    expect(db.prepare('SELECT COUNT(*) FROM asset_deposits').pluck().get()).toBe(1);
  });
  it.fails('net worth history must choose newest dated snapshot, not newest inserted ID', () => {
    const id = Number(db.prepare("INSERT INTO assets (name, type) VALUES ('Invented', 'deposit')").run().lastInsertRowid);
    const insert = db.prepare("INSERT INTO asset_snapshots (asset_id, date, value, currency) VALUES (?, ?, ?, 'ILS')");
    insert.run(id, '2026-09-15', 200); insert.run(id, '2026-09-01', 100);
    const result = netWorth(db, '2026-09-30');
    expect(result.items[0].valueIls).toBe(200);
    expect(result.history).toEqual([{ date: '2026-09', netWorth: 200 }]);
  });
  it.fails('manual transactions reject impossible calendar dates instead of rolling into March', async () => {
    const app = Fastify(); transactionRoutes(app, db);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/transactions/manual', payload: { date: '2026-02-31', description: 'Invented', amount: 10 } });
      expect(response.statusCode).toBe(400);
      expect(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get()).toBe(0);
    } finally { await app.close(); }
  });
  it.fails('postponing January 31 by a month clamps to February rather than skipping February', async () => {
    addAccount(db, 'bank:test', 'bank');
    const id = Number(db.prepare("INSERT INTO planned_items (description, amount, date, account_id) VALUES ('Invented', 100, '2026-01-31', 'bank:test')").run().lastInsertRowid);
    const app = Fastify(); transactionRoutes(app, db);
    try {
      const response = await app.inject({ method: 'PATCH', url: `/api/planned/${id}`, payload: { postponeMonths: 1 } });
      expect(response.statusCode).toBe(200);
      expect(db.prepare('SELECT date FROM planned_items WHERE id=?').pluck().get(id)).toBe('2026-02-28');
    } finally { await app.close(); }
  });
});
