import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { CompanyTypes } from 'israeli-bank-scrapers';
import type { Config } from './scraper.js';
import { decryptText, isEnvelope, passphraseFromEnvironment, SecretsError } from './secrets.js';

/** The plain bank logins file (git-ignored). `ACCOUNTS_FILE` overrides the path. Prefer the encrypted file below. */
export const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'accounts.json';
/** The encrypted bank logins file written by `npm run secrets:encrypt`. `ACCOUNTS_ENC_FILE` overrides the path. */
export const ENCRYPTED_ACCOUNTS_FILE = process.env.ACCOUNTS_ENC_FILE || 'accounts.enc.json';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The categorizer receives every transaction description: only https, or http to this computer. */
export function assertSafeCategoryUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('categoryApiUrl is not a valid URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error('categoryApiUrl must use https (plain http is only allowed for localhost)');
  }
  if (url.username || url.password) throw new Error('categoryApiUrl must not contain a username or password');
  return value;
}

const configSchema = z.object({
  accounts: z.array(z.object({
    companyId: z.string().refine(id => Object.prototype.hasOwnProperty.call(CompanyTypes, id), id => ({ message: `unknown bank or card company "${id}"` })),
    credentials: z.record(z.string()),
  })),
  categoryApiUrl: z.string().refine(v => { try { assertSafeCategoryUrl(v); return true; } catch { return false; } },
    { message: 'must be an https URL (http only for localhost) without a username or password' }).optional(),
}).passthrough();

/** Check the shape of the logins file without ever echoing its values back in the error. */
export function parseConfig(raw: unknown, source: string): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`${source} is not a valid configuration (${problems}); see accounts.example.json`);
  }
  return result.data as unknown as Config;
}

let warnedPlaintext = false;

/** True when an encrypted logins file exists (so a passphrase is needed before scraping). */
export const credentialsAreEncrypted = () => existsSync(ENCRYPTED_ACCOUNTS_FILE);

/**
 * The bank logins, read on demand by whoever scrapes. The encrypted file wins; a plain file still works but
 * warns once. Decryption needs the passphrase (see `unlockSecrets` in src/secrets.ts).
 */
export function loadConfig(): Config {
  if (existsSync(ENCRYPTED_ACCOUNTS_FILE)) {
    const passphrase = passphraseFromEnvironment();
    if (!passphrase) throw new SecretsError(`${ENCRYPTED_ACCOUNTS_FILE} is locked: the passphrase has not been provided`);
    const envelope: unknown = JSON.parse(readFileSync(ENCRYPTED_ACCOUNTS_FILE, 'utf-8'));
    if (!isEnvelope(envelope)) throw new SecretsError(`${ENCRYPTED_ACCOUNTS_FILE} is not a FamilyCFO encrypted file`);
    if (existsSync(ACCOUNTS_FILE) && !warnedPlaintext) {
      warnedPlaintext = true;
      console.warn(`WARNING: ${ACCOUNTS_FILE} still holds the bank logins in plain text next to ${ENCRYPTED_ACCOUNTS_FILE}; delete it.`);
    }
    return parseConfig(JSON.parse(decryptText(envelope, passphrase)), ENCRYPTED_ACCOUNTS_FILE);
  }
  if (!existsSync(ACCOUNTS_FILE)) {
    throw new Error(`${ACCOUNTS_FILE} not found — copy accounts.example.json to ${ACCOUNTS_FILE} and fill in your bank logins, then run \`npm run secrets:encrypt\``);
  }
  if (!warnedPlaintext) {
    warnedPlaintext = true;
    console.warn(`WARNING: ${ACCOUNTS_FILE} stores your bank passwords in plain text. Encrypt it: npm run secrets:encrypt`);
  }
  return parseConfig(JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8')), ACCOUNTS_FILE);
}
