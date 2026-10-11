import Fastify from 'fastify';
import { pathToFileURL } from 'url';
import type { DB } from '../db/connection.js';
import { getDb } from '../db/connection.js';
import { registerCrud, toApi } from './crud.js';
import { transactionRoutes } from './routes/transactions.js';
import { analyticsRoutes } from './routes/analytics.js';
import { eventRoutes } from './routes/events.js';
import { categoryRoutes } from './routes/categories.js';
import { agentRoutes } from './agent.js';
import { insuranceRoutes } from './routes/insurance.js';
import { pensionRoutes } from './routes/pension.js';
import { investmentRoutes } from './routes/investments.js';
import { setRate } from '../analytics/fx.js';
import { registerRequestGuard } from './requestGuard.js';
import { asObject, badRequest, finiteNumber, integerInRange } from './validate.js';
import { isCalendarDate } from './routes/transactions.js';
import { stopAgentChildren } from './agent.js';
import { warnBroadPermissions } from '../permissions.js';
import { credentialsAreEncrypted } from '../config.js';
import { unlockSecrets } from '../secrets.js';

// Local-only: this API exposes the household's full financial data and has no login
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4310);

/** Build the same guarded app used in production, without opening a socket or database. */
export function buildApp(db: DB) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });
  // Host / Origin checks against DNS rebinding and cross-site writes; before the routes so it covers all of them
  registerRequestGuard(app);

  registerCrud(app, db, { table: 'members', path: 'members', columns: ['name', 'color'], allowDelete: false });
  registerCrud(app, db, {
    table: 'accounts', path: 'accounts', idType: 'text', allowCreate: false, allowDelete: false,
    columns: ['displayName', 'ownerMemberId', 'billingBankAccountId', 'active'], orderBy: 'kind, id',
  });
  registerCrud(app, db, { table: 'businesses', path: 'businesses', columns: ['name', 'color', 'archived'], orderBy: 'name' });
  registerCrud(app, db, { table: 'tags', path: 'tags', columns: ['name', 'color', 'startDate', 'endDate', 'budget', 'notes', 'archived'], orderBy: 'name' });
  registerCrud(app, db, { table: 'sinking_funds', path: 'funds', columns: ['name', 'monthlyTarget', 'balance', 'goalAmount', 'goalDate'] });
  registerCrud(app, db, {
    table: 'assets', path: 'assets', orderBy: 'type, name',
    columns: ['name', 'type', 'provider', 'ownerMemberId', 'currency', 'liquidityDate', 'managementFee', 'monthlyDeposit', 'notes', 'archived'],
  });
  registerCrud(app, db, { table: 'asset_snapshots', path: 'asset-snapshots', columns: ['assetId', 'date', 'value', 'currency'], orderBy: 'date DESC' });
  registerCrud(app, db, {
    table: 'liabilities', path: 'liabilities', orderBy: 'type, name',
    columns: ['name', 'type', 'lender', 'ownerMemberId', 'originalPrincipal', 'interestRate', 'indexType', 'startDate',
      'endDate', 'monthlyPayment', 'paymentDay', 'bankAccountId', 'matchPattern', 'notes', 'archived'],
  });
  registerCrud(app, db, { table: 'liability_snapshots', path: 'liability-snapshots', columns: ['liabilityId', 'date', 'balance'], orderBy: 'date DESC' });
  registerCrud(app, db, {
    table: 'scheduled_items', path: 'scheduled', orderBy: 'day_of_month, name',
    columns: ['name', 'kind', 'amount', 'amountMode', 'dayOfMonth', 'bankAccountId', 'memberId', 'categoryId', 'matchPattern',
      'liabilityId', 'cardAccountId', 'startDate', 'endDate', 'status'],
  });

  app.get('/api/meta', async () => ({
    members: (db.prepare(`SELECT * FROM members ORDER BY id`).all() as Record<string, unknown>[]).map(toApi),
    accounts: (db.prepare(`SELECT * FROM accounts ORDER BY kind, id`).all() as Record<string, unknown>[]).map(toApi),
    categories: (db.prepare(`SELECT * FROM categories ORDER BY name`).all() as Record<string, unknown>[]).map(toApi),
    businesses: (db.prepare(`SELECT * FROM businesses ORDER BY name`).all() as Record<string, unknown>[]).map(toApi),
    tags: (db.prepare(`SELECT * FROM tags ORDER BY name`).all() as Record<string, unknown>[]).map(toApi),
    funds: (db.prepare(`SELECT * FROM sinking_funds ORDER BY id`).all() as Record<string, unknown>[]).map(toApi),
    settings: Object.fromEntries((db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[]).map(s => [s.key, s.value])),
  }));

  app.put('/api/settings', async req => {
    const body = asObject(req.body);
    // validate everything first so a bad value never leaves the settings half-updated
    const values: [string, string][] = [];
    if ('cycle_start_day' in body) values.push(['cycle_start_day', String(integerInRange(body.cycle_start_day, 1, 28, 'cycle_start_day'))]);
    if ('balance_buffer' in body) values.push(['balance_buffer', String(finiteNumber(body.balance_buffer, 'balance_buffer'))]);
    const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    db.transaction(() => { for (const [k, v] of values) upsert.run(k, v); })();
    return { ok: true };
  });

  app.get('/api/fx', async () => db.prepare(`
    SELECT currency, rate_to_ils, date, source FROM fx_rates f
    WHERE date = (SELECT MAX(date) FROM fx_rates WHERE currency = f.currency) ORDER BY currency
  `).all());
  app.put('/api/fx', async req => {
    const b = asObject(req.body);
    const currency = typeof b.currency === 'string' ? b.currency.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(currency)) throw badRequest('currency must be a 3-letter code such as USD');
    const rate = finiteNumber(b.rate, 'rate');
    if (rate <= 0) throw badRequest('rate must be greater than zero');
    const date = b.date ?? new Date().toISOString().slice(0, 10);
    if (!isCalendarDate(date)) throw badRequest('date must be a real YYYY-MM-DD date');
    setRate(db, date, currency, rate);
    return { ok: true };
  });

  transactionRoutes(app, db);
  analyticsRoutes(app, db);
  eventRoutes(app, db);
  categoryRoutes(app, db);
  agentRoutes(app, db);
  insuranceRoutes(app, db);
  pensionRoutes(app, db);
  investmentRoutes(app, db);

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    // a constraint failure means the request referred to something that does not exist or clashes: the caller's problem
    const statusCode = err.statusCode ?? (err.code?.startsWith('SQLITE_CONSTRAINT') ? 409 : 500);
    if (statusCode >= 500) {
      // details stay in the log: SQL text, file paths and stack traces must not reach the browser
      app.log.error(err);
      return reply.code(statusCode).send({ error: 'internal error' });
    }
    return reply.code(statusCode).send({ error: statusCode === 409 && !err.statusCode ? 'the change conflicts with existing data' : err.message });
  });
  return app;
}

/** Close everything cleanly on Ctrl-C / `kill`: stop chat children, finish requests, checkpoint the WAL. */
export function installShutdown(app: ReturnType<typeof buildApp>, db: DB, proc: Pick<NodeJS.Process, 'once' | 'exit'> = process): void {
  let closing = false;
  const stop = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    stopAgentChildren();
    app.close().catch(err => console.error('Shutdown error:', err)).finally(() => {
      try { db.close(); } catch (err) { console.error('Database close error:', err); }
      proc.exit(0);
    });
  };
  proc.once('SIGINT', () => stop('SIGINT'));
  proc.once('SIGTERM', () => stop('SIGTERM'));
}

// Importing buildApp in tests must not start a server or touch the household database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // an encrypted logins file needs its passphrase now (a prompt on a terminal), not in the middle of a scrape
  if (credentialsAreEncrypted()) {
    try { await unlockSecrets(); } catch (err) { console.warn(`WARNING: ${(err as Error).message} Scraping from the app stays disabled until then.`); }
  }
  const db = getDb();
  const app = buildApp(db);
  warnBroadPermissions();
  installShutdown(app, db);
  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    console.error(`Could not start the API on ${HOST}:${PORT}: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`Household API on http://${HOST}:${PORT}`);
}
