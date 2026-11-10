/**
 * The posting calendar (v1.53).
 *
 * Legacy could write a caption and never put it out. This holds a queue of
 * posts with times, and releases them.
 *
 * THE DECISION THIS FEATURE TURNS ON: a scheduled post goes out while Shahyd
 * is not in the room. Everything else she does that touches the world waits
 * for his yes in the moment. So the yes moves EARLIER rather than disappearing:
 * he approves the exact caption, platform and time when it is queued, and the
 * gate summary says plainly that it will publish without asking again. He can
 * cancel any time before it goes. If he would rather be asked at the moment of
 * publishing, config.scheduler.confirmAtPublish flips it back.
 *
 * WHAT EACH PLATFORM CAN HONESTLY DO:
 *   · Facebook — real publishing, handed to META'S OWN scheduler. It goes out
 *     even if his PC is off, which is the failure mode that matters.
 *   · Instagram — Meta must FETCH the image from a public URL. Legacy runs
 *     behind Tailscale on his PC, so unless the image is already hosted
 *     somewhere public, this cannot auto-publish. With a URL it publishes;
 *     without one it becomes a reminder with the caption ready.
 *   · TikTok — no posting API for a personal account. Reminder only.
 * Nothing here pretends otherwise, and schedule_post says which it will be
 * before he approves.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { postNotice } from './notices.js';
import { appendAudit } from './audit.js';
import { registerTool } from './tools/registry.js';

const DATA = new URL('../data/', import.meta.url);
const FILE = new URL('schedule.json', DATA);

const load = () => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { posts: [], nextId: 1 }; }
};
const save = (db) => { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(db, null, 2)); };

const PLATFORMS = ['facebook', 'instagram', 'tiktok'];
const when = (iso) => new Date(iso).toLocaleString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/**
 * Can this post actually be published, or is the honest answer a reminder?
 * SYNCHRONOUS on purpose: the confirmation gate builds its summary without
 * awaiting, and Shahyd must be told which of the two he is approving BEFORE
 * he says yes, not after.
 */
const fbReady = () =>
  Boolean((process.env.FB_PAGE_TOKEN || process.env.IG_ACCESS_TOKEN) &&
    (config.social?.facebook?.pageId || config.social?.facebook?.slug));
const igReady = () => Boolean(process.env.IG_ACCESS_TOKEN && config.social?.instagram?.userId);

export function publishability(platform, imageUrl) {
  if (platform === 'facebook') {
    return fbReady()
      ? { mode: 'publish', note: "Facebook's own scheduler holds it, so it goes out even if your PC is off." }
      : { mode: 'remind', note: 'Facebook is not connected, so I will remind you at the time instead.' };
  }
  if (platform === 'instagram') {
    if (!igReady()) return { mode: 'remind', note: 'Instagram is not connected, so I will remind you at the time.' };
    if (!imageUrl) {
      return { mode: 'remind', note: 'Instagram needs a picture — give me one from your workspace and I will host it and post it properly. Without one I will just remind you at the time.' };
    }
    return { mode: 'publish', note: 'I will publish it at the time — my PC needs to be running for that one.' };
  }
  return { mode: 'remind', note: 'TikTok has no posting API for a personal account, so I will remind you with the caption ready.' };
}

/* ------------------------------- publishing ------------------------------- */
async function publishFacebook(post) {
  const { facebookPost } = await import('./tools/facebook.js');
  return facebookPost({ message: post.caption, link: post.link, imageUrl: post.imageUrl, at: post.at });
}

async function publishInstagram(post) {
  const { instagramPublish } = await import('./tools/instagram.js');
  return instagramPublish({ caption: post.caption, imageUrl: post.imageUrl });
}

/* --------------------------------- queue --------------------------------- */
export function listScheduled() {
  return load().posts.filter((p) => p.status === 'queued' || p.status === 'handed-to-meta');
}
export function allScheduled() { return load().posts; }

export async function queuePost({ platform, at, caption, imageUrl, link }) {
  const db = load();
  const post = {
    id: `P${db.nextId++}`,
    platform, at, caption, imageUrl: imageUrl ?? null, link: link ?? null,
    status: 'queued',
    createdAt: new Date().toISOString(),
  };

  // Facebook is handed straight to Meta so it survives his PC being off.
  if (platform === 'facebook') {
    const cap = publishability('facebook', imageUrl);
    if (cap.mode === 'publish') {
      try {
        const r = await publishFacebook(post);
        post.status = r?.scheduled ? 'handed-to-meta' : 'posted';
        post.remoteId = r?.id ?? null;
        if (r?.error) { post.status = 'queued'; post.lastError = r.error; }
      } catch (e) { post.lastError = e.message; }
    }
  }

  db.posts.push(post);
  save(db);
  appendAudit('post_scheduled', { id: post.id, platform, at, status: post.status });
  return post;
}

export function cancelPost(ref) {
  const db = load();
  const q = String(ref ?? '').toLowerCase().trim();
  const live = db.posts.filter((p) => p.status === 'queued' || p.status === 'handed-to-meta');
  const n = Number(q);
  let hit = null;
  if (Number.isInteger(n) && n >= 1 && n <= live.length) hit = live[n - 1];
  if (!hit) hit = live.find((p) => p.id.toLowerCase() === q || p.caption.toLowerCase().includes(q));
  if (!hit) return { error: `I have nothing scheduled matching "${ref}".` };
  hit.status = 'cancelled';
  hit.cancelledAt = new Date().toISOString();
  save(db);
  appendAudit('post_cancelled', { id: hit.id, platform: hit.platform });
  return { cancelled: hit };
}

/* ----------------------------- the due sweep ----------------------------- */
/**
 * Runs from the heartbeat. Two rules that matter more than the publishing:
 *   · A post whose time has passed by more than the grace window is NOT sent
 *     late. A "good morning" caption going out at midnight because the PC was
 *     asleep is worse than not posting at all — he is told instead.
 *   · Anything that fails is reported, never silently dropped.
 */
export async function runDuePosts(now = Date.now()) {
  if (config.scheduler?.enabled === false) return [];
  const db = load();
  const grace = (config.scheduler?.graceMinutes ?? 90) * 60_000;
  const done = [];

  for (const p of db.posts) {
    if (p.status !== 'queued') continue;
    const due = Date.parse(p.at);
    if (!Number.isFinite(due) || due > now) continue;

    if (now - due > grace) {
      p.status = 'missed';
      postNotice({
        key: `sched-missed-${p.id}`,
        message: `I missed the ${when(p.at)} ${p.platform} post — it is more than ${Math.round(grace / 60000)} minutes late and posting it now would land at the wrong time. The caption is still saved if you want to put it out yourself.`,
        urgency: 'high',
      });
      done.push({ id: p.id, outcome: 'missed' });
      continue;
    }

    const cap = publishability(p.platform, p.imageUrl);
    // Even an approved post can be sent back to him if he has asked to be
    // consulted at the moment of publishing.
    if (cap.mode !== 'publish' || config.scheduler?.confirmAtPublish) {
      p.status = 'reminded';
      postNotice({
        key: `sched-due-${p.id}`,
        message: `Time for your ${p.platform} post. Here is the caption, ready to paste:\n\n${p.caption}` +
          (p.link ? `\n\n${p.link}` : ''),
        urgency: 'info',
      });
      done.push({ id: p.id, outcome: 'reminded' });
      continue;
    }

    try {
      const r = p.platform === 'instagram' ? await publishInstagram(p) : await publishFacebook(p);
      if (r?.error) throw new Error(r.error);
      p.status = 'posted';
      p.remoteId = r?.id ?? null;
      p.postedAt = new Date().toISOString();
      postNotice({ key: `sched-done-${p.id}`, message: `Your ${p.platform} post went out.`, urgency: 'info' });
      done.push({ id: p.id, outcome: 'posted' });
    } catch (e) {
      p.status = 'failed';
      p.lastError = e.message;
      postNotice({
        key: `sched-fail-${p.id}`,
        message: `The ${p.platform} post did not go out — ${e.message}. The caption is saved; say "reschedule it" and I will queue it again.`,
        urgency: 'high',
      });
      done.push({ id: p.id, outcome: 'failed' });
    }
    appendAudit('post_published', { id: p.id, platform: p.platform, status: p.status });
  }

  save(db);
  return done;
}

export { when as formatWhen, PLATFORMS };


/* --------------------------------- tools --------------------------------- */
/**
 * Queuing is GATED. The yes moves earlier rather than disappearing: he
 * approves the exact caption, platform and time, and the summary says in
 * plain words that it will publish without asking again.
 */
registerTool({
  name: 'schedule_post',
  description:
    'Put a post on the calendar for a future time — Facebook, Instagram or ' +
    'TikTok. Use when Shahyd wants something posted later: "post this Friday ' +
    'morning", "schedule that for tomorrow at seven". Write the caption in ' +
    'his voice first and show it to him. Needs his approval, and the approval ' +
    'covers the publishing, so get the caption right before asking.',
  requiresConfirmation: true,
  describeAction: ({ platform, at, caption, imageUrl }) => {
    const cap = publishability(platform, imageUrl);
    const preview = String(caption ?? '').trim().slice(0, 90);
    const time = Number.isFinite(Date.parse(at)) ? when(at) : String(at);
    return cap.mode === 'publish'
      ? `post this to ${platform} at ${time} WITHOUT asking again — "${preview}${String(caption ?? '').length > 90 ? '…' : ''}"`
      : `put this ${platform} post on the calendar for ${time} and remind you then — "${preview}${String(caption ?? '').length > 90 ? '…' : ''}"`;
  },
  inputSchema: {
    type: 'object',
    properties: {
      platform: { type: 'string', enum: PLATFORMS, description: 'facebook, instagram or tiktok.' },
      at: { type: 'string', description: 'When, as a full ISO timestamp. Work it out from what he said and today\'s date.' },
      caption: { type: 'string', description: 'The post text, written the way Shahyd writes.' },
      imageUrl: { type: 'string', description: 'A PUBLIC web address for the image, if it already has one.' },
      imageFile: { type: 'string', description: 'A path in the workspace, e.g. "Photos/tee.jpg". She will host it and use that — this is the usual way to post a real picture to Instagram.' },
      link: { type: 'string', description: 'A link to include (Facebook only).' },
    },
    required: ['platform', 'at', 'caption'],
  },
  handler: async ({ platform, at, caption, imageUrl, imageFile, link }) => {
    if (!PLATFORMS.includes(platform)) return `I can schedule facebook, instagram or tiktok — not ${platform}.`;
    if (!caption?.trim()) return 'What should the post say?';
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return `I could not read "${at}" as a date and time.`;
    if (t < Date.now() + 60_000) return 'That time has already passed. When would you like it to go out?';
    if (t > Date.now() + 1000 * 60 * 60 * 24 * 180) return 'That is more than six months out — further than I can hold a post.';

    // A picture in his workspace is not a picture Meta can fetch. Host it NOW,
    // at queue time, so a failure surfaces while he is still here rather than
    // at 7am on a Friday when the post was meant to go out.
    let url = imageUrl;
    let hosted = false;
    if (!url && imageFile?.trim()) {
      const { executeTool } = await import('./tools/registry.js');
      const r = await executeTool('host_image', { file: imageFile.trim() });
      const found = String(r.result ?? '').match(/https?:\/\/\S+/);
      if (!found) return `I could not host that image, so I have not scheduled anything: ${r.result ?? r.error}`;
      url = found[0];
      hosted = true;
    }

    const cap = publishability(platform, url);
    const post = await queuePost({ platform, at: new Date(t).toISOString(), caption: caption.trim(), imageUrl: url, link });

    if (post.lastError) {
      return `I could not hand it to ${platform}: ${post.lastError}. It is saved for ${when(at)} and I will try again then.`;
    }
    const held = post.status === 'handed-to-meta'
      ? 'Facebook has it and will publish it even if your PC is off.'
      : cap.note;
    return `Scheduled for ${when(at)} on ${platform}.${hosted ? ' I hosted the image so Instagram can fetch it.' : ''} ${held} ` +
      `Say "what's scheduled" to see it, or "cancel that post" any time before it goes.`;
  },
});

registerTool({
  name: 'list_scheduled_posts',
  description:
    'Show what is waiting to go out. Use when Shahyd asks what is scheduled, ' +
    "what is going out this week, or what is on the calendar.",
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    const live = listScheduled().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (!live.length) return 'Nothing is scheduled.';
    const lines = live.map((p, i) => {
      const cap = p.caption.length > 70 ? p.caption.slice(0, 70) + '…' : p.caption;
      const who = p.status === 'handed-to-meta' ? 'Facebook is holding it' : publishability(p.platform, p.imageUrl).mode === 'publish' ? 'I will publish it' : 'I will remind you';
      return `${i + 1}. ${when(p.at)} — ${p.platform} — ${who}\n   "${cap}"`;
    });
    return `${live.length} scheduled:\n\n${lines.join('\n')}`;
  },
});

registerTool({
  name: 'cancel_scheduled_post',
  description:
    'Take a scheduled post off the calendar. Use when Shahyd says to cancel ' +
    'or drop a scheduled post. He can refer to it by its number in the list ' +
    'or by something in the caption.',
  inputSchema: {
    type: 'object',
    properties: { which: { type: 'string', description: 'The number from the list, or words from the caption.' } },
    required: ['which'],
  },
  handler: async ({ which }) => {
    const before = listScheduled().find((p) => {
      const n = Number(String(which).trim());
      const live = listScheduled();
      return Number.isInteger(n) ? live[n - 1]?.id === p.id : p.caption.toLowerCase().includes(String(which).toLowerCase());
    });
    const r = cancelPost(which);
    if (r.error) return r.error;
    // A Facebook post already handed over lives on Meta's side, not ours.
    if (before?.status === 'handed-to-meta') {
      try {
        const { facebookDeletePost } = await import('./tools/facebook.js');
        if (facebookDeletePost && before.remoteId) {
          const d = await facebookDeletePost(before.remoteId);
          if (d?.error) {
            return `Taken off my calendar, but Facebook already has it and I could not withdraw it: ${d.error}. ` +
              'You will need to delete it from the Page yourself.';
          }
          return `Cancelled — and withdrawn from Facebook. It will not go out.`;
        }
      } catch { /* fall through to the honest note below */ }
      return 'Taken off my calendar. Facebook is still holding a scheduled copy, though — delete it from the Page to be certain it does not go out.';
    }
    return `Cancelled — the ${r.cancelled.platform} post for ${when(r.cancelled.at)} will not go out.`;
  },
});
