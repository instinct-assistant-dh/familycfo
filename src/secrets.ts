import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { createInterface } from 'readline';

/**
 * Encryption for the bank logins file. AES-256-GCM with a key derived from a passphrase (scrypt), so a copy of
 * `accounts.enc.json` is useless without the passphrase. The passphrase never touches the repo or the database:
 * it comes from `FAMILYCFO_PASSPHRASE`, a 0600 file named by `FAMILYCFO_PASSPHRASE_FILE`, or a terminal prompt.
 */

export const ENVELOPE_VERSION = 1;
const AAD = Buffer.from('familycfo:accounts:v1');
/** scrypt cost: ~100 ms and 32 MiB per derivation on a laptop. Stored in the file so it can be raised later. */
const DEFAULT_KDF = { N: 32768, r: 8, p: 1 } as const;
const MAX_KDF = { N: 1 << 20, r: 16, p: 4 } as const;
export const MIN_PASSPHRASE_LENGTH = 12;

export interface Envelope {
  v: number;
  cipher: 'aes-256-gcm';
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsError';
  }
}

function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  // maxmem leaves headroom over the 128 * N * r bytes scrypt needs
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r + (1 << 20) });
}

export function encryptText(plain: string, passphrase: string): Envelope {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new SecretsError(`The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const { N, r, p } = DEFAULT_KDF;
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, N, r, p), iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    v: ENVELOPE_VERSION, cipher: 'aes-256-gcm', kdf: 'scrypt', N, r, p,
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  };
}

export function isEnvelope(value: unknown): value is Envelope {
  const e = value as Partial<Envelope> | null;
  return !!e && typeof e === 'object' && e.v === ENVELOPE_VERSION && e.cipher === 'aes-256-gcm' && e.kdf === 'scrypt'
    && [e.N, e.r, e.p].every(n => Number.isInteger(n) && (n as number) > 0)
    && [e.salt, e.iv, e.tag, e.data].every(s => typeof s === 'string');
}

/** Throws a `SecretsError` for a wrong passphrase or a damaged / tampered file (GCM authenticates both). */
export function decryptText(envelope: Envelope, passphrase: string): string {
  if (!isEnvelope(envelope)) throw new SecretsError('Not a FamilyCFO encrypted file');
  if (envelope.N > MAX_KDF.N || envelope.r > MAX_KDF.r || envelope.p > MAX_KDF.p || (envelope.N & (envelope.N - 1)) !== 0) {
    throw new SecretsError('The encrypted file asks for unreasonable key-derivation settings');
  }
  try {
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const key = deriveKey(passphrase, Buffer.from(envelope.salt, 'base64'), envelope.N, envelope.r, envelope.p);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretsError('Wrong passphrase, or the encrypted file is damaged');
  }
}

// ---- passphrase source --------------------------------------------------------------------------

let cached: string | undefined;

/** Forget the unlocked passphrase (tests, or after a failed attempt). */
export function lockSecrets(): void {
  cached = undefined;
}

/** Remember a passphrase for this process (set once at startup, after a prompt). */
export function setPassphrase(passphrase: string): void {
  cached = passphrase;
}

/** The passphrase from the environment or a private file, or undefined when only a prompt can supply it. */
export function passphraseFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (cached) return cached;
  if (env.FAMILYCFO_PASSPHRASE) {
    const value = env.FAMILYCFO_PASSPHRASE;
    if (env === process.env) {
      // keep it in memory only: child processes (Chrome, the chat's `claude`) inherit the environment
      cached = value;
      delete process.env.FAMILYCFO_PASSPHRASE;
    }
    return value;
  }
  const file = env.FAMILYCFO_PASSPHRASE_FILE;
  if (!file) return undefined;
  if (!existsSync(file)) throw new SecretsError(`FAMILYCFO_PASSPHRASE_FILE does not exist: ${file}`);
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
    throw new SecretsError(`${file} is accessible to other users; run: chmod 600 ${file}`);
  }
  const value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (!value) throw new SecretsError(`${file} is empty`);
  return value;
}

/** Ask on the terminal without echoing the typed characters. */
export function promptHidden(question: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input, output, terminal: true });
    const write = (rl as unknown as { _writeToOutput?: (s: string) => void });
    const original = write._writeToOutput;
    let asked = false;
    write._writeToOutput = (s: string) => { if (!asked) { asked = true; output.write(s); } };
    rl.question(question, answer => {
      write._writeToOutput = original;
      output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Make the passphrase available to `loadConfig()`. Call once at startup of every entry point that scrapes:
 * it prompts only when no environment source exists and a terminal is attached.
 */
export async function unlockSecrets(prompt: (q: string) => Promise<string> = q => promptHidden(q)): Promise<void> {
  if (passphraseFromEnvironment()) return;
  if (!process.stdin.isTTY) {
    throw new SecretsError('The bank logins are encrypted. Set FAMILYCFO_PASSPHRASE_FILE (or FAMILYCFO_PASSPHRASE), or start the app from a terminal to type the passphrase.');
  }
  const answer = await prompt('Passphrase for the encrypted bank logins: ');
  if (!answer) throw new SecretsError('No passphrase entered');
  setPassphrase(answer);
}

/** Constant-time string comparison for the two-step passphrase confirmation. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
