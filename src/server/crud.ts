import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/connection.js';
import { asObject, assertScalar } from './validate.js';

interface CrudSpec {
  table: string;
  path: string;
  /** writable columns (camelCase in the API → snake_case in the DB) */
  columns: string[];
  orderBy?: string;
  idType?: 'int' | 'text';
  allowCreate?: boolean;
  allowDelete?: boolean;
}

export const snake = (s: string) => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
export const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

export function toApi<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v]));
}

/** Pick allowed fields from a camelCase JSON body (400 unless it is an object of plain values) and return snake_case column → value. */
export function pickColumns(rawBody: unknown, columns: string[]): Record<string, unknown> {
  const body = asObject(rawBody);
  const out: Record<string, unknown> = {};
  for (const col of columns) {
    const key = camel(col);
    if (key in body) {
      assertScalar(key, body[key]);
      out[col] = body[key] === '' ? null : body[key];
    }
  }
  return out;
}

/** Simple list/create/update/delete routes for a settings-style table. */
export function registerCrud(app: FastifyInstance, db: DB, spec: CrudSpec): void {
  const cols = spec.columns.map(snake);
  const id = (raw: string) => (spec.idType === 'text' ? raw : Number(raw));

  app.get(`/api/${spec.path}`, async () =>
    (db.prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.orderBy ?? 'id'}`).all() as Record<string, unknown>[]).map(toApi));

  if (spec.allowCreate !== false) {
    app.post(`/api/${spec.path}`, async (req, reply) => {
      const values = pickColumns(req.body as Record<string, unknown>, cols);
      const keys = Object.keys(values);
      if (!keys.length) return reply.code(400).send({ error: 'no fields' });
      const res = db.prepare(`INSERT INTO ${spec.table} (${keys.join(', ')}) VALUES (${keys.map(k => `@${k}`).join(', ')})`).run(values);
      return toApi(db.prepare(`SELECT * FROM ${spec.table} WHERE rowid = ?`).get(res.lastInsertRowid) as Record<string, unknown>);
    });
  }

  app.patch(`/api/${spec.path}/:id`, async (req, reply) => {
    const values = pickColumns(req.body as Record<string, unknown>, cols);
    const keys = Object.keys(values);
    if (!keys.length) return reply.code(400).send({ error: 'no fields' });
    const res = db.prepare(`UPDATE ${spec.table} SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @__id`)
      .run({ ...values, __id: id((req.params as { id: string }).id) });
    if (!res.changes) return reply.code(404).send({ error: 'not found' });
    return toApi(db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id((req.params as { id: string }).id)) as Record<string, unknown>);
  });

  if (spec.allowDelete !== false) {
    app.delete(`/api/${spec.path}/:id`, async req => {
      db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(id((req.params as { id: string }).id));
      return { ok: true };
    });
  }
}
