/**
 * Posting to his LinkedIn profile (v3.14).
 *
 * Personal-profile posting is SELF-SERVE: a LinkedIn app with the "Share on
 * LinkedIn" and "Sign In with LinkedIn using OpenID Connect" products grants
 * w_member_social with no partner review. SETUP-linkedin.md walks it.
 *
 * NOTHING GOES OUT WITHOUT HIM. She drafts onto a card; post_to_linkedin is
 * gated and shows the exact text. A post on his professional profile, in his
 * name, is the definition of a consequential action — and it cannot be taken
 * back from the feed of everyone who already saw it.
 *
 * The token lasts ~60 days. She warns a week out, because an expired token is
 * found at the worst moment: the day he actually wants to post.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { registerTool } from './tools/registry.js';
import { pushCard } from './cards.js';
import { appendAudit } from './audit.js';

const DATA = new URL('../data/', import.meta.url);
const AUTH = new URL('linkedin.json', DATA);
const DRAFTS = new URL('linkedin-drafts.json', DATA);
const readJ = (f, fb) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJ = (f, d) => { mkdirSync(DATA, { recursive: true }); writeFileSync(f, JSON.stringify(d, null, 2)); };

export const linkedinAuth = () => readJ(AUTH, null);
export function saveLinkedinAuth(a) { writeJ(AUTH, a); }

const VERSION = () => String(config.linkedin?.apiVersion ?? '202607');

export function tokenState() {
  const a = linkedinAuth();
  if (!a?.accessToken || !a?.personUrn) return { ready: false, why: 'LinkedIn is not connected — run  npm run setup:linkedin  (SETUP-linkedin.md).' };
  const left = a.expiresAt ? Date.parse(a.expiresAt) - Date.now() : null;
  if (left != null && left <= 0) return { ready: false, why: 'The LinkedIn connection expired. Run  npm run setup:linkedin  again — it takes a minute.' };
  return { ready: true, daysLeft: left != null ? Math.floor(left / 86_400_000) : null };
}

/** What LinkedIn's errors actually mean, in his terms. */
function explain(status, body) {
  const msg = String(body?.message ?? body?.error_description ?? body?.error ?? '').slice(0, 160);
  if (status === 401) return 'LinkedIn rejected the token — it has expired or been revoked. Run  npm run setup:linkedin  again.';
  if (status === 403) return `LinkedIn refused: ${msg || 'no permission'}. Check the app has the "Share on LinkedIn" product.`;
  if (status === 426 || /version/i.test(msg)) return `LinkedIn no longer accepts API version ${VERSION()}. Set linkedin.apiVersion in config.json to a recent month, e.g. the current one as YYYYMM.`;
  if (status === 422 || status === 400) return `LinkedIn did not accept the post: ${msg || 'bad request'}.`;
  if (status === 429) return 'LinkedIn rate limit — try again later today.';
  return `LinkedIn answered ${status}${msg ? `: ${msg}` : ''}.`;
}

export async function postText(text) {
  const st = tokenState();
  if (!st.ready) throw new Error(st.why);
  const a = linkedinAuth();
  const r = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${a.accessToken}`,
      'Content-Type': 'application/json',
      'Linkedin-Version': VERSION(),
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      author: a.personUrn,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 201 || r.ok) {
    return { ok: true, id: r.headers.get('x-restli-id') ?? r.headers.get('x-linkedin-id') ?? null };
  }
  const body = await r.json().catch(() => ({}));
  throw new Error(explain(r.status, body));
}

/**
 * LinkedIn's "little text" format treats some characters as markup; an
 * unescaped one silently truncates the post or fails it. Escaped here so a
 * post about "AI (and the Maldives)" arrives whole.
 */
export function escapeLittleText(t) {
  return String(t).replace(/[\\|{}@\[\]()<>#*_~]/g, (c) => `\\${c}`);
}

/* ---------------------------------- tools --------------------------------- */

registerTool({
  name: 'draft_linkedin_post',
  description:
    'Write a LinkedIn post for Shahyd and put it on screen for him to read ' +
    'BEFORE anything is posted — about Maldivian travel, AI advancements, his ' +
    'studio, his music, whatever he asks. Write it in his voice: first person, ' +
    'specific, no hashtag walls (three at most, at the end), no emoji strings. ' +
    'Under 1,300 characters so it is not cut behind "see more" too early.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The post itself, as it will appear.' },
      topic: { type: 'string', description: 'What it is about, for the card title.' },
    },
    required: ['text'],
  },
  handler: ({ text, topic }) => {
    const body = String(text ?? '').trim();
    if (!body) return 'Nothing to draft.';
    if (body.length > 3000) return `That is ${body.length} characters; LinkedIn allows 3,000. Cut it down.`;
    const db = readJ(DRAFTS, { drafts: [] });
    const id = `li${Date.now().toString(36)}`;
    db.drafts = [...(db.drafts ?? []).slice(-19), { id, text: body, topic: topic ?? null, at: new Date().toISOString() }];
    writeJ(DRAFTS, db);
    pushCard({ kind: 'draft', title: topic ? `LinkedIn — ${topic}` : 'LinkedIn post', subtitle: `${body.length} characters`, body, draftId: id });
    const st = tokenState();
    return `Drafted — it is on screen (${body.length} characters). Say "post it" when he is happy.` +
      (st.ready ? '' : ` Note: ${st.why}`) + ' Do not read it back; he can see it.';
  },
});

registerTool({
  name: 'post_to_linkedin',
  description:
    'Publish the most recent LinkedIn draft — or given text — to his profile. ' +
    'Use ONLY after he has seen the draft and said to post it.',
  requiresConfirmation: true,
  describeAction: ({ text }) => {
    const db = readJ(DRAFTS, { drafts: [] });
    const t = String(text ?? db.drafts?.at(-1)?.text ?? '');
    return `POST to your LinkedIn profile, publicly:\n\n${t.slice(0, 600)}${t.length > 600 ? '…' : ''}`;
  },
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Leave out to post the latest draft.' } },
  },
  handler: async ({ text }) => {
    const db = readJ(DRAFTS, { drafts: [] });
    const body = String(text ?? db.drafts?.at(-1)?.text ?? '').trim();
    if (!body) return 'There is no draft to post. Ask me to write one first.';
    try {
      const r = await postText(escapeLittleText(body));
      appendAudit('linkedin_post', { chars: body.length, id: r.id });
      db.drafts = (db.drafts ?? []).filter((d) => d.text !== body);
      writeJ(DRAFTS, db);
      return 'Posted to your LinkedIn.';
    } catch (e) { return e.message; }
  },
});

registerTool({
  name: 'linkedin_status',
  description: 'Whether LinkedIn is connected, and how long until the connection needs renewing.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const st = tokenState();
    if (!st.ready) return st.why;
    return st.daysLeft == null ? 'LinkedIn is connected.'
      : `LinkedIn is connected — ${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'} before it needs renewing.`;
  },
});
