/**
 * SELF-REVIEW (v3.22) — "self-evolving", with his hand on the switch.
 *
 * She reads her own evidence — the error log, which tools fail and how often,
 * whether every file still parses, which skills are broken — and turns it into
 * a short list of concrete fixes. She PROPOSES; nothing changes until he says
 * so, and then only through the gated edit/create tools, which refuse any
 * edit that would stop her booting.
 *
 * Code that rewrites itself unattended is how a helpful assistant becomes a
 * broken one at 3am. Evidence → proposal → his yes → checked edit.
 */
import { readFileSync, existsSync } from 'node:fs';
import { registerTool } from './tools/registry.js';

const tail = (f, n) => { try { return readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8').trim().split('\n').slice(-n); } catch { return []; } };

export async function gatherEvidence() {
  const errors = tail('errors.log', 80);
  const audit = tail('audit.log', 2000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const weekAgo = Date.now() - 7 * 86_400_000;
  const failing = {};
  for (const a of audit) {
    const at = Date.parse(a.at ?? a.ts ?? 0);
    if (at && at < weekAgo) continue;
    if (/error|fail/i.test(a.action ?? a.event ?? a.type ?? '') || a.error) {
      const k = a.tool ?? a.action ?? a.event ?? 'unknown';
      failing[k] = (failing[k] ?? 0) + 1;
    }
  }
  let code = '';
  try { const { executeTool } = await import('./tools/registry.js'); code = (await executeTool('check_own_code', {})).result ?? ''; } catch {}
  let skills = [];
  try { skills = (await import('./skills.js')).skillList().filter((s) => s.error); } catch {}
  const repeated = {};
  for (const e of errors) { const k = e.replace(/^\S+\s+/, '').slice(0, 90); repeated[k] = (repeated[k] ?? 0) + 1; }
  return {
    failing: Object.entries(failing).sort((a, b) => b[1] - a[1]).slice(0, 8),
    repeated: Object.entries(repeated).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 6),
    code, skills,
  };
}

registerTool({
  name: 'self_review',
  description:
    'Review your OWN health and code: recurring errors, tools that keep failing, ' +
    'files that do not parse, broken skills. Then propose up to three concrete ' +
    'improvements to make yourself more useful to him. Change NOTHING — he ' +
    'approves each fix, which you then make with edit_own_file / create_skill.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const e = await gatherEvidence();
    const out = ['EVIDENCE (last 7 days):'];
    out.push(e.failing.length ? `Failing most: ${e.failing.map(([k, n]) => `${k} ×${n}`).join(', ')}` : 'No tool failures logged.');
    if (e.repeated.length) out.push(`Recurring errors:\n${e.repeated.map(([k, n]) => `  · ×${n} ${k}`).join('\n')}`);
    out.push(`Code: ${e.code || 'not checked'}`);
    if (e.skills.length) out.push(`Broken skills: ${e.skills.map((s) => `${s.slug} (${s.error})`).join('; ')}`);
    out.push('\nNow tell him, plainly, the 1–3 changes that would help him most — what is wrong, the fix, the file. Ask before changing anything.');
    return out.join('\n');
  },
});
