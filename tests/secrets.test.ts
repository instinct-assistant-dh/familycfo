import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptText, encryptText, isEnvelope, lockSecrets, passphraseFromEnvironment, promptHidden, sameSecret, SecretsError, setPassphrase, unlockSecrets, type Envelope } from '../src/secrets.js';
import { encryptAccountsFile, shredFile } from '../src/secretsCli.js';
import { openDb } from '../src/db/connection.js';
import { scrubRawTransactions } from '../src/db/scrubRaw.js';
import { PassThrough } from 'stream';

const PASS = 'correct horse battery staple';
const sample = JSON.stringify({ accounts: [{ companyId: 'leumi', credentials: { username: 'synthetic-user', password: 'synthetic-secret-123' } }] });
const posix = process.platform !== 'win32';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'familycfo-secrets-')); lockSecrets(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); lockSecrets(); });

describe('credential encryption', () => {
  it('round-trips and never stores the plain text', () => {
    const env = encryptText(sample, PASS);
    expect(isEnvelope(env)).toBe(true);
    expect(JSON.stringify(env)).not.toContain('synthetic-secret-123');
    expect(decryptText(env, PASS)).toBe(sample);
  });
  it('uses a fresh salt and nonce each time', () => {
    const a = encryptText(sample, PASS), b = encryptText(sample, PASS);
    expect(a.salt).not.toBe(b.salt); expect(a.iv).not.toBe(b.iv); expect(a.data).not.toBe(b.data);
  });
  it('rejects a short passphrase, a wrong passphrase and any tampering', () => {
    expect(() => encryptText(sample, 'short')).toThrow(/at least 12/);
    const env = encryptText(sample, PASS);
    expect(() => decryptText(env, 'another long passphrase')).toThrow(SecretsError);
    for (const field of ['data', 'tag', 'iv', 'salt'] as const) {
      const bytes = Buffer.from(env[field], 'base64'); bytes[0] ^= 1;
      expect(() => decryptText({ ...env, [field]: bytes.toString('base64') }, PASS), field).toThrow(/Wrong passphrase/);
    }
  });
  it('normalizes the passphrase so the same text typed on another keyboard still works', () => {
    expect(decryptText(encryptText(sample, 'caf\u00e9 caf\u00e9 caf\u00e9'), 'cafe\u0301 cafe\u0301 cafe\u0301')).toBe(sample);
  });
  it('refuses a file that is not an envelope or that asks for absurd key-derivation cost', () => {
    const env = encryptText(sample, PASS);
    expect(isEnvelope(null)).toBe(false); expect(isEnvelope({ v: 2 })).toBe(false); expect(isEnvelope({ ...env, N: 'x' })).toBe(false);
    expect(() => decryptText({ v: 9 } as unknown as Envelope, PASS)).toThrow(/Not a FamilyCFO/);
    expect(() => decryptText({ ...env, N: 1 << 30 }, PASS)).toThrow(/unreasonable/);
    expect(() => decryptText({ ...env, N: 3000 }, PASS)).toThrow(/unreasonable/);
  });
  it('compares secrets without length leaks', () => { expect(sameSecret('abc', 'abc')).toBe(true); expect(sameSecret('abc', 'abd')).toBe(false); expect(sameSecret('abc', 'abcd')).toBe(false); });
});

describe('passphrase sources', () => {
  it('reads the environment first, then a private file, and remembers an unlocked passphrase', () => {
    expect(passphraseFromEnvironment({})).toBeUndefined();
    expect(passphraseFromEnvironment({ FAMILYCFO_PASSPHRASE: 'from env' })).toBe('from env');
    const file = join(dir, 'pass'); writeFileSync(file, `${PASS}\n`, { mode: 0o600 });
    expect(passphraseFromEnvironment({ FAMILYCFO_PASSPHRASE_FILE: file })).toBe(PASS);
    setPassphrase('cached one'); expect(passphraseFromEnvironment({})).toBe('cached one');
  });
  it('fails clearly for a missing, empty or world-readable passphrase file', () => {
    expect(() => passphraseFromEnvironment({ FAMILYCFO_PASSPHRASE_FILE: join(dir, 'nope') })).toThrow(/does not exist/);
    const file = join(dir, 'pass'); writeFileSync(file, '\n', { mode: 0o600 });
    expect(() => passphraseFromEnvironment({ FAMILYCFO_PASSPHRASE_FILE: file })).toThrow(/empty/);
    if (posix) { writeFileSync(file, PASS); chmodSync(file, 0o644); expect(() => passphraseFromEnvironment({ FAMILYCFO_PASSPHRASE_FILE: file })).toThrow(/chmod 600/); }
  });
  it('unlockSecrets uses the environment, a prompt on a terminal, and refuses without either', async () => {
    const prompt = vi.fn(async () => PASS);
    vi.stubEnv('FAMILYCFO_PASSPHRASE', 'from the environment'); await unlockSecrets(prompt); expect(prompt).not.toHaveBeenCalled();
    vi.stubEnv('FAMILYCFO_PASSPHRASE', ''); lockSecrets();
    const setTty = (v: boolean) => Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
    const original = process.stdin.isTTY;
    try {
    setTty(false); await expect(unlockSecrets(prompt)).rejects.toThrow(/FAMILYCFO_PASSPHRASE_FILE/);
    setTty(true); await unlockSecrets(prompt); expect(prompt).toHaveBeenCalledOnce(); expect(passphraseFromEnvironment()).toBe(PASS);
    lockSecrets(); await expect(unlockSecrets(async () => '')).rejects.toThrow(/No passphrase/);
    } finally { Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true }); }
  });
  it('promptHidden does not echo what is typed', async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream; const out = new PassThrough(); let seen = '';
    out.on('data', d => { seen += d; });
    const answer = promptHidden('Passphrase: ', input, out as unknown as NodeJS.WriteStream);
    (input as unknown as PassThrough).write('secret-typed-text\n');
    expect(await answer).toBe('secret-typed-text'); expect(seen).toContain('Passphrase: '); expect(seen).not.toContain('secret-typed-text');
  });
});

describe('loadConfig with encrypted and plain files', () => {
  const load = async (env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.resetModules(); return import('../src/config.js');
  };
  it('prefers the encrypted file, needs the passphrase and warns about a leftover plain file', async () => {
    const enc = join(dir, 'accounts.enc.json'), plain = join(dir, 'accounts.json');
    writeFileSync(enc, JSON.stringify(encryptText(sample, PASS))); writeFileSync(plain, sample);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cfg = await load({ ACCOUNTS_ENC_FILE: enc, ACCOUNTS_FILE: plain, FAMILYCFO_PASSPHRASE: '' });
    expect(cfg.credentialsAreEncrypted()).toBe(true);
    const secrets = await import('../src/secrets.js');
    expect(() => cfg.loadConfig()).toThrow(/locked/);
    secrets.setPassphrase('wrong passphrase here'); expect(() => cfg.loadConfig()).toThrow(/Wrong passphrase/);
    secrets.setPassphrase(PASS); expect(cfg.loadConfig().accounts[0].companyId).toBe('leumi');
    cfg.loadConfig(); expect(warn.mock.calls.filter(c => String(c[0]).includes('still holds'))).toHaveLength(1);
  });
  it('rejects a damaged encrypted file without echoing its content', async () => {
    const enc = join(dir, 'accounts.enc.json'); writeFileSync(enc, JSON.stringify({ hello: 'world' }));
    const cfg = await load({ ACCOUNTS_ENC_FILE: enc, ACCOUNTS_FILE: join(dir, 'none.json'), FAMILYCFO_PASSPHRASE: PASS });
    expect(() => cfg.loadConfig()).toThrow(/not a FamilyCFO encrypted file/);
  });
  it('warns once when only the plain file exists and names the fix', async () => {
    const plain = join(dir, 'accounts.json'); writeFileSync(plain, sample);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cfg = await load({ ACCOUNTS_ENC_FILE: join(dir, 'absent.enc.json'), ACCOUNTS_FILE: plain });
    cfg.loadConfig(); cfg.loadConfig();
    expect(warn).toHaveBeenCalledTimes(1); expect(String(warn.mock.calls[0][0])).toContain('npm run secrets:encrypt');
  });
  it('validates the file shape and never quotes credential values in the error', async () => {
    const plain = join(dir, 'accounts.json');
    const cfg = await load({ ACCOUNTS_ENC_FILE: join(dir, 'absent.enc.json'), ACCOUNTS_FILE: plain });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(plain, JSON.stringify({ accounts: [{ companyId: 'notABank', credentials: { password: 'synthetic-secret-123' } }] }));
    let message = ''; try { cfg.loadConfig(); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('unknown bank or card company'); expect(message).not.toContain('synthetic-secret-123');
    writeFileSync(plain, JSON.stringify({ accounts: [{ companyId: 'leumi', credentials: { password: 5 } }] }));
    expect(() => cfg.loadConfig()).toThrow(/not a valid configuration/);
    writeFileSync(plain, JSON.stringify({}));
    expect(() => cfg.loadConfig()).toThrow(/accounts/);
    writeFileSync(plain, JSON.stringify({ accounts: [], categoryApiUrl: 'http://example.com/categorize' }));
    expect(() => cfg.loadConfig()).toThrow(/https/);
    writeFileSync(plain, JSON.stringify({ accounts: [], categoryApiUrl: 'http://localhost:5678/categorize' }));
    expect(cfg.loadConfig().categoryApiUrl).toBe('http://localhost:5678/categorize');
  });
  it('assertSafeCategoryUrl allows https and loopback http only, without credentials', async () => {
    const { assertSafeCategoryUrl } = await load({});
    expect(assertSafeCategoryUrl('https://n8n.example/webhook')).toBe('https://n8n.example/webhook');
    expect(assertSafeCategoryUrl('http://127.0.0.1:5678/x')).toBeTruthy();
    for (const bad of ['http://n8n.example/x', 'ftp://n8n.example', 'https://user:pw@n8n.example', 'not a url']) expect(() => assertSafeCategoryUrl(bad), bad).toThrow();
  });
});

describe('npm run secrets:encrypt', () => {
  const paths = () => ({ plainPath: join(dir, 'accounts.json'), encryptedPath: join(dir, 'accounts.enc.json') });
  beforeEach(() => { vi.stubEnv('ACCOUNTS_FILE', join(dir, 'accounts.json')); });
  it('writes an owner-only encrypted file, verifies it and removes the plain file', () => {
    const { plainPath, encryptedPath } = paths(); writeFileSync(plainPath, sample);
    const r = encryptAccountsFile({ plainPath, encryptedPath, passphrase: PASS });
    expect(r.plaintextRemoved).toBe(true); expect(existsSync(plainPath)).toBe(false); expect(existsSync(`${encryptedPath}.tmp`)).toBe(false);
    if (posix) expect(statSync(encryptedPath).mode & 0o777).toBe(0o600);
    expect(decryptText(JSON.parse(readFileSync(encryptedPath, 'utf8')), PASS)).toBe(sample);
    expect(readFileSync(encryptedPath, 'utf8')).not.toContain('synthetic-secret-123');
  });
  it('can keep the plain file', () => {
    const { plainPath, encryptedPath } = paths(); writeFileSync(plainPath, sample);
    expect(encryptAccountsFile({ plainPath, encryptedPath, passphrase: PASS, keepPlaintext: true }).plaintextRemoved).toBe(false); expect(existsSync(plainPath)).toBe(true);
  });
  it('never overwrites an existing encrypted file, never encrypts a broken file, and needs a source', () => {
    const { plainPath, encryptedPath } = paths();
    expect(() => encryptAccountsFile({ plainPath, encryptedPath, passphrase: PASS })).toThrow(/not found/);
    writeFileSync(plainPath, sample); writeFileSync(encryptedPath, 'precious');
    expect(() => encryptAccountsFile({ plainPath, encryptedPath, passphrase: PASS })).toThrow(/already exists/); expect(readFileSync(encryptedPath, 'utf8')).toBe('precious');
    rmSync(encryptedPath); writeFileSync(plainPath, JSON.stringify({ accounts: [{ companyId: 'nope', credentials: {} }] }));
    expect(() => encryptAccountsFile({ plainPath, encryptedPath, passphrase: PASS })).toThrow(/valid configuration/); expect(existsSync(encryptedPath)).toBe(false);
    writeFileSync(plainPath, sample); expect(() => encryptAccountsFile({ plainPath, encryptedPath, passphrase: 'short' })).toThrow(/at least 12/); expect(existsSync(plainPath)).toBe(true);
  });
  it('shredFile overwrites then deletes', () => { const f = join(dir, 'x'); writeFileSync(f, 'secret'); shredFile(f); expect(existsSync(f)).toBe(false); });
});

describe('raw bank payloads', () => {
  it('scrubRawTransactions clears raw_json, reports the count and keeps the rows', () => {
    const path = join(dir, 'scrub.db'); const db = openDb(path);
    db.prepare(`INSERT INTO accounts (id, company, kind) VALUES ('leumi:1', 'leumi', 'bank')`).run();
    const insert = db.prepare(`INSERT INTO transactions (identifier, account_id, date, description, original_amount, charged_amount, raw_json) VALUES (?, 'leumi:1', '2026-09-01', 'x', -1, -1, ?)`);
    insert.run('a', '{"accountNumber":"123"}'); insert.run('b', '{"p":1}'); insert.run('c', null);
    expect(scrubRawTransactions(db)).toBe(2); expect(db.prepare('SELECT count(*) FROM transactions WHERE raw_json IS NOT NULL').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM transactions').pluck().get()).toBe(3); expect(scrubRawTransactions(db)).toBe(0); db.close();
  });
  it('opens databases with secure_delete and a busy timeout', () => {
    const db = openDb(':memory:'); expect(db.pragma('secure_delete', { simple: true })).toBe(1); expect(db.pragma('busy_timeout', { simple: true })).toBe(5000); db.close();
  });
});
