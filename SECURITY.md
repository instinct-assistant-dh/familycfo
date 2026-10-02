# Security

This app holds a household's complete financial picture and the logins to its banks, so please read this before
running it.

## The model

- It is meant to run on **one trusted computer**, for the people who live with that data. The API binds to
  `127.0.0.1` and has **no authentication** — anything that can reach that port can read everything. Don't expose it
  through a reverse proxy, a tunnel, port forwarding, or a `0.0.0.0` bind.
- The API rejects requests with a non-local `Host` header and writes with a non-local `Origin`, so a web page you
  visit cannot drive it (cross-site POSTs, DNS rebinding). Other programs on the same computer still can.
- The scraper's Chrome runs with its sandbox. `CHROME_NO_SANDBOX=1` removes it and is only for Docker / CI.
- Bank logins are read from `accounts.json` (git-ignored). Treat that file like a password vault: keep the computer's
  disk encrypted and its user account locked. Where your bank supports it, use a read-only / viewing user for scraping.
- `bank.db`, `backups/` and `data/` hold the data itself — the app creates `bank.db` and imported documents readable by you only and warns at start if these are wider (`chmod 600` files, `chmod 700` folders); keep them out of git, cloud-synced folders you share, and
  bug reports.
- The data chat runs your own Claude Code CLI with only read access to the database and to `data/`. What it reads is
  sent to Anthropic under your account to answer you.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting
(**Security → Report a vulnerability** on the repository) and include the steps to reproduce. Never attach real
credentials or financial data.
