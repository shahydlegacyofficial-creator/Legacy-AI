/**
 * PayPal — Roadmap 2 #1: notify when a payment arrives.
 *
 * Uses PayPal's REST API (Transaction Search) with a read-only client id +
 * secret — no webhooks, no public URL needed, so it works on a home PC:
 *   1. developer.paypal.com -> Apps & Credentials -> create an app (Live)
 *   2. copy the Client ID and Secret into .env:
 *        PAYPAL_CLIENT_ID=...   PAYPAL_SECRET=...
 *      (optional) PAYPAL_ENV=live   (default; use "sandbox" to test)
 *   3. In your PayPal account, enable "Transaction Search" for the app.
 *
 * The heartbeat polls for completed incoming payments since the last check
 * and surfaces each as a notice. If a payment amount matches an unpaid
 * invoice in the studio ledger, Legacy notes the match so reconciling is
 * one step. Read-only: Legacy never moves money.
 */
import { readFileSync } from 'node:fs';
import { registerTool } from './registry.js';

export const paypalConfigured = () =>
  Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);

const BASE = () =>
  (process.env.PAYPAL_ENV === 'sandbox')
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

let token = { value: null, exp: 0 };
async function accessToken() {
  if (token.value && Date.now() < token.exp) return token.value;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${BASE()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`PayPal auth ${r.status}: ${(await r.text()).slice(0, 140)}`);
  const d = await r.json();
  token = { value: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return token.value;
}

/** Completed incoming payments in a window. Read-only Transaction Search. */
export async function recentPayments({ sinceISO } = {}) {
  const start = sinceISO ?? new Date(Date.now() - 24 * 3600e3).toISOString();
  const end = new Date().toISOString();
  const tok = await accessToken();
  const url = new URL(`${BASE()}/v1/reporting/transactions`);
  url.search = new URLSearchParams({
    start_date: start, end_date: end,
    fields: 'transaction_info,payer_info', page_size: '100',
    transaction_status: 'S', // success
  }).toString();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`PayPal transactions ${r.status}: ${(await r.text()).slice(0, 140)}`);
  const d = await r.json();
  return (d.transaction_details ?? [])
    .map((t) => {
      const info = t.transaction_info ?? {};
      const amt = Number(info.transaction_amount?.value ?? 0);
      if (amt <= 0) return null; // ignore outgoing/zero
      return {
        id: info.transaction_id,
        amount: amt,
        currency: info.transaction_amount?.currency_code ?? '',
        date: info.transaction_initiation_date ?? null,
        payer: t.payer_info?.payer_name?.alternate_full_name
          || t.payer_info?.email_address || 'a payer',
      };
    })
    .filter(Boolean);
}

/** Does this amount match an unpaid invoice? (studio ledger is MVR.) */
export function matchInvoice(amount, currency) {
  try {
    const studio = JSON.parse(readFileSync(new URL('../../data/studio.json', import.meta.url), 'utf8'));
    const usdRate = studio.usdRate ?? 15.42;
    const mvr = currency === 'USD' ? amount * usdRate : amount;
    return (studio.invoices ?? []).find(
      (i) => !i.paid && Math.abs(i.total - mvr) < Math.max(1, i.total * 0.01)
    ) ?? null;
  } catch { return null; }
}

if (paypalConfigured()) {
  registerTool({
    name: 'check_payments',
    description:
      "Check Shahyd's PayPal for recent incoming payments (read-only). Use when " +
      'he asks whether a payment came in. Pair with show_card to put an amount ' +
      'on screen. If a payment matches an unpaid invoice, say so.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'Look back this many days (default 7, max 31).' } },
    },
    handler: async ({ days }) => {
      const back = Math.min(Math.max(days ?? 7, 1), 31);
      const since = new Date(Date.now() - back * 24 * 3600e3).toISOString();
      const pays = await recentPayments({ sinceISO: since });
      if (!pays.length) return `No incoming PayPal payments in the last ${back} days.`;
      return pays.map((p) => {
        const inv = matchInvoice(p.amount, p.currency);
        return `• ${p.currency} ${p.amount.toLocaleString()} from ${p.payer}${p.date ? ` (${new Date(p.date).toLocaleDateString('en-GB')})` : ''}${inv ? ` — matches unpaid invoice ${inv.number}` : ''}`;
      }).join('\n');
    },
  });
} else {
  console.log('[paypal] dormant — add PAYPAL_CLIENT_ID and PAYPAL_SECRET to .env to enable payment notifications.');
}
