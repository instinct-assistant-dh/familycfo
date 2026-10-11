import cron from 'node-cron';
import { scrapeAll, type Config } from './scraper.js';
import { runPipeline } from './pipeline.js';
import { getDb } from './db/connection.js';
import { credentialsAreEncrypted, loadConfig } from './config.js';
import { unlockSecrets } from './secrets.js';
import { warnBroadPermissions } from './permissions.js';

// an encrypted logins file needs its passphrase first (a terminal prompt, or FAMILYCFO_PASSPHRASE_FILE for unattended runs)
if (credentialsAreEncrypted()) await unlockSecrets();
const config = loadConfig();
warnBroadPermissions();

async function run(cfg: Config): Promise<void> {
  const db = getDb();
  const results = await scrapeAll(cfg, db);
  const newIds = results.flatMap(r => r.newTransactionIds);
  console.log(`\nScrape done: ${results.map(r => `${r.company} ${r.success ? '✓' : `✗ ${r.errorType}`}`).join(', ')}`);
  const summary = await runPipeline(db, { txIds: newIds, categoryApiUrl: cfg.categoryApiUrl });
  console.log('Pipeline:', summary);
}

// SCHEDULE="0 7 * * *" keeps the process running and scrapes on that cron schedule
const schedule = process.env.SCHEDULE;
if (schedule) {
  console.log(`Bank scraper scheduled: ${schedule}`);
  // a slow scrape must not overlap with the next one: two browsers would log in to the bank at once
  let running = false;
  cron.schedule(schedule, () => {
    if (running) {
      console.warn(`\n[${new Date().toISOString()}] Previous scrape still running; skipping this one.`);
      return;
    }
    running = true;
    console.log(`\n[${new Date().toISOString()}] Running scrape...`);
    run(config).catch(console.error).finally(() => { running = false; });
  });
} else {
  run(config).catch(err => { console.error(err); process.exitCode = 1; });
}
