/**
 * Legacy — Tier 3: the voice server.
 *
 * Serves a small local web page (public/index.html) where Shahyd holds Space
 * to talk. A spoken turn flows: browser mic → /voice-turn → ears (Deepgram)
 * → THE SAME agent runTurn() from Tier 2 → mouth (Kokoro, local) → audio back
 * to the browser to play.
 *
 * The golden rule made real: voice is an adapter on the edges. The brain,
 * tools, and history in the middle are byte-for-byte the same code the
 * terminal uses. There is deliberately no second agent loop in this file.
 *
 * Run with:  npm run voice   →  then open http://localhost:3000
 * (The terminal text mode, `npm start`, still works and always will.)
 */

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildStablePrompt, buildDynamicContext } from './systemPrompt.js';
import { runTurn } from './agent.js';
import { appendAudit } from './audit.js';
import { explainError } from './brain.js';
import { transcribe } from './ears.js';
import { speak, warmUp } from './mouth.js';
import './tools/all.js';
import { preflight } from './preflight.js'; // every tool, one list — see the note in that file
import { loadSocials } from './tools/socials.js';
import { pendingPayments } from './tools/studio.js';
import { formatForPrompt } from './memory.js';
import { noticesForPrompt, listPending, dismissNotice } from './notices.js';
import { startHeartbeat, logSystemError } from './heartbeat.js';
import { listPendingActions, decideAction } from './gate.js';
import { getActivity } from './activity.js';
import { resetCards, takeCards } from './cards.js';
import { connectAllAtBoot } from './armory.js';
import { financeSummary } from './tools/finance.js';
import { channelSnapshot } from './tools/youtube.js';
import { loadCustomAgents } from './tools/subagents.js';
import { checkAccess } from './access.js';
import { computeCost, cacheSavings } from './pricing.js';
import { isPaused, setPaused } from './killswitch.js';
import { listFacts } from './memory.js';
import { executeTool } from './tools/registry.js';
import { profileSnapshot } from './tools/instagram.js';
import { config } from './config.js';

const NAME = config.assistant.name;
const PORT = config.voice.serverPort ?? 3000;
const remoteAccess = config.voice.remoteAccess === true && Boolean(process.env.LEGACY_PIN);
const localHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(`\n${NAME} needs an API key. Copy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

// Rebuilt every turn so newly remembered facts AND fresh notices apply
// immediately — this is how heartbeat reminders reach Shahyd by voice.
const STABLE_PROMPT = buildStablePrompt(config); // built once — that's the point
const getSystemPrompt = () => ({ stable: STABLE_PROMPT, dynamic: buildDynamicContext(formatForPrompt() + noticesForPrompt()) });

/** One shared conversation for the single owner — same shape as the terminal. */
const history = [];

/** Read a request body into one Buffer (audio uploads or JSON). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

/* ------------------------------------------------------------------ */
/* Phase B: the streaming turn engine.                                  */
/* Events (NDJSON): meta -> tool* -> speak* -> done | error             */
/* ------------------------------------------------------------------ */

// A BARE yes/no, nothing more. Anything with an actual instruction attached
// falls through to the model instead of being treated as an approval.
// Tolerant of Deepgram punctuation and small joiners: "Yes.", "Yes, please.",
// "OK, send it.", "No, cancel." all count. Anything with real content beyond
// these words still goes to the model.
const CONFIRM_WORDS = "yes|yep|yeah|yup|please|confirm|confirmed|approve|approved|do it|send it|send|go ahead|sure|ok|okay|please do|that'?s right|correct|proceed";
const DENY_WORDS = "no|nope|cancel|stop|don'?t|do not|reject|deny|denied|never ?mind|not now|forget it|leave it";
const CONFIRM_RE = new RegExp(`^(?:(?:${CONFIRM_WORDS})[\\s,.!]*)+$`, 'i');
const DENY_RE = new RegExp(`^(?:(?:${DENY_WORDS})[\\s,.!]*)+$`, 'i');

const SIGNOFF_RE = /^(ok(ay)?|thanks( legacy)?|thank you( legacy)?|great|cool|perfect|nice|alright|got it|good ?night( legacy)?|bye|goodbye|see you|that'?s all)[.!,\s]*$/i;
const ACKS = ['Anytime.', 'You got it.', 'Happy to help.', 'Always here.'];

/** Split a growing buffer at the last safe sentence boundary. */
/**
 * Pull off whatever is ready to be spoken.
 *
 * THE FIRST CHUNK IS THE ONE HE FEELS (v1.70). Everything after it arrives
 * while she is already talking, so it can be long and smooth. The first one is
 * dead air, and dead air is the whole of "she feels slow".
 *
 * So the first chunk goes out as soon as there is a finished clause — a comma
 * or a dash will do, not just a full stop — and after that it settles into
 * longer sentences, which read better and give the synthesiser room for
 * natural prosody.
 */
function takeReadySentences(buf, minLen = 44, hardMax = 280, first = false) {
  const re = first ? /[.!?,;:—]["')\]]*\s/g : /[.!?]["')\]]*\s/g;
  const floor = first ? 16 : minLen;
  let lastEnd = -1, m;
  while ((m = re.exec(buf)) !== null) {
    lastEnd = m.index + m[0].length;
    if (first) break;              // first out the door, do not wait for more
  }
  if (lastEnd >= floor) return [buf.slice(0, lastEnd).trim(), buf.slice(lastEnd)];
  if (buf.length > (first ? 90 : hardMax)) {
    const cut = first ? 90 : hardMax;
    return [buf.slice(0, cut).trim(), buf.slice(cut)];
  }
  return [null, buf];
}

async function streamTurn(res, userText, { transcript, sttMs, image } = {}) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  const send = (o) => res.write(JSON.stringify(o) + '\n');
  const t0 = Date.now();
  if (transcript !== undefined) send({ type: 'meta', transcript: transcript ?? '', sttMs: sttMs ?? 0 });
  if (!userText?.trim()) { send({ type: 'done', reply: null, toolsUsed: [], cards: [] }); return res.end(); }
  resetCards();

  // Sign-off shortcut: a pure "thanks / goodnight" never wakes the model —
  // one short warm close, no dangling question, near-zero latency and cost.
  if (!image && SIGNOFF_RE.test(userText.trim())) {
    const ack = /night/i.test(userText) ? 'Good night, Shahyd.' : ACKS[Math.floor(Math.random() * ACKS.length)];
    history.push({ role: 'user', content: userText }, { role: 'assistant', content: ack });
    try { send({ type: 'speak', b64: (await speak(ack)).toString('base64'), text: ack }); }
    catch { /* text still lands */ }
    send({ type: 'done', reply: ack, toolsUsed: [], cards: [], timing: { signoff: true } });
    appendAudit('turn_timing', { signoff: true, totalMs: Date.now() - t0 });
    return res.end();
  }

  // VOICE CONFIRMATION. If something is waiting for approval and Shahyd says
  // a plain "yes" / "confirm" / "no", decide it right here — no model call, no
  // clicking the card. Deliberately deterministic: Legacy can never approve
  // her own pending action, because this runs on Shahyd's words alone.
  // Only a BARE confirmation counts; "yes and also book a session" still goes
  // to the model, so a real instruction is never swallowed.
  if (!image) {
    const said = userText.trim();
    const isYes = CONFIRM_RE.test(said), isNo = DENY_RE.test(said);
    if (isYes || isNo) {
      const waiting = listPendingActions();
      if (waiting.length) {
        const target = waiting[waiting.length - 1]; // the most recent ask
        let reply;

        // VOICE RECOGNITION NO LONGER GATES ANYTHING (v1.59).
        //
        // From v1.48 a "yes" was refused unless Legacy believed it was Shahyd
        // speaking. Rebuilt in v1.54 when it kept misfiring, and it still did.
        // The cost was not theoretical: his approvals sat pending and the work
        // stopped, in his own studio, on his own machine.
        //
        // The security it bought was thin to begin with — anyone at that
        // keyboard could type the same yes — while the friction it caused was
        // real and constant. A lock that keeps out the owner and nobody else
        // is not a lock. So it is gone, not merely disabled: no flag to flip
        // back on by accident.


        try {
          const outcome = await decideAction(target.id, isYes);
          reply = outcome.message ?? (isYes ? 'Done.' : 'Cancelled.');
        } catch (e) {
          reply = `I couldn't complete that: ${e.message}`;
        }
        const left = listPendingActions().length;
        if (left) reply += ` ${left} more waiting.`;
        history.push({ role: 'user', content: userText }, { role: 'assistant', content: reply });
        try { send({ type: 'speak', b64: (await speak(reply)).toString('base64'), text: reply }); }
        catch { /* text still lands */ }
        appendAudit('voice_decision', { approved: isYes, actionId: target.id, summary: target.summary });
        send({ type: 'done', reply, toolsUsed: [], cards: takeCards(), pending: left, timing: { voiceDecision: true } });
        return res.end();
      }
    }
  }


  // Token economy (v1.40): fold older messages into a recap before we spend
  // anything on this turn, so a non-stop session stays affordable.
  try {
    const { compactInPlace } = await import('./lean.js');
    const note = compactInPlace(history);
    if (note) console.log(`[lean] ${note}`);
  } catch { /* compaction is a saving, never a blocker */ }

  const turnStart = history.length;
  // A staged file drop rides into THIS turn: the extracted content wraps the
  // command Shahyd just gave, and a dropped image becomes the turn's image
  // (camera/screen images win if both exist). Consumed exactly once — and
  // deliberately AFTER the sign-off and voice-approval intercepts, so saying
  // "yes" to an approval never burns the drop.
  {
    const { takePendingDrop } = await import('./filedrop.js');
    const drop = takePendingDrop();
    if (drop) {
      if (drop.image && !image) image = drop.image;
      const parts = [];
      if (drop.summaryLines.length) parts.push(`[Shahyd dropped files]\n${drop.summaryLines.join('\n')}`);
      if (drop.blocks.length) parts.push(drop.blocks.join('\n\n'));
      if (parts.length) {
        userText = `${parts.join('\n\n')}\n\n[Shahyd's instruction for these files]\n${userText}`;
      }
    }
  }

  // A screenshot rides along as an image block; everything downstream (tools,
  // streaming, TTS, cards) is byte-for-byte the same path as a normal turn.
  history.push({
    role: 'user',
    content: image
      ? [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.b64 } },
          { type: 'text', text: userText },
        ]
      : userText,
  });
  const toolsUsed = [];
  let sentenceBuf = '';
  let firstTextAt = 0, firstAudioAt = 0, spokeYet = false;
  let ttsChain = Promise.resolve();

  const speakOut = (text) => {
    if (!text?.trim()) return;
    ttsChain = ttsChain.then(async () => {
      try {
        const b64 = (await speak(text)).toString('base64');
        if (!firstAudioAt) firstAudioAt = Date.now();
        send({ type: 'speak', b64, text });
      } catch (err) { logSystemError(`stream tts: ${err.message}`); }
    });
  };

  try {
    const replyText = await runTurn({
      runLabel: 'conversation',
      systemPrompt: getSystemPrompt(),
      history,
      onToolUse: (name) => { toolsUsed.push(name); send({ type: 'tool', name }); },
      onText: (chunk) => {
        if (!firstTextAt) firstTextAt = Date.now();
        sentenceBuf += chunk;
        const [ready, rest] = takeReadySentences(sentenceBuf, 44, 280, !spokeYet);
        if (ready) { sentenceBuf = rest; spokeYet = true; speakOut(ready); }
      },
    });
    speakOut(sentenceBuf); sentenceBuf = '';
    await ttsChain;
    // Drop the raw image from history once it's been read — Legacy's own
    // description carries the meaning, and re-sending megabytes of base64 on
    // every later turn would be slow and expensive.
    if (image && history[turnStart]) {
      const what = image.source === 'camera' ? "looked through Shahyd's camera"
        : image.source === 'file' ? `looked at the file Shahyd dropped (${image.name ?? 'image'})`
        : "looked at Shahyd's screen";
      history[turnStart] = { role: 'user', content: `[${what}] ${userText}` };
    }
    send({ type: 'done', model: config.model.name, reply: replyText, toolsUsed, cards: takeCards(),
      // Roadmap 4 #31: if an approval is waiting, the UI keeps listening so
      // Shahyd can simply say "yes".
      pending: listPendingActions().length,
      timing: { sttMs: sttMs ?? 0, firstTextMs: firstTextAt ? firstTextAt - t0 : null, firstAudioMs: firstAudioAt ? firstAudioAt - t0 : null, totalMs: Date.now() - t0 } });
    appendAudit('turn_timing', { sttMs: sttMs ?? 0, firstTextMs: firstTextAt ? firstTextAt - t0 : null, firstAudioMs: firstAudioAt ? firstAudioAt - t0 : null, totalMs: Date.now() - t0, tools: toolsUsed.length });
    console.log(`[turn] stt ${sttMs ?? 0}ms · first text ${firstTextAt ? firstTextAt - t0 : '—'}ms · first audio ${firstAudioAt ? firstAudioAt - t0 : '—'}ms · total ${Date.now() - t0}ms`);
  } catch (err) {
    history.length = turnStart;
    logSystemError(`stream turn failed: ${err.message}`);
    send({ type: 'error', message: explainError(err) });
  }
  res.end();
}

/* --- Phase E: month-to-date cost from the audit trail, cached 60s --- */
let usageCache = { at: 0, data: null };
function monthUsage() {
  if (Date.now() - usageCache.at < 60_000) return usageCache.data;
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString().slice(0, 7);
  const today = now.toISOString().slice(0, 10);
  const out = {
    month: thisMonth, cost: 0, calls: 0, todayCost: 0, lastMonthCost: 0,
    cacheSaved: 0, perModel: {}, days: {},
  };
  try {
    const lines = readFileSync(new URL('../data/audit.log', import.meta.url), 'utf8').trim().split('\n');
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'model_call') continue;
      const day = String(e.ts).slice(0, 10), month = day.slice(0, 7);
      const model = e.model ?? 'unrecorded (pre-v1.5)';
      // Price it as of WHEN THE CALL HAPPENED, so a launch-rate change does not
      // silently rewrite last month's numbers.
      const at = Date.parse(e.ts) || undefined;
      const cost = computeCost(e.model, {
        input: e.inputTokens ?? 0, output: e.outputTokens ?? 0,
        cacheWrite: e.cacheWriteTokens ?? 0, cacheRead: e.cacheReadTokens ?? 0,
      }, at);
      // null means "I cannot price this model" — count the call, never invent
      // a zero that would read as free.
      const priced = typeof cost === 'number';
      if (month === lastMonth) { if (priced) out.lastMonthCost += cost; continue; }
      if (month !== thisMonth) continue;
      if (priced) out.cost += cost; else out.unpricedCalls = (out.unpricedCalls ?? 0) + 1;
      out.calls += 1;
      out.cacheSaved += cacheSavings(e.model, e.cacheReadTokens ?? 0, at);
      if (priced) {
        out.days[day] = (out.days[day] ?? 0) + cost;
        if (day === today) out.todayCost += cost;
      }
      const pm = (out.perModel[model] ??= { cost: 0, calls: 0, unpriced: 0 });
      pm.calls += 1;
      if (priced) pm.cost += cost; else pm.unpriced += 1;
    }
  } catch { /* no audit yet — zeroed payload is correct */ }
  usageCache = { at: Date.now(), data: out };
  return out;
}

/* --- weather + AI wire, both cached and fail-soft --- */
let wxCache = { at: 0, data: null };
async function getWeather() {
  if (Date.now() - wxCache.at < 15 * 60_000) return wxCache.data;
  try {
    const w = config.ui?.weather ?? { latitude: 4.1755, longitude: 73.5093, place: 'Malé' };
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${w.latitude}&longitude=${w.longitude}&current_weather=true`);
    const d = await r.json();
    const c = d.current_weather;
    const CODE = { 0: ['Clear', '☀'], 1: ['Mostly clear', '🌤'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁'], 45: ['Fog', '🌫'], 51: ['Drizzle', '🌦'], 61: ['Rain', '🌧'], 63: ['Rain', '🌧'], 65: ['Heavy rain', '🌧'], 80: ['Showers', '🌦'], 81: ['Showers', '🌦'], 95: ['Thunderstorm', '⛈'] };
    const [label, icon] = CODE[c.weathercode] ?? ['', '·'];
    wxCache = { at: Date.now(), data: { temp: Math.round(c.temperature), label, icon, place: w.place, windKmh: Math.round(c.windspeed) } };
  } catch { wxCache = { at: Date.now(), data: wxCache.data }; }
  return wxCache.data;
}

let newsCache = { at: 0, data: null };
async function getAINews() {
  if (Date.now() - newsCache.at < 60 * 60_000) return newsCache.data;
  if (!process.env.TAVILY_API_KEY) return null;
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: 'latest AI artificial intelligence news', topic: 'news', days: 2, max_results: 4 }),
    });
    const d = await r.json();
    newsCache = { at: Date.now(), data: (d.results ?? []).slice(0, 4).map((x) => ({ title: x.title, url: x.url })) };
  } catch { newsCache = { at: Date.now(), data: newsCache.data }; }
  return newsCache.data;
}

const handler = async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    const origin = req.headers.origin;
    const scheme = req.socket.encrypted ? 'https' : 'http';
    if ((!remoteAccess && !localHosts.has(req.headers.host)) || req.headers['sec-fetch-site'] === 'cross-site' ||
        (origin && origin !== `${scheme}://${req.headers.host}`)) {
      return sendJSON(res, 403, { error: 'Request must come from the Legacy AI window.' });
    }
    // Tier 13: the PC is trusted; every other device needs the PIN.
    const verdict = checkAccess({
      remoteAddress: req.socket?.remoteAddress,
      url: req.url,
      pinHeader: req.headers['x-legacy-pin'],
    });
    if (!verdict.ok) return sendJSON(res, verdict.status ?? 401, { error: verdict.reason });

    if (req.method === 'GET' && req.url === '/legacy_studios_logo.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      return res.end(readFileSync(new URL('../public/legacy_studios_logo.png', import.meta.url)));
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // Never cache: after each tier upgrade the browser must load the NEW
        // page, not a stale copy — a cached old page has no notice banner.
        'Cache-Control': 'no-store',
      });
      res.end(readFileSync(new URL('../public/index.html', import.meta.url)));
      return;
    }

    // A spoken turn — STREAMED (Phase B): transcript first, then audio
    // sentence by sentence while the rest of the reply is still being written.
    // File drop (#11): save + extract now; the NEXT turn carries the content.
    // The shop: the website's checkout posts orders here.
    if (req.url === '/shop/order' && req.method === 'POST') {
      try {
        const { handleOrderPost } = await import('./shop.js');
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const { status, out } = handleOrderPost(body, req.headers);
        return sendJSON(res, status, out);
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (req.url === '/shop/catalogue' && req.method === 'GET') {
      const { publicCatalogue } = await import('./shop.js');
      return sendJSON(res, 200, { items: publicCatalogue() });
    }

    // Phone Link health ping — no secret, just proves the app can reach the PC.
    if (req.url === '/phone-ping' && req.method === 'GET') {
      return sendJSON(res, 200, { ok: true, service: 'legacy' });
    }
    // Phone Link: the Android app posts mirrored notifications here.
    if (req.url === '/phone-notify' && req.method === 'POST') {
      try {
        const { handlePhoneNotify } = await import('./phonelink.js');
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const { status, out } = await handlePhoneNotify(body, req.headers);
        return sendJSON(res, status, out);
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (req.url?.startsWith('/phone-pair') && req.method === 'GET') {
      const { pairingPayload } = await import('./phonelink.js');
      const host = new URL(req.url, 'http://x').searchParams.get('host') || '';
      return sendJSON(res, 200, { payload: pairingPayload(host) });
    }
    if (req.url === '/phone-link' && req.method === 'GET') {
      const { phoneLinkStatus } = await import('./phonelink.js');
      return sendJSON(res, 200, phoneLinkStatus());
    }
    if (req.url === '/phone-announce' && req.method === 'GET') {
      const { peekAnnouncement } = await import('./phonelink.js');
      return sendJSON(res, 200, { announcement: peekAnnouncement() });
    }
    if (req.url === '/phone-announce-audio' && req.method === 'POST') {
      try {
        const { peekAnnouncement } = await import('./phonelink.js');
        const a = peekAnnouncement();
        if (!a) return sendJSON(res, 200, {});
        const wav = await speak(a.text);
        return sendJSON(res, 200, { id: a.id, text: a.text, b64: wav.toString('base64') });
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (req.url === '/phone-announce-heard' && req.method === 'POST') {
      const { markAnnouncementHeard } = await import('./phonelink.js');
      markAnnouncementHeard(JSON.parse((await readBody(req)).toString('utf8')).id);
      return sendJSON(res, 200, { ok: true });
    }

    // Media player: shared state the popup follows; tracks stream by id only.
    if (req.url === '/player' && req.method === 'GET') {
      const { playerState } = await import('./tools/media.js');
      return sendJSON(res, 200, playerState());
    }
    if (req.url === '/player/ctl' && req.method === 'POST') {
      try {
        const { controlPlayer } = await import('./tools/media.js');
        const p = JSON.parse((await readBody(req)).toString('utf8'));
        return sendJSON(res, 200, controlPlayer(p.action, p.value));
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (req.url?.startsWith('/media-track?') && req.method === 'GET') {
      const { serveTrack } = await import('./tools/media.js');
      return serveTrack(req, res, new URL(req.url, 'http://x').searchParams.get('id'));
    }

    // Hourly voice briefing: the page polls, plays, then confirms it heard.
    if (req.url === '/briefing' && req.method === 'GET') {
      const { peekBriefing } = await import('./heartbeat.js');
      return sendJSON(res, 200, { briefing: peekBriefing() });
    }
    if (req.url === '/briefing-audio' && req.method === 'POST') {
      try {
        const { peekBriefing } = await import('./heartbeat.js');
        const b = peekBriefing();
        if (!b) return sendJSON(res, 200, {});
        const wav = await speak(b.text);
        return sendJSON(res, 200, { id: b.id, text: b.text, b64: wav.toString('base64') });
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (req.url === '/briefing-heard' && req.method === 'POST') {
      const { markBriefingHeard } = await import('./heartbeat.js');
      markBriefingHeard(JSON.parse((await readBody(req)).toString('utf8')).id);
      return sendJSON(res, 200, { ok: true });
    }

    // The catalog of connectors worth having, with the command that actually
    // works (v1.97). The armory could always connect anything — but only if he
    // knew the exact npx line, and nobody keeps those in their head.
    if (req.url === '/armory/catalog' && req.method === 'GET') {
      const { catalogWithState } = await import('./armory.js');
      return sendJSON(res, 200, { catalog: catalogWithState() });
    }

    // Tool armory: Legacy's connector system (MCP client).
    if (req.url === '/armory' && req.method === 'GET') {
      const { armoryStatus } = await import('./armory.js');
      return sendJSON(res, 200, { servers: armoryStatus() });
    }
    if (req.url?.startsWith('/armory/') && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const a = await import('./armory.js');
          const p = JSON.parse(body || '{}');
          if (req.url === '/armory/add') return sendJSON(res, 200, await a.addServer(p));
          if (req.url === '/armory/toggle') return sendJSON(res, 200, await a.toggleServer(p.id, p));
          if (req.url === '/armory/remove') return sendJSON(res, 200, await a.removeServer(p.id));
          return sendJSON(res, 404, { error: 'unknown armory action' });
        } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      });
      return;
    }

    // Settings window: read, change, and test the brain.
    // The redesigned settings window (v3.16).
    // The people Legacy knows (v3.17). Descriptors never leave the server.
    /* ---- v3.19: vision, ideas, today, agent results ---- */
    if (req.method === 'POST' && ['/vision-name', '/receipt-read', '/idea-save'].some((p) => req.url.startsWith(p))) {
      let body = '';
      // Ideas carry up to a minute of audio; frames up to a full-res photo.
      req.on('data', (c) => { body += c; if (body.length > 8_000_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const d = JSON.parse(body || '{}');
          if (req.url.startsWith('/vision-name')) return sendJSON(res, 200, await (await import('./vision.js')).liveName(d.shot));
          if (req.url.startsWith('/receipt-read')) return sendJSON(res, 200, await (await import('./vision.js')).readReceipt(d.shot));
          const idea = (await import('./ideas.js')).saveIdea(d);
          return sendJSON(res, 200, { ok: true, idea });
        } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
      });
      return;
    }
    // Her own skills (v3.22): the list, the live widgets, on/off.
    if (req.method === 'GET' && req.url === '/skills') {
      return sendJSON(res, 200, { skills: (await import('./skills.js')).skillList() });
    }
    if (req.method === 'POST' && req.url === '/skill-toggle') {
      let body = ''; req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', async () => {
        try { const d = JSON.parse(body || '{}'); const { executeTool } = await import('./tools/registry.js');
          return sendJSON(res, 200, { ok: true, result: (await executeTool('toggle_code_skill', { slug: String(d.slug), on: Boolean(d.on) })).result }); }
        catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/skill-widgets') {
      return sendJSON(res, 200, { widgets: await (await import('./skills.js')).readWidgets() });
    }

    // The page the browser photographs into a post image (v3.20).
    if (req.method === 'GET' && req.url.startsWith('/postcard')) {
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      const C = await import('./crosspost.js');
      const d = C.getDraft(id);
      if (!d) { res.writeHead(404); return res.end('no such draft'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(C.postcardHtml(d));
    }
    if (req.method === 'GET' && req.url.startsWith('/idea-audio')) {
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      const p = (await import('./ideas.js')).audioPath(id);
      if (!p) { res.writeHead(404); return res.end(); }
      const buf = readFileSync(p);
      res.writeHead(200, { 'Content-Type': 'audio/webm', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=3600' });
      return res.end(buf);
    }
    if (req.method === 'GET' && req.url.startsWith('/agent-last')) {
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      return sendJSON(res, 200, { last: (await import('./activity.js')).getLastResult(id) });
    }
    if (req.method === 'GET' && req.url === '/today') {
      // One line of the day. Each part is read from ITS OWN writer — upcoming()
      // for appointments (items with .ms), billsDue() for unpaid bills, the
      // quote file for waiting drafts — and a part that fails is just absent.
      const out = { next: null, bills: [], quotes: 0 };
      try {
        const a = (await import('./tools/appointments.js')).upcoming({ withinHours: 24 * 7 })[0];
        if (a) out.next = { what: a.what, at: a.at, where: a.where ?? null };
      } catch {}
      try {
        const day = new Date().getDate();
        out.bills = (await import('./tools/bills.js')).billsDue()
          .filter((b) => !b.dueDay || b.dueDay - day <= 7)
          .slice(0, 3).map((b) => ({ name: b.name, amount: b.amount ?? null, dueDay: b.dueDay ?? null }));
      } catch {}
      try {
        const q = JSON.parse(readFileSync(new URL('../data/quotes.json', import.meta.url), 'utf8'));
        out.quotes = (q.items ?? []).filter((x) => x.status === 'waiting').length;
      } catch {}
      return sendJSON(res, 200, out);
    }

    if (req.url === '/people' && req.method === 'GET') {
      const { peopleList } = await import('./faces.js');
      return sendJSON(res, 200, { people: peopleList() });
    }
    if (req.url === '/people-edit' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const d = JSON.parse(body || '{}');
          const F = await import('./faces.js');
          if (d.action === 'forget') {
            // forget() takes a NAME, not an id — read the writer.
            const who = F.peopleList().find((p) => p.id === d.id);
            if (!who) return sendJSON(res, 200, { ok: false, error: 'No such person.' });
            F.forget(who.name);
            return sendJSON(res, 200, { ok: true });
          }
          return sendJSON(res, 200, { ok: true, person: F.editPerson(String(d.id ?? ''), d.patch ?? {}) });
        } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
      });
      return;
    }

    if (req.url === '/settings-overview' && req.method === 'GET') {
      try { const { settingsOverview } = await import('./overview.js'); return sendJSON(res, 200, await settingsOverview()); }
      catch (e) { return sendJSON(res, 200, { error: e.message }); }
    }
    if (req.url === '/settings-switch' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const d = JSON.parse(body || '{}');
          const { setSwitch } = await import('./overview.js');
          return sendJSON(res, 200, await setSwitch(String(d.key ?? ''), d.value));
        } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
      });
      return;
    }

    if (req.url === '/settings' && req.method === 'GET') {
      const { getSettings } = await import('./settings.js');
      return sendJSON(res, 200, await getSettings());
    }
    if (req.url === '/settings' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const { updateSettings } = await import('./settings.js');
          return sendJSON(res, 200, await updateSettings(JSON.parse(body)));
        } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      });
      return;
    }
    if (req.url === '/settings/test-model' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const { testModel } = await import('./settings.js');
          return sendJSON(res, 200, await testModel(JSON.parse(body || '{}').model));
        } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      });
      return;
    }
    if (req.url === '/settings/test-voice' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const p = JSON.parse(body || '{}');
          // Preview a voice WITHOUT committing it: swap, speak, swap back.
          const before = { ...config.voice };
          Object.assign(config.voice, p);
          try {
            const wav = await speak('Hello Shahyd — this is how I sound.');
            return sendJSON(res, 200, { b64: wav.toString('base64') });
          } finally { Object.assign(config.voice, before); }
        } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/file-drop') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 22_000_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const { handleFileDrop } = await import('./filedrop.js');
          const payload = JSON.parse(body);
          const out = await handleFileDrop(payload.files);
          return sendJSON(res, 200, out);
        } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/voice-turn') {
      const t0 = Date.now();
      const audio = await readBody(req);
      if (audio.length < 200) {
        return sendJSON(res, 400, { error: "I didn't catch any audio — hold the key while you speak." });
      }
      // WHO IS SPEAKING (v1.48). The page computes a voice imprint from the raw
      // microphone samples and sends it here; by this point the audio itself is
      // compressed webm and would need a decoder to measure.
      let enrolled = null;
      try {
        const vid = await import('./voiceid.js');
        const print = vid.parsePrint(req.headers['x-voice-print']);
        if (vid.enrolmentArmed()) enrolled = vid.consumeEnrolment(print);
        else vid.setCurrentSpeaker(print);
      } catch { /* recognition is an enhancement; never lose the turn over it */ }

      const transcript = await transcribe(audio, req.headers['content-type'] || 'audio/webm');
      if (enrolled?.learned) {
        return streamTurn(res,
          `[system] You have just learned ${enrolled.learned}'s voice (${enrolled.samples} sample${enrolled.samples === 1 ? '' : 's'} now). ` +
          `They said: "${transcript}". Confirm warmly in one sentence that you will know them from now on, then answer what they said if it needs answering.`,
          { transcript, sttMs: Date.now() - t0 });
      }
      if (enrolled?.error) {
        return streamTurn(res, `[system] Voice enrolment failed: ${enrolled.error} Tell him plainly and offer to try again.`, { transcript, sttMs: Date.now() - t0 });
      }
      return streamTurn(res, transcript, { transcript, sttMs: Date.now() - t0 });
    }

    // The constellation roster: built-ins + Factory-minted (Phase D), with
    // orbit parameters so the page can seat newcomers without a code change.
    if (req.method === 'GET' && req.url === '/agents') {
      /**
       * THE ORBIT NOW READS THE SAME SOURCE AS THE ROSTER (v3.7).
       *
       * This was a hardcoded array of five. His config asks for EIGHT on the
       * main screen — and forge, ledger, lyricist and studiobooking are JSON
       * presets, which the array had never heard of. They vanished silently:
       * no error, no gap, just four avatars where there should be eight.
       *
       * This is the exact anti-pattern written down in AGENT.md — two sources
       * of truth for the same list, drifting apart until one of them is
       * quietly wrong. agentRoster() reads the presets, the customs and the
       * built-ins together, so adding an agent now means adding an agent, not
       * adding it in two places and forgetting the second.
       */
      const { agentRoster } = await import('./roster.js');
      const { rows } = await agentRoster();

      // Colour and motion are the orbit's own business — the roster does not
      // carry them, and a preset need not care how fast it circles.
      const LOOK = {
        researcher: '#4dd0e1', marketer: '#e5a34d', coder: '#8b7bd8',
        sales: '#2dd4a8', promoter: '#f472b6', forge: '#ff8a5c',
        ledger: '#7dd3a0', lyricist: '#c084fc', studiobooking: '#60a5fa',
        roadie: '#fbbf24', spot: '#34d399', spotlight: '#f9a8d4',
        shopkeeper: '#a78bfa',
      };

      const main = Array.isArray(config.agents?.main) && config.agents.main.length
        ? config.agents.main
        : null;

      const all = rows.map((a) => ({
        id: a.slug,
        name: a.name,
        spec: a.focus ?? '',
        color: LOOK[a.slug] ?? '#9aa7ff',
        // Which specialists earn a place on the main screen. The rest still
        // exist and still work when asked for by name — they are simply held
        // back so the constellation stays readable. Nothing is deleted.
        stage: !main || main.includes(a.slug) ? 'active' : 'wip',
        // A MISSING AVATAR MUST NOT MEAN A BROKEN IMAGE. Checked here rather
        // than trusted, because an agent with no picture should still orbit —
        // the UI draws its initial instead.
        avatar: existsSync(new URL(`../public/avatars/${a.slug}_avatar.png`, import.meta.url))
          ? `/avatars/${a.slug}_avatar.png` : null,
        r: 4, speed: 0.2, phase: 0, yAmp: 0.8,
      }));

      // Seat the active ones on clean orbits regardless of how many are hidden,
      // so the ring does not develop gaps where a parked agent used to be.
      // Ordered by his config, not alphabetically — the list is his ordering.
      // HIS ORDER, not the roster's. agentRoster() sorts by name for the
      // settings list, which is right there and wrong here — the config list
      // is his seating plan and the first name in it should be the first seat.
      const active = main
        ? main.map((id) => all.find((a) => a.id === id && a.stage === 'active')).filter(Boolean)
        : all.filter((a) => a.stage === 'active');
      let seat = 0;
      for (const a of active) {
        a.r = 3.5 + seat * 0.34;
        a.phase = (seat * 2.399) % 6.283;   // golden angle — no two line up
        a.yAmp = (seat % 2 ? -1 : 1) * (0.7 + (seat % 3) * 0.16);
        a.speed = Math.max(0.12, 0.30 - seat * 0.022);
        seat += 1;
      }
      return sendJSON(res, 200, all);
    }

    // Phase E: month-to-date API spend, per-model, cache savings, day-by-day.
    if (req.method === 'GET' && req.url === '/usage') {
      return sendJSON(res, 200, { usage: monthUsage() });
    }

    // Serve a file FROM the workspace (proposals, saved research) for preview.
    // Path-guarded to stay inside the configured workspace root.
    if (req.method === 'GET' && req.url.startsWith('/workspace-doc?')) {
      const root = config.workspace?.root?.trim();
      if (!root) return sendJSON(res, 404, { error: 'No workspace configured.' });
      const rel = decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('f') || '');
      const full = path.resolve(root, rel);
      if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) {
        return sendJSON(res, 403, { error: 'Path outside workspace.' });
      }
      try {
        const html = readFileSync(full, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      } catch { return sendJSON(res, 404, { error: 'No such file.' }); }
    }

    // Screen share (#21) + webcam recognition (#18). The page captures a frame
    // — from any monitor, or from the camera — and sends it here; it becomes a
    // normal turn with the image attached, so Legacy can describe it AND use
    // her tools on what she sees.
    // Original note: The page captures a frame (any monitor)
    // and sends it here; it becomes a normal turn with the image attached, so
    // Legacy can describe it AND use her tools (save to the vault, etc.).
    if (req.method === 'POST' && (req.url === '/screen-look' || req.url === '/camera-look')) {
      const source = req.url === '/camera-look' ? 'camera' : 'screen';
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 12e6) req.destroy(); });
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Bad request.' }); }
        const raw = String(payload.image ?? '');
        const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(raw);
        if (!m) return sendJSON(res, 400, { error: 'No usable screen image.' });
        const question = String(payload.text ?? '').trim() || (source === 'camera'
          ? "I'm holding something up to the camera. What is it? Describe it and tell me anything useful you know about it."
          : 'What am I looking at on my screen right now? Describe what you can see and read anything important.');
        await streamTurn(res, question, { image: { mediaType: m[1], b64: m[2], source } });
      });
      return;
    }

    // Finance panel (left rail) — Roadmap 3 #27.
    if (req.method === 'GET' && req.url === '/finance') {
      return sendJSON(res, 200, { finance: financeSummary() });
    }

    // Weather (Open-Meteo — free, no key), cached 15 min.
    if (req.method === 'GET' && req.url === '/weather') {
      return sendJSON(res, 200, { weather: await getWeather() });
    }

    // Latest AI headlines via Tavily's news focus, cached 60 min.
    if (req.method === 'GET' && req.url === '/ainews') {
      return sendJSON(res, 200, { news: await getAINews() });
    }

    // Agent avatars for the constellation.
    /**
     * THE ROOM, ON HIS PHONE (v3.11).
     *
     * Not a video stream. The desktop page posts a frame every couple of
     * seconds while the camera is open; the phone fetches the latest one.
     *
     * WHY NOT WEBRTC: signalling, STUN, and a connection that must survive a
     * phone sleeping — a great deal of machinery so he can glance at who is in
     * the room. A JPEG every two seconds answers the actual question, works
     * over Tailscale unchanged, and cannot half-connect.
     *
     * HELD IN MEMORY, NEVER ON DISK. A folder of photographs of his house is
     * not a thing worth keeping, and it would outlive his interest in it.
     */
    // What the camera sees (v3.13) — objects for the scene memory, and a
    // sentry reading when the house is armed. Both come from the page.
    if (req.method === 'POST' && (req.url.startsWith('/scene') || req.url.startsWith('/sentry-event'))) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1_500_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const d = JSON.parse(body || '{}');
          if (req.url.startsWith('/scene')) {
            const { sceneSeen } = await import('./scene.js');
            return sendJSON(res, 200, sceneSeen(d));
          }
          const { sentryTick } = await import('./sentry.js');
          return sendJSON(res, 200, await sentryTick(d));
        } catch (e) { return sendJSON(res, 200, { error: e.message }); }
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/sentry-state')) {
      const { sentryArmed } = await import('./sentry.js');
      return sendJSON(res, 200, { armed: sentryArmed() });
    }

    if (req.method === 'POST' && req.url.startsWith('/room-frame')) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1_500_000) req.destroy(); });
      req.on('end', () => {
        try {
          const d = JSON.parse(body || '{}');
          if (typeof d.shot === 'string' && d.shot.startsWith('data:image/')) {
            roomFrame = { at: Date.now(), shot: d.shot, who: Array.isArray(d.who) ? d.who.slice(0, 8) : [] };
            globalThis.__roomFrame = roomFrame;   // vision.js reads it (v3.19)
          }
          return sendJSON(res, 200, { ok: true });
        } catch (e) { return sendJSON(res, 200, { error: e.message }); }
      });
      return;
    }
    /** The phone page. One file, no build, no dependency. */
    if (req.method === 'GET' && (req.url === '/room' || req.url.startsWith('/room?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Legacy \u2014 the room</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#080a0d;color:#d8f3ec;
    font:400 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
    display:flex;flex-direction:column;min-height:100vh}
  header{padding:14px 16px 10px;display:flex;align-items:center;gap:9px}
  header b{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#4dd9e8;font-weight:600}
  header .dot{width:7px;height:7px;border-radius:50%;background:#4dd9e8;
    animation:p 1.9s ease-in-out infinite}
  header .dot.off{background:#5a5a62;animation:none}
  @keyframes p{0%,100%{opacity:.35}50%{opacity:1}}
  #shot{width:100%;display:block;background:#0d1117;aspect-ratio:4/3;object-fit:cover}
  #who{padding:12px 16px;display:flex;flex-wrap:wrap;gap:6px}
  #who span{background:rgba(77,217,232,.1);border:1px solid rgba(77,217,232,.3);
    border-radius:999px;padding:4px 11px;font-size:12px}
  #who span.unknown{background:rgba(229,163,77,.1);border-color:rgba(229,163,77,.35);color:#f0d2a8}
  #msg{padding:20px 16px;color:#7f9b94;font-size:13px;text-align:center}
  footer{margin-top:auto;padding:12px 16px 18px;color:#5f7871;font-size:11px;text-align:center}
  #acts{display:flex;gap:9px;padding:6px 16px 0}
  #acts a,#acts button{flex:1;text-align:center;text-decoration:none;
    background:rgba(255,255,255,.05);border:1px solid rgba(77,217,232,.25);
    color:#d8f3ec;border-radius:999px;padding:9px 0;font:inherit;font-size:13px;cursor:pointer}
  #acts a:active,#acts button:active{background:rgba(77,217,232,.14)}
</style></head><body>
<header><span class="dot" id="dot"></span><b id="state">connecting</b></header>
<img id="shot" alt="">
<div id="who"></div>
<div id="msg"></div>
<div id="acts"><a href="/" id="back">\u2190 Legacy</a><button id="full">full screen</button></div>
<footer>Refreshes every 2 seconds while the camera is on.</footer>
<script>
  const shot = document.getElementById('shot');
  const who = document.getElementById('who');
  const msg = document.getElementById('msg');
  const dot = document.getElementById('dot');
  const state = document.getElementById('state');
  async function tick() {
    try {
      const d = await (await fetch('/room-frame?t=' + Date.now())).json();
      if (d.live) {
        shot.src = d.shot;
        shot.style.display = 'block';
        msg.textContent = '';
        dot.className = 'dot';
        state.textContent = 'live';
        who.innerHTML = (d.who || []).map((n) =>
          n === 'unknown'
            ? '<span class="unknown">someone I don\\'t know</span>'
            : '<span>' + String(n).replace(/[<>&]/g, '') + '</span>').join('');
      } else {
        // The camera being off is not an error, and saying "no signal" would
        // read like something had broken.
        shot.style.display = 'none';
        who.innerHTML = '';
        msg.textContent = 'The camera is not on right now.';
        dot.className = 'dot off';
        state.textContent = 'camera off';
      }
    } catch {
      dot.className = 'dot off';
      state.textContent = 'cannot reach Legacy';
    }
    setTimeout(tick, 2000);
  }
  document.getElementById('full').onclick = () => {
    // Tapping the picture is the obvious gesture, but on a phone a button
    // that says what it does beats a gesture he has to discover.
    const el = document.getElementById('shot');
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitEnterFullscreen) el.webkitEnterFullscreen();
  };
  tick();
</script></body></html>`);
    }

    if (req.method === 'GET' && req.url.startsWith('/room-frame')) {
      // Older than eight seconds means the camera is OFF, not that the room is
      // empty. Showing a stale picture of an empty chair would be the worst
      // possible answer to "who is in the house".
      const fresh = roomFrame && Date.now() - roomFrame.at < 8000;
      return sendJSON(res, 200, fresh
        ? { live: true, at: roomFrame.at, shot: roomFrame.shot, who: roomFrame.who }
        : { live: false, why: 'the camera is not on' });
    }

    /**
     * The face models and the library that reads them (v3.9.1).
     *
     * THERE IS NO GENERAL STATIC HANDLER. Every file this server sends has its
     * own route — /avatars, the page itself, and a handful of others. I shipped
     * 6.5MB of weights into public/ and never gave them a door, so every single
     * request 404'd and face-api reported it as "models missing". The files
     * were exactly where they should be; nothing could reach them.
     *
     * Two paths only, both read-only, both with the filename scrubbed — a
     * general static server for public/ would expose whatever lands there
     * later, which is not a trade worth making for two folders.
     */
    // /models/objects added v3.13 — the COCO-SSD weights, same rules.
    if (req.method === 'GET' && (req.url.startsWith('/models/face/') || req.url.startsWith('/models/objects/') || req.url.startsWith('/vendor/'))) {
      const prefix = req.url.startsWith('/models/face/') ? '/models/face/'
        : req.url.startsWith('/models/objects/') ? '/models/objects/' : '/vendor/';
      // No slashes, no dots-dots: the name is a leaf or it is nothing.
      const clean = req.url.slice(prefix.length).split('?')[0].replace(/[^a-z0-9_.-]/gi, '');
      if (!clean || clean.startsWith('.')) return sendJSON(res, 404, { error: 'No such file.' });
      try {
        const file = readFileSync(new URL(`../public${prefix}${clean}`, import.meta.url));
        // A weight SHARD has no extension at all. Guessing by extension would
        // have sent them as text/plain and corrupted the floats.
        const type = clean.endsWith('.json') ? 'application/json'
          : clean.endsWith('.js') ? 'application/javascript'
          : 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': file.length,
          // They never change once shipped, and 6.5MB per camera open is rude.
          'Cache-Control': 'max-age=604800, immutable',
        });
        res.end(file);
      } catch { sendJSON(res, 404, { error: 'No such file.' }); }
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/avatars/')) {
      const clean = req.url.slice('/avatars/'.length).split('?')[0].replace(/[^a-z0-9_.-]/gi, '');
      try {
        const img = readFileSync(new URL(`../public/avatars/${clean}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
        res.end(img);
      } catch { sendJSON(res, 404, { error: 'No such avatar.' }); }
      return;
    }

    // System vitals — the left column: socials, latest post, 5h token window.
    if (req.method === 'GET' && req.url === '/vitals') {
      let tokens = 0;
      try {
        const cutoff = Date.now() - 5 * 3_600_000;
        const lines = readFileSync(new URL('../data/audit.log', import.meta.url), 'utf8')
          .trim().split('\n').slice(-6000);
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            if (e.type === 'model_call' && new Date(e.ts).getTime() > cutoff) {
              tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
            }
          } catch { /* skip bad line */ }
        }
      } catch { /* no audit yet */ }
      const budget = config.ui?.fiveHourTokenBudget ?? 1_000_000;
      // Facebook is fetched defensively — if the Page or its permissions are
      // not there, the rail hides the tile rather than showing a zero.
      const facebook = await import('./tools/facebook.js')
        .then((m) => (m.facebookConfigured() ? m.facebookSnapshot() : null))
        .catch(() => null);
      return sendJSON(res, 200, {
        instagram: await profileSnapshot(),
        facebook,
        youtube: await channelSnapshot(),
        socials: loadSocials(),
        tokens5h: { total: tokens, budget, pct: Math.min(100, Math.round((tokens / budget) * 100)) },
      });
    }

    // Mark an invoice paid from the Pending Payments panel.
    if (req.method === 'POST' && req.url === '/mark-paid') {
      const { number } = JSON.parse((await readBody(req)).toString('utf8'));
      const r = await executeTool('mark_invoice_paid', { number });
      return sendJSON(res, 200, { ok: r.ok, message: r.ok ? r.result : r.error });
    }

    // Anything Legacy wants the page to DO (v1.69).
    if (req.method === 'GET' && req.url.startsWith('/stage')) {
      const { takeStage } = await import('./stage.js');
      return sendJSON(res, 200, { items: takeStage() });
    }

    // The page asking whether Legacy wants to see something (v1.68).
    if (req.method === 'GET' && req.url === '/look-pending') {
      const { pendingLook } = await import('./eyes.js');
      return sendJSON(res, 200, pendingLook() ?? {});
    }
    // ...and the page delivering the frame.
    if (req.method === 'POST' && req.url === '/look-frame') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 12e6) req.destroy(); });
      req.on('end', async () => {
        let p;
        try { p = JSON.parse(body || '{}'); } catch { return sendJSON(res, 400, { error: 'Bad request.' }); }
        const { deliverLook } = await import('./eyes.js');
        if (p.error) return sendJSON(res, 200, { ok: deliverLook(p.id, { error: String(p.error).slice(0, 200) }) });
        const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(p.image ?? ''));
        if (!m) return sendJSON(res, 400, { error: 'No usable image.' });
        return sendJSON(res, 200, { ok: deliverLook(p.id, { mediaType: m[1], b64: m[2] }) });
      });
      return;
    }

    // The live order board — what the UI polls so the shop token stays here.
    if (req.method === 'GET' && req.url === '/orders-live') {
      try {
        const { liveOrders } = await import('./shopwatch.js');
        return sendJSON(res, 200, await liveOrders());
      } catch (e) {
        return sendJSON(res, 200, { configured: false, orders: [], error: e.message });
      }
    }

    // Streaming a track so he can hear it (v1.81). Range requests supported,
    // because a 90MB wav that cannot be scrubbed is unusable for a mix review
    // — he wants the chorus, not the intro.
    if (req.method === 'GET' && req.url.startsWith('/audio')) {
      try {
        const rel = new URL(req.url, 'http://x').searchParams.get('f') ?? '';
        const { resolveAudio, audioType } = await import('./tools/audio.js');
        const full = resolveAudio(rel);
        const { existsSync, statSync, createReadStream } = await import('node:fs');
        if (!existsSync(full)) { res.writeHead(404); return res.end('not found'); }
        const type = audioType(full);
        if (!type) { res.writeHead(415); return res.end('not audio'); }

        const size = statSync(full).size;
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m?.[1] ? Number(m[1]) : 0;
          const end = m?.[2] ? Number(m[2]) : size - 1;
          if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
          res.writeHead(206, {
            'Content-Type': type,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
          });
          return createReadStream(full, { start, end }).pipe(res);
        }
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
        return createReadStream(full).pipe(res);
      } catch (e) {
        res.writeHead(400); return res.end(String(e.message).slice(0, 120));
      }
    }

    // A render she made, served so the build surface can show it (v1.86).
    // Scoped to workspace/Renders and to .html — nothing else is reachable
    // through this, so it cannot become a way to read his drive.
    if (req.method === 'GET' && req.url.startsWith('/render')) {
      try {
        const name = new URL(req.url, 'http://x').searchParams.get('f') ?? '';
        if (!/^[a-z0-9-]+\.html$/i.test(name)) { res.writeHead(400); return res.end('bad name'); }
        const root = config.workspace?.root?.trim();
        if (!root) { res.writeHead(404); return res.end('no workspace'); }
        const { resolve, join } = await import('node:path');
        const { existsSync, readFileSync } = await import('node:fs');
        const full = join(resolve(root), 'Renders', name);
        if (!existsSync(full)) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': 'sandbox allow-scripts allow-downloads' });
        return res.end(readFileSync(full));
      } catch { res.writeHead(400); return res.end('bad request'); }
    }

    // Faces (v1.96). The browser does the matching; the server only keeps the
    // numbers. Nothing here reaches the network.
    if (req.method === 'GET' && req.url.startsWith('/faces')) {
      const { faceIndex } = await import('./faces.js');
      return sendJSON(res, 200, faceIndex());
    }
    if (req.method === 'POST' && req.url.startsWith('/face-')) {
      let body = '';
      // 1.5MB: a 640px JPEG of a stranger rides along with the descriptors
      // when there is one, and 200_000 silently destroyed the request — which
      // would have looked like the photo feature simply not working.
      req.on('data', (c) => { body += c; if (body.length > 1_500_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const d = JSON.parse(body || '{}');
          const F = await import('./faces.js');
          if (req.url.startsWith('/face-enrol')) return sendJSON(res, 200, F.enrol(d));
          if (req.url.startsWith('/face-seen')) {
            // A group when the page sends one, a single face when it does not
            // — the old shape still works, so nothing breaks mid-upgrade.
            if (Array.isArray(d?.seen)) return sendJSON(res, 200, await F.onGroupSeen(d.seen, d.shot));
            return sendJSON(res, 200, await F.onFaceSeen(d));
          }
          return sendJSON(res, 404, { error: 'no' });
        } catch (e) { return sendJSON(res, 200, { error: e.message }); }
      });
      return;
    }

    // Editing from the panel (v1.95). Same writers as the voice tools, so
    // there is one set of rules rather than two that drift apart.
    if (req.method === 'POST' && req.url.startsWith('/panel-edit')) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const { panelEdit } = await import('./panels.js');
          return sendJSON(res, 200, panelEdit(JSON.parse(body || '{}')));
        } catch (e) { return sendJSON(res, 200, { error: e.message }); }
      });
      return;
    }

    // The Stream Deck plugin (v2.7). Polls for what to draw, posts key presses.
    if (req.method === 'GET' && req.url.startsWith('/deck?')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const { deckPoll } = await import('./deck.js');
      return sendJSON(res, 200, deckPoll(q.get('since'), q.get('slots')));
    }
    if (req.method === 'POST' && req.url.startsWith('/deck-event')) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20_000) req.destroy(); });
      req.on('end', async () => {
        try {
          const { deckEvent } = await import('./deck.js');
          return sendJSON(res, 200, await deckEvent(JSON.parse(body || '{}')));
        } catch (e) { return sendJSON(res, 200, { error: e.message }); }
      });
      return;
    }

    // The command output feed (v2.7). Only what is NEW since he last asked.
    if (req.method === 'GET' && req.url.startsWith('/term')) {
      const since = new URL(req.url, 'http://x').searchParams.get('since');
      const { termSince } = await import('./termfeed.js');
      return sendJSON(res, 200, termSince(since));
    }

    // Markets and headlines for the right rail (v2.4). Both cached hard.
    if (req.method === 'GET' && req.url.startsWith('/markets')) {
      try { const { marketPanel } = await import('./markets.js'); return sendJSON(res, 200, await marketPanel()); }
      catch (e) { return sendJSON(res, 200, { rows: [], error: e.message }); }
    }
    if (req.method === 'GET' && req.url.startsWith('/news')) {
      try { const { newsPanel } = await import('./markets.js'); return sendJSON(res, 200, await newsPanel()); }
      catch (e) { return sendJSON(res, 200, { items: [], error: e.message }); }
    }

    // The sub-agent roster (v3.5) — who works for him and what they can reach.
    // /agent-roster, NOT /agents — that path already feeds the orbiting
    // avatars, and a second handler on it would have shadowed them. This is
    // the third time; grepping for the path before adding a route is now
    // reflex rather than a lesson.
    if (req.method === 'GET' && req.url.startsWith('/agent-roster')) {
      try { const { agentRoster } = await import('./roster.js'); return sendJSON(res, 200, await agentRoster()); }
      catch (e) { return sendJSON(res, 200, { rows: [], error: e.message }); }
    }

    // The data panels (v1.93). Read-only views; nothing here writes.
    if (req.method === 'GET' && req.url.startsWith('/panel')) {
      try {
        const q = new URL(req.url, 'http://x').searchParams;
        const tab = q.get('tab') ?? 'finance';
        const P = await import('./panels.js');
        if (tab === 'finance') return sendJSON(res, 200, P.financePanel({ month: q.get('month'), year: q.get('year') }));
        if (tab === 'clients') return sendJSON(res, 200, P.clientsPanel());
        if (tab === 'bills') return sendJSON(res, 200, P.billsPanel({ month: q.get('month') }));
        if (tab === 'stock') return sendJSON(res, 200, P.stockPanel());
        if (tab === 'rates') return sendJSON(res, 200, P.ratesPanel());
        if (tab === 'browse') return sendJSON(res, 200, P.browsePanel(q.get('find') ?? ''));
        if (tab === 'read') return sendJSON(res, 200, P.browseRead(q.get('where'), q.get('rel')));
        return sendJSON(res, 400, { error: 'unknown tab' });
      } catch (e) { return sendJSON(res, 200, { error: e.message }); }
    }

    // A screenshot agent-browser just took (v1.85). Only files it produced:
    // the path must be an image inside a temp directory, so this cannot be
    // turned into a way to read arbitrary files off his disk.
    if (req.method === 'GET' && req.url.startsWith('/webshot')) {
      try {
        const p = new URL(req.url, 'http://x').searchParams.get('p') ?? '';
        const { tmpdir } = await import('node:os');
        const { resolve, sep, extname } = await import('node:path');
        const full = resolve(p);
        const tmp = resolve(tmpdir());
        const ok = full.startsWith(tmp + sep) && ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(full).toLowerCase());
        if (!ok) { res.writeHead(403); return res.end('not a screenshot'); }
        const { existsSync, readFileSync } = await import('node:fs');
        if (!existsSync(full)) { res.writeHead(404); return res.end('gone'); }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(readFileSync(full));
      } catch { res.writeHead(400); return res.end('bad request'); }
    }

    // What is actually working (v1.80).
    if (req.method === 'GET' && req.url.startsWith('/health')) {
      try {
        const only = new URL(req.url, 'http://x').searchParams.get('id');
        const { runHealth } = await import('./health.js');
        return sendJSON(res, 200, { checks: await runHealth({ only }), at: new Date().toISOString() });
      } catch (e) { return sendJSON(res, 200, { checks: [], error: e.message }); }
    }

    // The second brain, drawn as a map.
    if (req.method === 'GET' && req.url === '/brain') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(readFileSync(new URL('../public/brain.html', import.meta.url)));
      return;
    }
    if (req.method === 'GET' && req.url === '/brain-graph') {
      try {
        const { buildGraph } = await import('./graph.js');
        return sendJSON(res, 200, buildGraph());
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }

    // The control center — Tier 9.
    if (req.method === 'GET' && req.url === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(readFileSync(new URL('../public/dashboard.html', import.meta.url)));
      return;
    }

    // One payload with everything the dashboard shows, polled every 10s.
    if (req.method === 'GET' && req.url === '/dashboard-data') {
      let tasks = [];
      try { tasks = JSON.parse(readFileSync(new URL('../data/tasks.json', import.meta.url), 'utf8')).tasks ?? []; } catch {}
      let audit = [];
      try {
        const lines = readFileSync(new URL('../data/audit.log', import.meta.url), 'utf8').trim().split('\n');
        audit = lines.slice(-20).reverse()
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
      } catch {}
      let drafts = [];
      try {
        drafts = readdirSync(new URL('../data/drafts/', import.meta.url))
          .filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 10);
      } catch {}
      // The control room's own data (v1.47). Every one of these is allowed to
      // come back null — the page shows "not connected" rather than a zero.
      const [weather, reach, posts, burn] = await Promise.all([
        import('./weather.js').then((m) => m.currentWeather()).catch(() => null),
        import('./vitals.js').then((m) => m.reachSnapshot()).catch(() => null),
        import('./vitals.js').then((m) => m.recentPosts(5)).catch(() => null),
        import('./vitals.js').then((m) => m.tokenBurn()).catch(() => null),
      ]);
      let runs = [];
      try { runs = (await import('./runstate.js')).activeRuns(); } catch {}
      let triggers = [];
      try { triggers = (await import('./triggers.js')).listTriggers(); } catch {}
      let lessons = [];
      try { lessons = (await import('./reflect.js')).listLessons(); } catch {}

      return sendJSON(res, 200, {
        paused: isPaused(),
        actions: listPendingActions(),
        notices: listPending(),
        tasks,
        memory: listFacts(),
        drafts,
        audit,
        payments: pendingPayments(),
        instagram: await profileSnapshot(),
        weather,
        reach,
        posts,
        burn,
        runs,
        triggers,
        lessons,
      });
    }

    // Dashboard quick actions — same tools, same audit trail as conversation.
    if (req.method === 'POST' && req.url === '/complete-task') {
      const { id } = JSON.parse((await readBody(req)).toString('utf8'));
      const r = await executeTool('complete_task', { id: Number(id) });
      return sendJSON(res, 200, { ok: r.ok, message: r.ok ? r.result : r.error });
    }
    if (req.method === 'POST' && req.url === '/add-task') {
      const { title, due } = JSON.parse((await readBody(req)).toString('utf8'));
      const r = await executeTool('add_task', { title, ...(due ? { due } : {}) });
      return sendJSON(res, 200, { ok: r.ok, message: r.ok ? r.result : r.error });
    }
    // Open a generated quotation/invoice — print to PDF from the browser.
    if (req.method === 'GET' && req.url.startsWith('/doc')) {
      const f = new URL(req.url, 'http://x').searchParams.get('f') ?? '';
      const clean = f.replace(/[/\\]/g, '');
      try {
        const html = readFileSync(new URL(`../data/documents/${clean}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch {
        sendJSON(res, 404, { error: 'No such document.' });
      }
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/draft-content')) {
      const f = new URL(req.url, 'http://x').searchParams.get('f') ?? '';
      const clean = f.replace(/[/\\]/g, '');
      try {
        const text = readFileSync(new URL(`../data/drafts/${clean}`, import.meta.url), 'utf8');
        return sendJSON(res, 200, { ok: true, content: text });
      } catch {
        return sendJSON(res, 404, { ok: false, error: 'No such draft.' });
      }
    }

    // Live activity — polled by the page while a turn runs, to show the
    // specialist-at-work window in real time.
    if (req.method === 'GET' && req.url === '/activity') {
      return sendJSON(res, 200, { activity: getActivity() });
    }

    // Everything the page needs to stay current: pending confirmations,
    // notices (catch-up-on-return), and the kill-switch state.
    if (req.method === 'GET' && (req.url === '/status' || req.url === '/notices')) {
      return sendJSON(res, 200, {
        paused: isPaused(),
        actions: listPendingActions(),
        notices: listPending(),
      });
    }

    // Shahyd's decision on a held action — from the Approve/Deny buttons.
    // This human channel is the ONLY web path that can run a gated tool.
    if (req.method === 'POST' && req.url === '/action-decision') {
      const { id, approve } = JSON.parse((await readBody(req)).toString('utf8'));
      const result = await decideAction(Number(id), !!approve);
      return sendJSON(res, 200, result);
    }

    // The kill switch: pause/resume all proactive behavior in one click.
    if (req.method === 'POST' && req.url === '/pause') {
      const { paused } = JSON.parse((await readBody(req)).toString('utf8'));
      return sendJSON(res, 200, { paused: setPaused(!!paused) });
    }

    // Dismiss a notice from its ✕ button on the page.
    if (req.method === 'POST' && req.url === '/dismiss-notice') {
      const { id } = JSON.parse((await readBody(req)).toString('utf8'));
      dismissNotice(Number(id));
      return sendJSON(res, 200, { ok: true });
    }

    // A typed turn — same stream, no STT. The text path stays alive forever.
    if (req.method === 'POST' && req.url === '/text-turn') {
      const { text } = JSON.parse((await readBody(req)).toString('utf8'));
      if (!text?.trim()) return sendJSON(res, 400, { error: 'Empty message.' });
      return streamTurn(res, text.trim(), {});
    }

    sendJSON(res, 404, { error: 'Not found.' });
  } catch (err) {
    logSystemError(`request ${req.method} ${req.url} failed: ${err.message}`);
    sendJSON(res, 500, { error: explainError(err) });
  }
};

/** The latest camera frame, for his phone. Memory only — see /room-frame. */
let roomFrame = null;

export const server = createServer(handler);

// The Android app reaches only its receiver over the private Tailscale interface.
const tailAddress = Object.entries(networkInterfaces())
  .filter(([name]) => /tailscale/i.test(name)).flatMap(([, addresses]) => addresses ?? [])
  .find(({ family, address }) => family === 'IPv4' && /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address))?.address;
if (process.env.LEGACY_PHONE_LINK === '1' && tailAddress && !remoteAccess) {
  const receiver = createServer(async (req, res) => {
    if (req.headers.host !== `${tailAddress}:${PORT}`) return sendJSON(res, 403, { error: 'Invalid receiver address.' });
    if (req.method === 'GET' && req.url === '/phone-ping') return sendJSON(res, 200, { ok: true, service: 'legacy' });
    if (req.method !== 'POST' || req.url !== '/phone-notify') return sendJSON(res, 404, { error: 'Not found.' });
    const size = Number(req.headers['content-length']);
    if (!size || size > 32 * 1024) return sendJSON(res, 413, { error: 'Invalid notification size.' });
    try {
      const { handlePhoneNotify } = await import('./phonelink.js');
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { status, out } = await handlePhoneNotify(body, req.headers);
      sendJSON(res, status, out);
    } catch { sendJSON(res, 400, { error: 'Invalid notification.' }); }
  });
  receiver.on('error', (err) => console.error(`[phone link] Receiver could not start: ${err.message}`));
  receiver.listen(PORT, tailAddress, () => {
    config.phoneLink.receiverUrl = `http://${tailAddress}:${PORT}`;
    console.log(`[phone link] Pair over Tailscale at ${config.phoneLink.receiverUrl}`);
  });
}

// HTTPS twin for tablets/phones — same handler, same brain, secure origin so
// the microphone works. Fails soft: no certificate = PC-only mode, not a crash.
if (remoteAccess) try {
  const { ensureCert } = await import('./certs.js');
  const tls = await ensureCert();
  const HTTPS_PORT = config.voice.httpsPort ?? 3443;
  const https = createHttpsServer(tls, handler);
  https.on('error', (err) => console.error(`[remote] HTTPS listener could not start: ${err.message}`));
  https.listen(HTTPS_PORT, () => {
    const ips = Object.values(networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal);
    // Tailscale addresses live in the 100.64.0.0/10 CGNAT range — match it
    // precisely so a normal 100.x LAN IP is never mistaken for a tailnet.
    const isTailscale = (a) => { const m = a.match(/^100\.(\d+)\./); return m && +m[1] >= 64 && +m[1] <= 127; };
    const lan = ips.find((i) => !isTailscale(i.address))?.address;
    const tailscale = ips.find((i) => isTailscale(i.address))?.address;
    console.log(`[remote] tablet/phone (same Wi-Fi): https://${lan ?? 'YOUR-PC-IP'}:${HTTPS_PORT} — accept the one-time certificate warning`);
    if (tailscale) {
      console.log(`[remote] ANYWHERE (Tailscale detected): https://${tailscale}:${HTTPS_PORT} — reachable from your phone/tablet on any network, encrypted.`);
    } else {
      console.log('[remote] Anywhere-access: install Tailscale (free) on this PC and your phone, sign in with the same account on both — Legacy then prints a 100.x address here that works from any network. Guide: https://tailscale.com/download');
    }
    if (!process.env.LEGACY_PIN) {
      console.log('[remote] LEGACY_PIN is not set in .env — remote devices can load the page but ALL data/actions are disabled until you set one. Set it before using Tailscale access.');
    }
  });
} catch (err) {
  console.log(`[remote] tablet access unavailable (${err.message}) — Legacy still works normally on this PC.`);
}

server.listen(PORT, remoteAccess ? '0.0.0.0' : '127.0.0.1', () => {
import('./termfeed.js').then(({ mirrorConsole, term }) => {
  mirrorConsole();
  term('Legacy online.', 'info');
}).catch(() => { /* the feed is a window, never a requirement */ });

connectAllAtBoot(); // tool armory: bring enabled connections up in the background
  console.log(`\n${NAME} voice mode is starting on  http://localhost:${PORT}`);
  // The phone app talks PLAIN HTTP to the MAIN port over the Tailscale tunnel
  // (the tunnel is the encryption). Print that exact address so pairing is
  // unambiguous — the HTTPS 3443 address is for the browser UI, NOT the app.
  try {
    const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
    const ts = ips.find((a) => { const m = a.address.match(/^100\.(\d+)\./); return m && +m[1] >= 64 && +m[1] <= 127; });
    if (remoteAccess && ts) console.log(`[phone link] Pair the Legacy Link app to:  http://${ts.address}:${PORT}   (plain http, over Tailscale)`);
    else if (process.env.LEGACY_PHONE_LINK === '1' && !tailAddress) console.log('[phone link] Connect Tailscale and restart Legacy AI.');
  } catch { /* best-effort banner */ }
  if (!(process.env.IG_ACCESS_TOKEN && config.social?.instagram?.userId)) {
    console.log('[instagram] insights are dormant — run `npm run setup:instagram` after the Meta setup to enable them.');
  }
  if (!process.env.TAVILY_API_KEY) {
    console.log('[research] web research is dormant — add TAVILY_API_KEY to .env (free at tavily.com) to enable it.');
  }
  if (!config.obsidian?.vaultPath?.trim()) {
    console.log('[notes] Obsidian tools are dormant — set obsidian.vaultPath in config.json (forward slashes) to enable them.');
  }
  console.log(`Loading the Kokoro voice (first run downloads ~90 MB, then it's instant)...`);
  warmUp()
    .then(() => console.log(`${NAME} is awake and can speak. Open the page and hold Space to talk.\n`))
    .catch((err) => {
      logSystemError(`Kokoro voice failed to load: ${err.message}`);
      console.error(`Voice failed to load: ${err.message}\nTyped chat on the page still works.\n`);
    });
  startHeartbeat(); // Tier 5: Legacy can now notice things on its own
});

// One look, once, at whether every agent really has what it was given.
setTimeout(() => { try { preflight(); } catch { /* never block boot */ } }, 1500);
setTimeout(() => { import('./preflight.js').then((m) => m.checkContracts()).catch(() => {}); }, 2500);
