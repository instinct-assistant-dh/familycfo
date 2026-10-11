import type { FastifyInstance } from 'fastify';

/**
 * The API has no login and binds to 127.0.0.1, which keeps other computers out but not the user's own browser.
 * This guard closes the two ways a web page can still reach it:
 *  - DNS rebinding: the page's domain is switched to 127.0.0.1, so its requests carry a foreign `Host` header;
 *  - cross-site writes: a plain form POST (no preflight) from another site carries a foreign `Origin` header.
 * Requests without an `Origin` (curl, scripts, same-origin GETs) are allowed: only a browser sends one, and a
 * browser always sends it on a cross-site write.
 * It also adds response headers that keep the browser from caching, sniffing or framing the data, and rejects a JSON
 * body that is not an object (`null`, a list, a number), which no route accepts.
 */
const LOOPBACK_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/i;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Types a cross-site HTML form can send without a CORS preflight — never legitimate for this API. */
const FORM_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);

/** `host` is a `Host` header value ("localhost:4310"); true when it names this computer's loopback. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const match = LOOPBACK_AUTHORITY.exec(host);
  return !!match && match[0] === host && (match[1] === undefined || (Number(match[1]) >= 1 && Number(match[1]) <= 65535));
}

/** True when an `Origin` header value is a page served from the loopback (the app's own web UI, any port). */
export function isLoopbackOrigin(origin: string): boolean {
  return origin.startsWith('http://') && isLoopbackHost(origin.slice(7));
}

/** Headers for every API response (the SSE chat sets the same ones itself because it writes the raw response). */
export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  // balances and transactions must not sit in the browser or a proxy cache
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  // nobody may put the API (or a document it serves) in a frame
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};

/** Register before any route so the hook covers all of them. */
export function registerRequestGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!isLoopbackHost(req.headers.host)) return reply.code(403).send({ error: 'forbidden host' });
    if (!WRITE_METHODS.has(req.method)) return;

    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) return reply.code(403).send({ error: 'forbidden origin' });

    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (FORM_TYPES.has(type)) return reply.code(415).send({ error: 'unsupported content type' });
  });

  app.addHook('preValidation', async (req, reply) => {
    if (!WRITE_METHODS.has(req.method) || req.body === undefined) return;
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type === 'application/json' && (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))) {
      return reply.code(400).send({ error: 'a JSON object body is required' });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    return payload;
  });
}
