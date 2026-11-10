/**
 * Download the object-recognition weights ONCE, onto this machine (v3.13).
 *
 *   npm run setup:objects
 *
 * WHY A SCRIPT AND NOT THE ZIP: the weights live on Google's storage and the
 * machine that builds Legacy cannot reach it. His can. So the libraries ship
 * in the zip and the ~6MB of weights arrive here the first time he runs this.
 *
 * WITHOUT IT she still works — the page falls back to loading the same weights
 * from Google live. This just makes it local, faster, and independent of
 * Google being reachable.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const BASE = 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/';
const OUT = new URL('../public/models/objects/', import.meta.url);

async function get(url, binary) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return binary ? Buffer.from(await r.arrayBuffer()) : r.text();
}

try {
  mkdirSync(OUT, { recursive: true });
  console.log('\n[1/2] Fetching the model description...');
  const manifestText = await get(BASE + 'model.json', false);
  const manifest = JSON.parse(manifestText);
  writeFileSync(new URL('model.json', OUT), manifestText);

  const shards = (manifest.weightsManifest ?? []).flatMap((g) => g.paths ?? []);
  if (!shards.length) throw new Error('the model description lists no weight files');

  console.log(`[2/2] Downloading ${shards.length} weight file${shards.length === 1 ? '' : 's'}...`);
  let bytes = 0;
  for (const p of shards) {
    // A shard name is a leaf. Anything else is refused rather than written
    // somewhere unexpected.
    if (!/^[a-z0-9_.-]+$/i.test(p)) throw new Error(`refusing odd filename "${p}"`);
    if (existsSync(new URL(p, OUT))) { console.log(`    - ${p} (already here)`); continue; }
    const buf = await get(BASE + p, true);
    writeFileSync(new URL(p, OUT), buf);
    bytes += buf.length;
    console.log(`    + ${p} (${(buf.length / 1048576).toFixed(1)}MB)`);
  }
  console.log(`\nDone. ${(bytes / 1048576).toFixed(1)}MB saved to public/models/objects.`);
  console.log('Restart Legacy and she will recognise objects from this machine.\n');
} catch (e) {
  console.error(`\nCould not download the weights: ${e.message}`);
  console.error('Legacy still works — she will load them from Google each time instead.\n');
  process.exitCode = 1;
}
