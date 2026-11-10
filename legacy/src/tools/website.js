/**
 * Website design — Roadmap 2 #16.
 *
 * Legacy builds a complete, polished, responsive one-page site as a SINGLE
 * self-contained HTML file (styles and script inline, no build step, no
 * dependencies). It lands in the workspace under Websites/<slug>/index.html
 * and previews on a document card, so Shahyd can look at it immediately and
 * hand the file to any host — or open it straight from disk.
 *
 * Built for his two businesses: Legacy Studios and Travel Essence. The MODEL
 * writes the words; this tool owns the design system so every site comes out
 * looking deliberate rather than like a template.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';
import { config } from '../config.js';

const workspace = () => config.workspace?.root?.trim();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'site';

/** Pick a readable text colour for a given background. */
function ink(hex) {
  const h = String(hex).replace('#', '');
  if (h.length !== 6) return '#0e1013';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 145 ? '#10141a' : '#ffffff';
}

function buildSite({ name, tagline, accent, dark, hero, sections, contact, cta }) {
  const A = /^#[0-9a-f]{6}$/i.test(accent ?? '') ? accent : '#2dd4a8';
  const bg = dark ? '#0d1014' : '#ffffff';
  const fg = dark ? '#e8edf2' : '#16202b';
  const muted = dark ? '#93a1b0' : '#5d6b7a';
  const panel = dark ? '#141920' : '#f6f8fa';
  const line = dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.08)';

  const navLinks = (sections ?? []).map((s) => `<a href="#${slug(s.heading)}">${esc(s.heading)}</a>`).join('');

  const secHTML = (sections ?? []).map((s, i) => {
    const items = (s.items ?? []).map((it) => `
        <article class="card">
          ${it.title ? `<h3>${esc(it.title)}</h3>` : ''}
          ${it.text ? `<p>${esc(it.text)}</p>` : ''}
          ${it.price ? `<div class="price">${esc(it.price)}</div>` : ''}
        </article>`).join('');
    return `
    <section id="${slug(s.heading)}" class="${i % 2 ? 'alt' : ''}">
      <div class="wrap">
        <h2>${esc(s.heading)}</h2>
        ${s.body ? `<p class="lede">${esc(s.body)}</p>` : ''}
        ${items ? `<div class="grid">${items}</div>` : ''}
      </div>
    </section>`;
  }).join('');

  const contactHTML = contact ? `
    <section id="contact" class="contact">
      <div class="wrap">
        <h2>${esc(contact.heading ?? 'Get in touch')}</h2>
        ${contact.text ? `<p class="lede">${esc(contact.text)}</p>` : ''}
        <div class="details">
          ${contact.email ? `<a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a>` : ''}
          ${contact.phone ? `<a href="tel:${esc(String(contact.phone).replace(/\s/g, ''))}">${esc(contact.phone)}</a>` : ''}
          ${contact.address ? `<span>${esc(contact.address)}</span>` : ''}
          ${contact.instagram ? `<a href="https://instagram.com/${esc(String(contact.instagram).replace('@', ''))}" target="_blank" rel="noopener">${esc(contact.instagram)}</a>` : ''}
        </div>
      </div>
    </section>` : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}${tagline ? ' — ' + esc(tagline) : ''}</title>
<meta name="description" content="${esc(tagline ?? name)}">
<style>
  *,*::before,*::after{box-sizing:border-box}
  :root{--a:${A};--ink:${ink(A)};--bg:${bg};--fg:${fg};--mut:${muted};--pan:${panel};--line:${line}}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:400 17px/1.7 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1080px;margin:0 auto;padding:0 24px}
  h1,h2,h3{line-height:1.15;letter-spacing:-.02em;margin:0 0 .5em}
  a{color:inherit}

  header{position:sticky;top:0;z-index:10;backdrop-filter:blur(12px);
    background:color-mix(in srgb,var(--bg) 86%,transparent);border-bottom:1px solid var(--line)}
  nav{display:flex;align-items:center;gap:28px;max-width:1080px;margin:0 auto;padding:14px 24px}
  .brand{font-weight:800;letter-spacing:.12em;text-transform:uppercase;font-size:14px;color:var(--a)}
  nav .links{margin-left:auto;display:flex;gap:24px;font-size:14px}
  nav a{text-decoration:none;color:var(--mut);transition:color .2s}
  nav a:hover{color:var(--fg)}
  @media(max-width:720px){nav .links{display:none}}

  .hero{padding:112px 0 96px;text-align:center;position:relative;overflow:hidden}
  .hero::after{content:"";position:absolute;inset:auto 50% -180px;transform:translateX(50%);
    width:680px;height:360px;border-radius:50%;background:var(--a);opacity:.13;filter:blur(90px)}
  .hero h1{font-size:clamp(2.4rem,6vw,4rem);font-weight:800;max-width:15ch;margin-inline:auto}
  .hero p{font-size:clamp(1.05rem,2.2vw,1.3rem);color:var(--mut);max-width:58ch;margin:0 auto 32px}
  .btn{display:inline-block;background:var(--a);color:var(--ink);text-decoration:none;
    padding:14px 30px;border-radius:999px;font-weight:650;font-size:15px;
    transition:transform .18s ease,box-shadow .18s ease;box-shadow:0 8px 26px color-mix(in srgb,var(--a) 40%,transparent)}
  .btn:hover{transform:translateY(-2px);box-shadow:0 12px 34px color-mix(in srgb,var(--a) 52%,transparent)}

  section{padding:84px 0;border-top:1px solid var(--line)}
  section.alt{background:var(--pan)}
  section h2{font-size:clamp(1.6rem,3.4vw,2.3rem);font-weight:750}
  .lede{color:var(--mut);max-width:66ch;font-size:1.05rem}
  .grid{display:grid;gap:20px;margin-top:38px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
  .card{background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:26px;
    transition:transform .18s ease,border-color .18s ease}
  .card:hover{transform:translateY(-3px);border-color:var(--a)}
  .card h3{font-size:1.12rem;font-weight:680}
  .card p{color:var(--mut);margin:0;font-size:.97rem}
  .price{margin-top:16px;font-weight:750;color:var(--a);font-size:1.15rem}

  .contact{text-align:center}
  .details{display:flex;flex-wrap:wrap;gap:14px 34px;justify-content:center;margin-top:26px;font-size:1.02rem}
  .details a{color:var(--a);text-decoration:none}
  .details a:hover{text-decoration:underline}
  footer{padding:40px 0;text-align:center;color:var(--mut);font-size:.85rem;border-top:1px solid var(--line)}

  [data-r]{opacity:0;transform:translateY(18px);transition:opacity .7s ease,transform .7s ease}
  [data-r].in{opacity:1;transform:none}
  @media(prefers-reduced-motion:reduce){[data-r]{opacity:1;transform:none;transition:none}}
</style></head>
<body>
<header><nav>
  <span class="brand">${esc(name)}</span>
  <div class="links">${navLinks}${contact ? '<a href="#contact">Contact</a>' : ''}</div>
</nav></header>

<div class="hero wrap" data-r>
  <h1>${esc(hero?.heading ?? name)}</h1>
  <p>${esc(hero?.text ?? tagline ?? '')}</p>
  ${cta?.label ? `<a class="btn" href="${esc(cta.href ?? '#contact')}">${esc(cta.label)}</a>` : ''}
</div>

${secHTML}
${contactHTML}

<footer>&copy; ${new Date().getFullYear()} ${esc(name)}${tagline ? ' · ' + esc(tagline) : ''}</footer>

<script>
  // Reveal sections as they scroll into view.
  document.querySelectorAll('section, .hero').forEach(el => el.setAttribute('data-r',''));
  const io = new IntersectionObserver(es => es.forEach(e => e.isIntersecting && e.target.classList.add('in')), { threshold: .12 });
  document.querySelectorAll('[data-r]').forEach(el => io.observe(el));
</script>
</body></html>`;
}

registerTool({
  name: 'create_website',
  description:
    'Design and build a complete one-page WEBSITE as a single self-contained ' +
    'HTML file — responsive, animated, ready to open or host. Use for either ' +
    "business (Legacy Studios, Travel Essence) or for a client. YOU write all " +
    'the copy: a hero headline that sells, section text, service cards with ' +
    'prices if relevant, and contact details. Saved to the workspace under ' +
    'Websites/ and shown on screen. Requires the workspace to be set.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Business or site name (also the brand mark).' },
      tagline: { type: 'string' },
      accent: { type: 'string', description: 'Brand colour as #rrggbb (e.g. #2dd4a8 studio teal, #00b4d8 Travel Essence cyan).' },
      dark: { type: 'boolean', description: 'true for a dark theme (default), false for light.' },
      hero: {
        type: 'object',
        properties: { heading: { type: 'string' }, text: { type: 'string' } },
        description: 'The headline and supporting line at the top.',
      },
      cta: {
        type: 'object',
        properties: { label: { type: 'string' }, href: { type: 'string' } },
        description: 'Main call-to-action button.',
      },
      sections: {
        type: 'array',
        description: 'Content sections in order.',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            body: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: { title: { type: 'string' }, text: { type: 'string' }, price: { type: 'string' } },
              },
            },
          },
          required: ['heading'],
        },
      },
      contact: {
        type: 'object',
        properties: {
          heading: { type: 'string' }, text: { type: 'string' }, email: { type: 'string' },
          phone: { type: 'string' }, address: { type: 'string' }, instagram: { type: 'string' },
        },
      },
      filename: { type: 'string', description: 'Optional folder name for the site.' },
    },
    required: ['name', 'sections'],
  },
  handler: ({ name, tagline, accent, dark = true, hero, cta, sections, contact, filename }) => {
    const root = workspace();
    if (!root) throw new Error('The workspace is not set — add workspace.root in config.json so I can save the site.');
    if (!name?.trim()) throw new Error('The site needs a name.');
    if (!Array.isArray(sections) || !sections.length) throw new Error('The site needs at least one section.');

    const html = buildSite({ name: name.trim(), tagline, accent, dark, hero, sections, contact, cta });
    const folder = slug(filename || name);
    const rel = join('Websites', folder, 'index.html');
    const full = resolve(root, rel);
    if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) throw new Error('Invalid path.');
    mkdirSync(resolve(root, 'Websites', folder), { recursive: true });
    writeFileSync(full, html);

    pushCard({
      kind: 'document',
      title: name.trim(),
      subtitle: `Website · ${sections.length} section${sections.length > 1 ? 's' : ''}`,
      url: `/workspace-doc?f=${encodeURIComponent(rel)}`,
    });

    return `Built "${name.trim()}" — it's on screen, and saved in your workspace at ${rel}. Open that file in a browser, or upload the Websites/${folder} folder to any host.`;
  },
});
