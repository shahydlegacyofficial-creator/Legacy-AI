/**
 * HTTPS certificate — Tier 13.
 *
 * Browsers only allow the microphone on secure origins, and "secure" from a
 * tablet means HTTPS. This generates a self-signed certificate ONCE (kept in
 * data/certs/, valid ten years) using the tiny `selfsigned` package. Your
 * tablet shows a one-time "connection not private" warning — expected for a
 * certificate you made yourself — accept it and everything works.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CERT_DIR = fileURLToPath(new URL('../data/certs/', import.meta.url));
const KEY_FILE = join(CERT_DIR, 'legacy-key.pem');
const CERT_FILE = join(CERT_DIR, 'legacy-cert.pem');

export async function ensureCert() {
  try {
    return { key: readFileSync(KEY_FILE), cert: readFileSync(CERT_FILE) };
  } catch {
    /* first run — generate below */
  }
  const { default: selfsigned } = await import('selfsigned');
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'legacy.local' }],
    {
      days: 3650,
      keySize: 2048,
      extensions: [
        { name: 'basicConstraints', cA: false },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'legacy.local' },
            { type: 2, value: 'localhost' },
          ],
        },
      ],
    }
  );
  mkdirSync(CERT_DIR, { recursive: true });
  writeFileSync(KEY_FILE, pems.private);
  writeFileSync(CERT_FILE, pems.cert);
  console.log('[remote] generated a self-signed certificate (data/certs/, valid 10 years)');
  return { key: pems.private, cert: pems.cert };
}
