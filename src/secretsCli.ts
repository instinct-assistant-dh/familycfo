import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { pathToFileURL } from 'url';
import { ACCOUNTS_FILE, ENCRYPTED_ACCOUNTS_FILE, parseConfig } from './config.js';
import { PRIVATE_FILE_MODE } from './permissions.js';
import { decryptText, encryptText, isEnvelope, MIN_PASSPHRASE_LENGTH, passphraseFromEnvironment, promptHidden, sameSecret, SecretsError } from './secrets.js';

/** Overwrite a file with zeros before deleting it. Best effort: SSDs and journaling file systems may keep old blocks. */
export function shredFile(path: string): void {
  const size = readFileSync(path).length;
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, Buffer.alloc(size));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
}

export interface EncryptOptions {
  plainPath?: string;
  encryptedPath?: string;
  passphrase: string;
  keepPlaintext?: boolean;
}

/**
 * Encrypt the plain logins file: validate it, write `accounts.enc.json` (owner-only, atomic), prove it decrypts back
 * to the same data, and only then remove the plain file.
 */
export function encryptAccountsFile(opts: EncryptOptions): { encryptedPath: string; plaintextRemoved: boolean } {
  const plainPath = opts.plainPath ?? ACCOUNTS_FILE;
  const encryptedPath = opts.encryptedPath ?? ENCRYPTED_ACCOUNTS_FILE;
  if (!existsSync(plainPath)) throw new SecretsError(`${plainPath} not found; nothing to encrypt`);
  if (existsSync(encryptedPath)) throw new SecretsError(`${encryptedPath} already exists; move it away first so a good file is never overwritten`);

  const text = readFileSync(plainPath, 'utf8');
  parseConfig(JSON.parse(text), plainPath); // refuse to encrypt a broken file

  const envelope = encryptText(text, opts.passphrase);
  const tmp = `${encryptedPath}.tmp`;
  if (existsSync(tmp)) unlinkSync(tmp); // a leftover from an interrupted run could keep looser permissions
  writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  const check = JSON.parse(readFileSync(tmp, 'utf8')) as unknown;
  if (!isEnvelope(check) || decryptText(check, opts.passphrase) !== text) {
    unlinkSync(tmp);
    throw new SecretsError('Verification failed: the encrypted file did not decrypt to the original; nothing was changed');
  }
  renameSync(tmp, encryptedPath);

  if (opts.keepPlaintext) return { encryptedPath, plaintextRemoved: false };
  shredFile(plainPath);
  return { encryptedPath, plaintextRemoved: true };
}

/** `npm run secrets:encrypt [-- --keep-plaintext]` */
async function main(): Promise<void> {
  const keep = process.argv.includes('--keep-plaintext');
  let passphrase = passphraseFromEnvironment();
  if (!passphrase) {
    if (!process.stdin.isTTY) throw new SecretsError('Run this in a terminal, or set FAMILYCFO_PASSPHRASE_FILE');
    passphrase = await promptHidden(`New passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters; losing it means re-typing your bank logins): `);
    if (!sameSecret(passphrase, await promptHidden('Repeat the passphrase: '))) throw new SecretsError('The passphrases do not match');
  }
  const { encryptedPath, plaintextRemoved } = encryptAccountsFile({ passphrase, keepPlaintext: keep });
  console.log(`Encrypted bank logins written to ${encryptedPath}.`);
  console.log(plaintextRemoved ? `${ACCOUNTS_FILE} was overwritten and removed.` : `${ACCOUNTS_FILE} was kept: delete it yourself once you have checked the app starts.`);
  console.log('Next start: set FAMILYCFO_PASSPHRASE_FILE to a 0600 file holding the passphrase (for unattended scrapes), or type it when asked.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
}
