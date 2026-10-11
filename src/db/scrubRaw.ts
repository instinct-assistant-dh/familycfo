import { pathToFileURL } from 'url';
import { getDb, type DB } from './connection.js';

/**
 * The scraper used to store each bank's full raw transaction payload in `transactions.raw_json`. The app never
 * reads it, so it is extra sensitive data for no benefit. This clears it and compacts the file so freed pages are
 * not left behind. Returns the number of rows cleared.
 */
export function scrubRawTransactions(db: DB): number {
  db.pragma('secure_delete = ON'); // before the UPDATE, so the old payload bytes are overwritten, not just unlinked
  const { changes } = db.prepare(`UPDATE transactions SET raw_json = NULL WHERE raw_json IS NOT NULL`).run();
  if (changes > 0) {
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
  }
  return changes;
}

/** `npm run db:scrub-raw` — back up bank.db first if you want the raw payloads back: this cannot be undone. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Cleared raw_json on ${scrubRawTransactions(getDb())} transactions.`);
}
