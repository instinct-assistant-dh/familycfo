/** Small request-validation helpers: a bad request is a 400 with a clear message, never a 500 with SQLite internals. */

export const badRequest = (message: string): Error & { statusCode: number } => Object.assign(new Error(message), { statusCode: 400 });

export const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The JSON body as an object, or a 400 (missing, null, array, number…). */
export function asObject(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) throw badRequest('a JSON object body is required');
  return body;
}

export const MAX_TEXT = 10_000;

/** A value that can be stored in one column: text (bounded), a finite number, a boolean or null. */
export function assertScalar(key: string, value: unknown): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw badRequest(`${key} must be a finite number`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT) throw badRequest(`${key} is too long`);
    return;
  }
  throw badRequest(`${key} must be text, a number, true/false or null`);
}

export function integerInRange(value: unknown, min: number, max: number, name: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

export function finiteNumber(value: unknown, name: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw badRequest(`${name} must be a number`);
  return n;
}

/** JSON.parse for stored text: a damaged row gives the fallback instead of failing a whole page. */
export function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}
