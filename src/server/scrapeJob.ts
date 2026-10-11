import type { DB } from '../db/connection.js';
import { scrapeAll } from '../scraper.js';
import { runPipeline } from '../pipeline.js';
// reads the bank credentials file; the credentials go only to the scraper and are never returned by the API
import { loadConfig } from '../config.js';
import { SecretsError } from '../secrets.js';

/**
 * One scrape at a time, started from the UI: all banks, then the pipeline. The bank's OTP screen
 * becomes a pending request that the UI answers (POST /api/scrape/otp). State lives in memory —
 * a server restart (tsx watch) ends a running scrape.
 */
export interface ScrapeCompanyState {
  company: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  newTransactions: number;
  error: string | null;
}
export interface ScrapeJobState {
  status: 'idle' | 'running' | 'pipeline' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  companies: ScrapeCompanyState[];
  /** the bank is waiting for an OTP code */
  otp: { company: string; requestedAt: string } | null;
  newTransactions: number;
  error: string | null;
}

const idle = (): ScrapeJobState => ({ status: 'idle', startedAt: null, finishedAt: null, companies: [], otp: null, newTransactions: 0, error: null });
let state: ScrapeJobState = idle();
let answerOtp: ((code: string) => void) | null = null;

export const scrapeState = (): ScrapeJobState => state;
export const scrapeRunning = () => state.status === 'running' || state.status === 'pipeline';

const clearOtp = () => {
  answerOtp?.('');
  answerOtp = null;
  state.otp = null;
};

const setCompany = (company: string, patch: Partial<ScrapeCompanyState>) => {
  state.companies = state.companies.map(c => (c.company === company ? { ...c, ...patch } : c));
};

export function startScrape(db: DB): ScrapeJobState {
  if (scrapeRunning()) throw Object.assign(new Error('a scrape is already running'), { statusCode: 409 });
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    // never echo the underlying error: it can quote the credentials file
    const locked = err instanceof SecretsError;
    throw Object.assign(new Error(locked
      ? 'the bank logins are encrypted and locked: restart the app from a terminal, or set FAMILYCFO_PASSPHRASE_FILE'
      : 'the scraper configuration is missing or invalid (see accounts.example.json)'), { statusCode: 400 });
  }
  const only = process.env.SCRAPE_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  state = {
    ...idle(), status: 'running', startedAt: new Date().toISOString(),
    companies: config.accounts.filter(a => !only || only.includes(a.companyId))
      .map(a => ({ company: a.companyId, status: 'pending', newTransactions: 0, error: null })),
  };

  (async () => {
    const results = await scrapeAll(config, db, {
      requestOtp: company => new Promise<string>(resolve => {
        answerOtp = resolve;
        state.otp = { company, requestedAt: new Date().toISOString() };
      }),
      onProgress: event => {
        if (event.type === 'start') setCompany(event.company, { status: 'running' });
        else {
          // a bank that ended (e.g. timed out) no longer needs its code
          if (state.otp?.company === event.company) clearOtp();
          setCompany(event.company, event.success
            ? { status: 'done', newTransactions: event.newTransactions }
            : { status: 'failed', error: event.errorMessage || event.errorType || 'error' });
        }
      },
    });
    state.status = 'pipeline';
    const newIds = results.flatMap(r => r.newTransactionIds);
    state.newTransactions = newIds.length;
    await runPipeline(db, { txIds: newIds, categoryApiUrl: config.categoryApiUrl });
    state.status = results.some(r => r.success) ? 'done' : 'failed';
    if (state.status === 'failed') state.error = 'no bank was scraped';
  })().catch(err => {
    console.error('Scrape job failed:', err);
    state.status = 'failed';
    state.error = err instanceof Error ? err.message : String(err);
  }).finally(() => {
    clearOtp();
    state.finishedAt = new Date().toISOString();
  });

  return state;
}

/** The code the user typed for the bank's OTP screen. */
export function submitOtp(code: string): void {
  if (!answerOtp) throw Object.assign(new Error('no bank is waiting for a code'), { statusCode: 409 });
  if (!/^\d{4,8}$/.test(code)) throw Object.assign(new Error('the code must be 4–8 digits'), { statusCode: 400 });
  const resolve = answerOtp;
  answerOtp = null;
  state.otp = null;
  resolve(code);
}
