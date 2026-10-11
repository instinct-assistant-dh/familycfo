# Security

This app holds a household's complete financial picture and the logins to its banks, so please read this before
running it.

## The model

- It is meant to run on **one trusted computer**, for the people who live with that data. The API binds to
  `127.0.0.1` and has **no authentication** — anything that can reach that port can read everything. Don't expose it
  through a reverse proxy, a tunnel, port forwarding, or a `0.0.0.0` bind.
- The API rejects requests with a non-local `Host` header and writes with a non-local `Origin`, so a web page you
  visit cannot drive it (cross-site POSTs, DNS rebinding). Other programs on the same computer still can.
  Loopback HTTP origins are allowed on any valid port so custom Vite/API ports work without a shared secret.
  This trusts other web apps on this computer; it is not protection against a malicious local process.
- The scraper's Chrome runs with its sandbox. `CHROME_NO_SANDBOX=1` removes it and is only for Docker / CI.
- Bank logins should live only in `accounts.enc.json`: AES-256-GCM with a key derived from your passphrase (scrypt).
  Create it with `npm run secrets:encrypt`; it checks the result and removes the plain `accounts.json`. The passphrase
  comes from `FAMILYCFO_PASSPHRASE_FILE` (a `0600` file), `FAMILYCFO_PASSPHRASE`, or a terminal prompt, and is never
  written anywhere by the app. While the logins are encrypted a stolen copy of the file or a backup is useless without
  it; once the app runs, the decrypted logins exist in its memory, so this does not defend against malware running as
  you. A plain `accounts.json` still works but prints a warning. Where your bank supports it, use a read-only /
  viewing user for scraping.
- `bank.db` is **not** encrypted (a database cipher such as SQLCipher is a possible later change). It holds
  transactions, balances and account numbers: use full-disk encryption. The scraper no longer stores the banks' full raw
  payload (`STORE_RAW_TRANSACTIONS=1` re-enables it; `npm run db:scrub-raw` clears old rows). Deleted rows are
  overwritten (`secure_delete`).
- API responses are sent with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and anti-framing headers (the
  Vite dev server too), uploaded documents must really be a PDF / PNG / JPEG / WebP, and errors never include SQL or
  file paths. The data chat accepts at most 2 questions at a time, 20,000 characters each, and stops after 10 minutes.
- `bank.db`, `backups/` and `data/` hold the data itself. New databases and imported documents are `0600`,
  new data folders are `0700`, and an existing database is tightened to `0600`. Startup warns about the database
  and its WAL/SHM sidecars, credentials, backups, data and `POLICIES_DIR` / `REPORTS_DIR` overrides. Existing user
  files and folders are only warned about, not changed: run `chmod 600` for files and `chmod 700` for folders.
  Folder checks do not recursively audit old documents or backups. Keep these paths out of git, shared cloud
  folders and bug reports.
- The chat workspace is a unique `household-agent-*` directory outside the repo, created `0700`. Before each
  use the app rejects symlinks / foreign owners and re-applies `0700`; it is included in permission diagnostics
  once created. Copies remain in the temp directory until removed by the user or OS. This is not a defense
  against a malicious process running as your own user.
- The data chat runs your own Claude Code CLI with only read access to the database and to `data/`. What it reads is
  sent to Anthropic under your account to answer you.

## Known residual risks

- `npm audit` on the root package still reports advisories in the Puppeteer dependency chain (`basic-ftp`,
  `extract-zip`, `proxy-agent`). They are only reachable through Puppeteer's own browser download and proxy
  features, which this app does not use with untrusted input. Fixing them needs a major Puppeteer upgrade, which
  should be tested on its own against the bank scrapers. The web app has no audit findings.
- The SQLite database is not encrypted at rest. Use full-disk encryption (FileVault, BitLocker, LUKS). Database
  encryption (SQLCipher) is planned as a separate change.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting
(**Security → Report a vulnerability** on the repository) and include the steps to reproduce. Never attach real
credentials or financial data.
