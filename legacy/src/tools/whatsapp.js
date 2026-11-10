/**
 * WhatsApp, the cheap way (v1.52).
 *
 * Most of Shahyd's clients reach him on WhatsApp. The Business API was refused
 * before and stays refused, for a reason that has not changed: it needs a Meta
 * Business account, a separate WhatsApp Business Account, a dedicated number
 * that is NOT the one already on his phone, and template pre-approval for
 * anything sent outside a 24-hour window. That is exactly the class of setup
 * he has killed features over.
 *
 * This gets most of the value for none of it. WhatsApp's own wa.me links open
 * a chat with the message already typed — so Legacy drafts, and he taps send.
 * No API, no account, no approval queue, and the same shape as everything else
 * she does with money and messages: she prepares, he sends.
 *
 * Incoming is already solved: the Phone Link forwards WhatsApp notifications,
 * so she can already tell him a client wrote.
 */
import { config } from '../config.js';
import { registerTool } from './registry.js';
import { appendAudit } from '../audit.js';

/** WhatsApp wants digits only, full international, no + and no spaces. */
export function normaliseNumber(raw, defaultCode = '960') {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  const hadPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;
  s = s.replace(/^0+/, '');            // local trunk prefix
  // A bare Maldivian 7-digit number needs the country code putting back.
  if (!hadPlus && s.length <= 8 && defaultCode) s = defaultCode + s;
  return s.length >= 7 && s.length <= 15 ? s : null;
}

export function waLink(number, text) {
  const n = normaliseNumber(number, config.whatsapp?.defaultCountryCode ?? '960');
  if (!n) return null;
  const q = text?.trim() ? `?text=${encodeURIComponent(text.trim())}` : '';
  return `https://wa.me/${n}${q}`;
}

registerTool({
  name: 'whatsapp_message',
  description:
    'Draft a WhatsApp message to a client and open the chat with it already ' +
    'typed, ready for Shahyd to read and send. Use whenever he wants to reply ' +
    'to or message someone on WhatsApp — a client, a booking, a quote follow-up. ' +
    'She writes it; he presses send. She cannot and does not send WhatsApp ' +
    'messages herself.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Phone number. Maldivian local numbers are fine; add + and the code for anywhere else.' },
      name: { type: 'string', description: "Who it is for, if known — used only to tell him whose chat is opening." },
      message: { type: 'string', description: 'The full message, written the way Shahyd would write it.' },
      open: { type: 'boolean', description: 'Open the chat on his PC now. Default true.' },
    },
    required: ['to', 'message'],
  },
  handler: async ({ to, name, message, open = true }) => {
    if (!message?.trim()) return 'What should the message say?';
    const link = waLink(to, message);
    if (!link) {
      return `"${to}" does not look like a phone number I can use. Give me the number ` +
        'with its country code, like +960 797 8580.';
    }
    const who = name?.trim() ? name.trim() : to;

    let opened = false, why = '';
    if (open) {
      try {
        const { openOnPC } = await import('./pc.js');
        await openOnPC({ type: 'url', target: link });
        opened = true;
      } catch (e) { why = e.message; }
    }
    appendAudit('whatsapp_drafted', { to: normaliseNumber(to), name: name ?? null, opened });

    const preview = message.trim().length > 220 ? message.trim().slice(0, 220) + '…' : message.trim();
    return [
      opened
        ? `WhatsApp is opening for ${who} with this ready to send:`
        : `Here is the message for ${who}${why ? ` (I could not open the chat: ${why})` : ''}:`,
      '',
      preview,
      '',
      opened
        ? 'Read it over and press send — I cannot send it for you.'
        : `Open this to send it: ${link}`,
    ].join('\n');
  },
});

registerTool({
  name: 'whatsapp_link',
  description:
    'Make a WhatsApp link for a number without opening anything — for putting ' +
    'in a quote, an invoice, an email signature, or a website "message us" ' +
    'button. Use when Shahyd asks for a WhatsApp link or click-to-chat button.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'The number. Defaults to the Travel Essence line if left out.' },
      message: { type: 'string', description: 'Optional text pre-filled for whoever clicks it.' },
    },
  },
  handler: ({ to, message }) => {
    const number = to?.trim() || config.whatsapp?.businessNumber || '';
    if (!number) return 'Which number should the link go to? I can remember a default in config.json under whatsapp -> businessNumber.';
    const link = waLink(number, message);
    if (!link) return `"${number}" does not look like a phone number I can build a link from.`;
    return `${link}\n\nAnyone who taps that opens a WhatsApp chat with you${message?.trim() ? ', with that message already typed' : ''}.`;
  },
});
