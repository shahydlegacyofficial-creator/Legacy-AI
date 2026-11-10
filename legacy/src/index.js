/**
 * Legacy — Tier 1: the brain.
 *
 * A text conversation loop:
 *   read input -> append to history -> send history + system prompt to the
 *   brain -> stream the reply to the screen -> append reply -> wait for input.
 *
 * History lives only in memory. Restarting forgets everything — that's
 * expected until Tier 4. Run with:  npm start   (uses --env-file=.env)
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout, exit } from 'node:process';
import { explainError } from './brain.js';
import { buildStablePrompt, buildDynamicContext } from './systemPrompt.js';
import { runTurn } from './agent.js';
import './tools/all.js';
import { preflight } from './preflight.js'; // every tool, one list — see the note in that file
import { formatForPrompt } from './memory.js';
import { noticesForPrompt, listPending } from './notices.js';
import { listPendingActions, decideAction } from './gate.js';
import { resetCards, takeCards } from './cards.js';
import { config } from './config.js';

const NAME = config.assistant.name;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    `\n${NAME} needs an API key.\n` +
    `Copy .env.example to .env, add your ANTHROPIC_API_KEY, then run: npm start\n`
  );
  exit(1);
}

// The prompt is rebuilt every turn so newly remembered facts and fresh
// notices apply immediately.
const STABLE_PROMPT = buildStablePrompt(config);
const getSystemPrompt = () => ({ stable: STABLE_PROMPT, dynamic: buildDynamicContext(formatForPrompt() + noticesForPrompt()) });

/** The running conversation — Tier 1's short-term memory. */
const history = [];

const rl = createInterface({ input: stdin, output: stdout });

console.log(`\n${NAME} is awake. Type to talk; "exit" to quit.`);

// Catch-up-on-return: anything noticed while this window was closed is shown
// now, not lost. (The heartbeat itself runs in voice mode — `npm run voice`.)
const pendingOnStart = listPending();
if (pendingOnStart.length > 0) {
  console.log(`\nWhile you were away, ${NAME} noticed:`);
  for (const n of pendingOnStart) console.log(`  • #${n.id} ${n.message}`);
}
console.log('');

/** Ask Shahyd directly — the terminal's human-only confirmation channel. */
async function confirmPendingActions() {
  for (const action of listPendingActions()) {
    const answer = (
      await rl.question(`\n⚠ ${NAME} wants to: ${action.summary}\n  Approve? (yes/no) › `)
    ).trim().toLowerCase();
    const approve = answer === 'yes' || answer === 'y';
    const result = await decideAction(action.id, approve);
    console.log(`  ${result.message}\n`);
  }
}

while (true) {
  const input = (await rl.question('you › ')).trim();

  if (!input) continue;
  if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
    console.log(`\n${NAME}: talk soon 👋\n`);
    rl.close();
    exit(0);
  }

  resetCards();
  const turnStart = history.length; // so a failed turn can be rolled back cleanly
  history.push({ role: 'user', content: input });

  stdout.write(`${NAME.toLowerCase()} › `);

  try {
    await runTurn({
      systemPrompt: getSystemPrompt(),
      history,
      onText: (chunk) => stdout.write(chunk), // streaming: the reply appears as it's thought
      onToolUse: (name) => stdout.write(`\n  (using ${name}…)\n${NAME.toLowerCase()} › `),
    });
    stdout.write('\n\n');
    for (const c of takeCards()) console.log(`  [${c.kind}] ${c.title}: ${c.value ?? c.subtitle ?? ''}`);
    await confirmPendingActions(); // anything held this turn gets a direct yes/no
  } catch (err) {
    // The turn failed partway (maybe mid-tool-loop); roll history back to the
    // start of the turn so the conversation stays consistent, then move on.
    history.length = turnStart;
    stdout.write(`(${explainError(err)})\n\n`);
  }
}

setTimeout(() => { try { preflight(); } catch {} }, 1200);
