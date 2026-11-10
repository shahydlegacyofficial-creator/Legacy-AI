/**
 * Image + infographic generation — Roadmap 3 #17.
 *
 * Two paths, both previewing on a card and (when the workspace is set) saving
 * a file:
 *   - INFOGRAPHIC: rendered locally as SVG (bar/stat visuals) — no API key,
 *     always available. Great for promo stats, comparisons, quick visuals.
 *   - IMAGE: generated via a text-to-image API (OpenAI Images by default),
 *     dormant unless OPENAI_API_KEY is set. Returns a real picture.
 *
 * The model supplies the spec/prompt; this tool renders/generates, shows it,
 * and saves it. Image generation is gated (it costs money per image).
 */
import { resolve, sep, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';
import { config } from '../config.js';

export const imageGenConfigured = () => Boolean(process.env.OPENAI_API_KEY);
const workspace = () => config.workspace?.root?.trim();

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Build a standalone infographic SVG (title + stat blocks + bar rows). */
function infographicSVG({ title, subtitle, stats, bars, accent = '#2dd4a8' }) {
  const W = 800; let y = 0;
  const parts = [];
  parts.push(`<rect width="${W}" height="100%" fill="#0e1013"/>`);
  y = 60; parts.push(`<text x="40" y="${y}" fill="#fff" font-family="Inter,sans-serif" font-size="34" font-weight="800">${esc(title)}</text>`);
  if (subtitle) { y += 32; parts.push(`<text x="40" y="${y}" fill="#8a95a3" font-family="Inter,sans-serif" font-size="16">${esc(subtitle)}</text>`); }
  y += 40;
  const st = (stats ?? []).slice(0, 4);
  if (st.length) {
    const gap = 16, bw = (W - 80 - gap * (st.length - 1)) / st.length;
    st.forEach((s, i) => {
      const x = 40 + i * (bw + gap);
      parts.push(`<rect x="${x}" y="${y}" width="${bw}" height="96" rx="14" fill="#151a1e" stroke="#22303099"/>`);
      parts.push(`<text x="${x + bw / 2}" y="${y + 44}" fill="${accent}" font-family="Inter,sans-serif" font-size="30" font-weight="800" text-anchor="middle">${esc(s.value)}</text>`);
      parts.push(`<text x="${x + bw / 2}" y="${y + 72}" fill="#8a95a3" font-family="Inter,sans-serif" font-size="13" text-anchor="middle">${esc(s.label)}</text>`);
    });
    y += 130;
  }
  const br = (bars ?? []).slice(0, 6);
  if (br.length) {
    const max = Math.max(...br.map((b) => Number(b.value) || 0), 1);
    const barMax = W - 260;
    br.forEach((b) => {
      const w = Math.max(4, (Number(b.value) || 0) / max * barMax);
      parts.push(`<text x="40" y="${y + 16}" fill="#c9d2dc" font-family="Inter,sans-serif" font-size="14">${esc(b.label)}</text>`);
      parts.push(`<rect x="200" y="${y + 2}" width="${w}" height="20" rx="5" fill="${accent}"/>`);
      parts.push(`<text x="${200 + w + 10}" y="${y + 17}" fill="${accent}" font-family="Inter,sans-serif" font-size="13" font-weight="700">${esc(b.value)}</text>`);
      y += 36;
    });
    y += 10;
  }
  const H = Math.max(y + 30, 200);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('')}</svg>`;
}

function saveToWorkspace(rel, buffer) {
  const root = workspace();
  if (!root) return null;
  const full = resolve(root, rel);
  if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) throw new Error('Invalid path.');
  mkdirSync(resolve(root, 'Images'), { recursive: true });
  writeFileSync(full, buffer);
  return rel;
}
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'image';

registerTool({
  name: 'create_infographic',
  description:
    'Create an INFOGRAPHIC (rendered as an image) from stats and simple bar ' +
    'data — great for promo visuals, comparisons, or summaries. Always ' +
    'available (no API key). Previews on a card and saves to the workspace ' +
    'Images/ folder if the workspace is set. You provide the title, optional ' +
    'subtitle, up to 4 headline stats, and up to 6 labelled bars.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      stats: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } }, required: ['value', 'label'] } },
      bars: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'] } },
    },
    required: ['title'],
  },
  handler: ({ title, subtitle, stats, bars }) => {
    if (!title?.trim()) throw new Error('The infographic needs a title.');
    const svg = infographicSVG({ title: title.trim(), subtitle, stats, bars });
    const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    let saved = null;
    try { saved = saveToWorkspace(join('Images', `${slug(title)}.svg`), Buffer.from(svg)); } catch { /* preview still works */ }
    pushCard({ kind: 'image', title: title.trim(), dataUrl, savedPath: saved });
    return `Infographic "${title.trim()}" is on screen${saved ? `, saved to your workspace at ${saved}` : ''}.`;
  },
});

if (imageGenConfigured()) {
  registerTool({
    name: 'generate_image',
    requiresConfirmation: true, // costs money per image
    describeAction: (input) => `Generate an image from: "${String(input?.prompt ?? '').slice(0, 120)}"`,
    description:
      'Generate a real picture from a text description (AI image generation). ' +
      'Use for promo art, cover concepts, visuals. Held for approval (it costs ' +
      'per image). Previews on a card and saves to the workspace Images/ folder.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate.' },
        title: { type: 'string', description: 'Short name for the file/card.' },
      },
      required: ['prompt'],
    },
    handler: async ({ prompt, title }) => {
      if (!prompt?.trim()) throw new Error('Describe what to generate.');
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-1', prompt: prompt.trim(), size: '1024x1024', n: 1 }),
      });
      if (!r.ok) throw new Error(`Image API ${r.status}: ${(await r.text()).slice(0, 140)}`);
      const d = await r.json();
      const b64 = d.data?.[0]?.b64_json;
      if (!b64) throw new Error('No image came back.');
      const buf = Buffer.from(b64, 'base64');
      const name = slug(title || prompt);
      let saved = null;
      try { saved = saveToWorkspace(join('Images', `${name}.png`), buf); } catch { /* preview still works */ }
      pushCard({ kind: 'image', title: (title || prompt).trim().slice(0, 60), dataUrl: 'data:image/png;base64,' + b64, savedPath: saved });
      return `Generated the image${saved ? ` and saved it to ${saved}` : ''} — it's on screen.`;
    },
  });
} else {
  console.log('[imagegen] AI image generation dormant — add OPENAI_API_KEY to .env to enable generate_image (infographics work without it).');
}
