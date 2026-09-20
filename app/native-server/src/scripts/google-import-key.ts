/**
 * One-time import of a Google service-account key file into the Keychain (or a 0600 file where
 * the Keychain is unavailable). Prints the identity and destination, never the key. The source
 * file is left untouched: deleting it is the operator's call.
 *
 *   pnpm --filter mcp-chrome-bridge google:import-key /path/to/key.json
 */
import fs from 'node:fs';
import { parseServiceAccountKey, saveServiceAccountKey } from '../google/store';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: google-import-key <service-account-key.json>');
    process.exit(2);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const key = parseServiceAccountKey(raw);
  const source = await saveServiceAccountKey(raw);
  console.log(
    `Stored key for ${key.client_email} (project ${key.project_id ?? 'unknown'}) in ${source}.`,
  );
  console.log(`The source file was not modified: ${file}`);
}

main().catch((e) => {
  console.error(`import failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
