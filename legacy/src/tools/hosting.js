/**
 * Putting a picture somewhere Meta can see it (v1.66).
 *
 * Instagram does not accept an upload — Meta fetches the image from a URL. Her
 * machine is behind Tailscale, so until now she has had nowhere to put one,
 * and Instagram posting has been a reminder rather than a post.
 *
 * This sends the file to the shop worker, which stores it in R2 under a
 * public `pub/` prefix and hands back a URL. Payment slips are in the same
 * bucket but stay behind their token; the public route only ever reads pub/.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, sep, extname, basename } from 'node:path';
import { config } from '../config.js';
import { registerTool } from './registry.js';

const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

export const hostingReady = () => Boolean(process.env.SHOP_API && process.env.SHOP_TOKEN);

/** Upload bytes, get back a public URL. */
export async function hostImage(bytes, contentType) {
  if (!hostingReady()) throw new Error('SHOP_API and SHOP_TOKEN are not set, so I have nowhere to host it.');
  const base = process.env.SHOP_API.replace(/\/$/, '');
  const r = await fetch(`${base}/legacy/host`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-shop-token': process.env.SHOP_TOKEN },
    body: bytes,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.url) throw new Error(d.error || `the worker answered ${r.status}`);
  return d.url;
}

registerTool({
  name: 'host_image',
  description:
    'Put an image from the workspace somewhere public and get a link back. Use ' +
    'when an image needs a web address — posting to Instagram, putting a photo ' +
    'in a quote, sending someone a picture. Anything hosted is PUBLIC to anyone ' +
    'with the link, so never use it for contracts, payment slips or anything ' +
    'private.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path inside the workspace, e.g. "Photos/merch-tee.jpg".' },
    },
    required: ['file'],
  },
  handler: async ({ file }) => {
    const root = config.workspace?.root?.trim();
    if (!root) return 'The workspace folder is not set in config.json.';
    const base = resolve(root);
    const full = resolve(base, String(file ?? '').trim());
    if (full !== base && !full.startsWith(base + sep)) return 'That path is outside your workspace.';
    if (!existsSync(full)) return `I cannot find "${file}" in your workspace.`;

    const type = TYPES[extname(full).toLowerCase()];
    if (!type) return `I can host jpg, png, webp and gif. "${basename(full)}" is something else.`;
    const size = statSync(full).size;
    if (size > 12 * 1024 * 1024) return 'That image is over 12 MB — the worker will refuse it.';

    try {
      const url = await hostImage(readFileSync(full), type);
      return `${url}\n\nThat link is public to anyone who has it.`;
    } catch (e) {
      return `I could not host it: ${e.message}`;
    }
  },
});
