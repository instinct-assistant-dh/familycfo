import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { buildApp, installShutdown } from '../src/server/index.js';
import { pickColumns } from '../src/server/crud.js';
import { asObject, assertScalar, finiteNumber, integerInRange, safeJsonParse } from '../src/server/validate.js';
import { SECURITY_HEADERS } from '../src/server/requestGuard.js';
import { addAccount, addTx, testDb } from './helpers.js';

let db: DB; let app: ReturnType<typeof buildApp>;
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request in isolated hardening test'); })); db = testDb(); app = buildApp(db); });
afterEach(async () => { await app.close(); db.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const send = (method: 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as object, headers: { 'content-type': 'application/json', ...headers } });

describe('response headers', () => {
  it('every API response is uncacheable, unsniffable and unframeable', async () => {
    const r = await app.inject('/api/meta');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(r.headers[name], name).toBe(value);
    expect((await app.inject({ url: '/api/meta', headers: { host: 'evil.example' } })).headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('request bodies', () => {
  it.each([['null', 'null'], ['a list', '[1,2]'], ['a number', '5'], ['a string', '"x"']])('rejects %s as a JSON body with 400', async (_n, raw) => {
    for (const url of ['/api/tags', '/api/settings', '/api/fx', '/api/transactions/manual']) {
      const r = await app.inject({ method: url === '/api/settings' || url === '/api/fx' ? 'PUT' : 'POST', url, payload: raw, headers: { 'content-type': 'application/json' } });
      expect(r.statusCode, url).toBe(400);
    }
  });
  it('rejects objects, lists and oversized text in a column value, with no SQL text in the answer', async () => {
    for (const bad of [{ name: { a: 1 } }, { name: ['x'] }, { name: 'x'.repeat(10_001) }]) {
      const r = await send('POST', '/api/tags', bad); expect(r.statusCode, JSON.stringify(bad).slice(0, 40)).toBe(400); expect(r.body).not.toMatch(/SQLite|binding|sql/i);
    }
    expect((await send('POST', '/api/tags', { name: 'Fine', budget: 5 })).statusCode).toBe(200);
  });
  it('maps a violated constraint to 409 and never leaks internal errors on a 500', async () => {
    await send('POST', '/api/tags', { name: 'Same' });
    const dup = await send('POST', '/api/tags', { name: 'Same' }); expect(dup.statusCode).toBe(409); expect(dup.json().error).toBe('the change conflicts with existing data');
    vi.stubEnv('LOG_LEVEL', 'silent');
    const boom = buildApp(db); boom.get('/api/boom', async () => { throw new Error('SELECT secret FROM /home/user/bank.db failed'); });
    const r = await boom.inject('/api/boom'); expect(r.statusCode).toBe(500); expect(r.json()).toEqual({ error: 'internal error' }); await boom.close();
  });
});

describe('settings and exchange rates', () => {
  it('stores valid settings and rejects bad ones without changing anything', async () => {
    expect((await send('PUT', '/api/settings', { cycle_start_day: 10, balance_buffer: '2500', ignored: 'x' })).statusCode).toBe(200);
    expect((await app.inject('/api/meta')).json().settings).toMatchObject({ cycle_start_day: '10', balance_buffer: '2500' });
    for (const bad of [{ cycle_start_day: 0 }, { cycle_start_day: 29 }, { cycle_start_day: 'abc' }, { cycle_start_day: 1.5 }, { balance_buffer: 'lots' }, { cycle_start_day: 5, balance_buffer: null }]) {
      expect((await send('PUT', '/api/settings', bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await app.inject('/api/meta')).json().settings).toMatchObject({ cycle_start_day: '10', balance_buffer: '2500' });
  });
  it('validates currency, rate and date for manual FX rates', async () => {
    expect((await send('PUT', '/api/fx', { currency: 'usd', rate: 3.6, date: '2026-09-01' })).statusCode).toBe(200);
    expect((await app.inject('/api/fx')).json()).toEqual([{ currency: 'USD', rate_to_ils: 3.6, date: '2026-09-01', source: 'manual' }]);
    for (const bad of [{ currency: 'DOLLAR', rate: 3 }, { currency: 'US', rate: 3 }, { currency: 5, rate: 3 }, { currency: 'USD', rate: 0 }, { currency: 'USD', rate: -1 }, { currency: 'USD', rate: 'x' }, { currency: 'USD', rate: 3, date: '2026-02-31' }]) {
      expect((await send('PUT', '/api/fx', bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await send('PUT', '/api/fx', { currency: 'EUR', rate: 4 })).statusCode).toBe(200);
  });
});

describe('validation helpers', () => {
  it('check types, ranges and parse stored JSON safely', () => {
    expect(() => asObject([])).toThrow(/object/); expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(() => assertScalar('x', undefined)).toThrow(); expect(() => assertScalar('x', NaN)).toThrow(); expect(() => assertScalar('x', true)).not.toThrow(); expect(() => assertScalar('x', null)).not.toThrow();
    expect(integerInRange('7', 1, 28, 'd')).toBe(7); expect(() => integerInRange('', 1, 28, 'd')).toThrow(); expect(() => integerInRange(true, 1, 28, 'd')).toThrow();
    expect(finiteNumber('2.5', 'n')).toBe(2.5); expect(() => finiteNumber(Infinity, 'n')).toThrow(); expect(() => finiteNumber('', 'n')).toThrow();
    expect(safeJsonParse('{"a":1}', null)).toEqual({ a: 1 }); expect(safeJsonParse('{broken', 'fallback')).toBe('fallback'); expect(safeJsonParse(null, 5)).toBe(5); expect(safeJsonParse('', 5)).toBe(5);
    expect(() => pickColumns(null, ['a'])).toThrow(); expect(pickColumns({ ownerId: 3, ignored: 1 }, ['owner_id'])).toEqual({ owner_id: 3 });
  });
});

describe('damaged stored data', () => {
  it('a corrupt pension row degrades to empty details instead of failing the page', async () => {
    db.prepare(`INSERT INTO assets (name, type, details) VALUES ('Synthetic fund', 'pension', '{broken')`).run();
    db.prepare(`INSERT INTO pension_reports (as_of, source, summary) VALUES ('2026-09-01', 'synthetic', 'also broken')`).run();
    const r = await app.inject('/api/pension'); expect(r.statusCode).toBe(200);
    expect(r.json().products[0].details).toBeNull(); expect(r.json().report.summary).toEqual({});
  });
});

describe('graceful shutdown', () => {
  it('closes the app and database once on SIGINT/SIGTERM', async () => {
    const handlers: Record<string, () => void> = {}; const exit = vi.fn();
    const closing = buildApp(db); const closeApp = vi.spyOn(closing, 'close'); const closeDb = vi.spyOn(db, 'close');
    installShutdown(closing, db, { once: ((sig: string, fn: () => void) => { handlers[sig] = fn; }) as never, exit: exit as never });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    handlers.SIGINT(); handlers.SIGTERM();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(closeApp).toHaveBeenCalledOnce(); expect(closeDb).toHaveBeenCalledOnce(); expect(exit).toHaveBeenCalledOnce();
  });
});

describe('insurance documents', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'familycfo-doc-')); vi.stubEnv('POLICIES_DIR', join(dir, 'policies')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  it('matchesMime judges the first bytes of each supported type', async () => {
    vi.resetModules(); const { matchesMime } = await import('../src/server/routes/insurance.js');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
    expect(matchesMime('application/pdf', Buffer.from('%PDF-1.7 x'))).toBe(true);
    expect(matchesMime('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
    expect(matchesMime('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(matchesMime('image/webp', webp)).toBe(true);
    expect(matchesMime('image/webp', Buffer.from('RIFF....WAVE'))).toBe(false);
    expect(matchesMime('application/pdf', Buffer.from('<html><script>alert(1)</script>'))).toBe(false);
    expect(matchesMime('image/svg+xml', Buffer.from('<svg/>'))).toBe(false);
  });
  it('rejects a file whose content is not its declared type and cleans the stored name', async () => {
    vi.resetModules(); const insurance = await import('../src/server/routes/insurance.js');
    const local = Fastify(); insurance.insuranceRoutes(local, db);
    const id = (await local.inject({ method: 'POST', url: '/api/insurance', payload: { name: 'Synthetic policy' } })).json().id;
    const upload = (body: Buffer, name: string, type = 'application/pdf') => local.inject({ method: 'POST', url: `/api/insurance/${id}/documents?name=${encodeURIComponent(name)}`, payload: body, headers: { 'content-type': type } });
    expect((await upload(Buffer.from('<html>not a pdf</html>'), 'a.pdf')).statusCode).toBe(415);
    expect(db.prepare('SELECT count(*) FROM insurance_documents').pluck().get()).toBe(0);
    const ok = await upload(Buffer.from('%PDF-1.4 synthetic'), `evil\u0000\n${'x'.repeat(300)}.pdf`);
    expect(ok.statusCode).toBe(200); const doc = ok.json(); expect(doc.originalName).not.toMatch(/[\u0000-\u001f]/); expect(doc.originalName.length).toBeLessThanOrEqual(200);
    const file = await local.inject(`/api/insurance/documents/${doc.id}/file`); expect(file.statusCode).toBe(200);
    await local.close();
  });
});

describe('transactions still work through the guarded app', () => {
  it('lists transactions with the new headers (smoke)', async () => {
    addAccount(db, 'card:test', 'card'); addTx(db, { account: 'card:test', date: '2026-09-01', description: 'Synthetic shop', amount: -10, kind: 'expense' });
    const r = await app.inject('/api/transactions'); expect(r.statusCode).toBe(200); expect(r.json().total).toBe(1); expect(r.headers['cache-control']).toBe('no-store');
  });
});
