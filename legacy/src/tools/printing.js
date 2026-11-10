/**
 * Printing — Roadmap 3 #23.
 *
 * Sends a file from the workspace to the PC's default printer and shows a
 * "printing in progress" card on the UI. Uses the OS print path:
 *   - Windows: PowerShell Start-Process -Verb Print
 *   - macOS/Linux: lp
 * Only files inside the workspace can be printed (same sandbox as the file
 * tools). Printing is a physical action, so it is GATED for Shahyd's approval.
 * Dormant unless the workspace is set.
 */
import { resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { exec } from 'node:child_process';
import { registerTool } from './registry.js';
import { pushCard } from '../cards.js';
import { config } from '../config.js';

const WORKSPACE_CONFIGURED = Boolean(config.workspace?.root?.trim());

function safeWorkspacePath(rel) {
  const root = resolve(config.workspace.root.trim());
  const full = resolve(root, rel.trim());
  if (full !== root && !full.startsWith(root + sep)) throw new Error('That file is outside your workspace.');
  return full;
}

function printCommand(fullPath) {
  const p = platform();
  if (p === 'win32') {
    // PowerShell verb-print via the associated app; falls back gracefully.
    return `powershell -NoProfile -Command "Start-Process -FilePath '${fullPath.replace(/'/g, "''")}' -Verb Print"`;
  }
  return `lp ${JSON.stringify(fullPath)}`; // macOS/Linux (CUPS)
}

if (WORKSPACE_CONFIGURED) {
  registerTool({
    name: 'print_document',
    requiresConfirmation: true, // physical output — held for approval
    describeAction: (input) => `Print "${input?.file}" from the workspace to the default printer.`,
    description:
      "Send a file from Shahyd's workspace to his default printer. Shows a " +
      '"printing in progress" card. Physical action, so it is held for his ' +
      'approval. Give the file path within the workspace (e.g. ' +
      '"Proposals/ocean-films.html" or a PDF).',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'File path within the workspace to print.' } },
      required: ['file'],
    },
    handler: ({ file }) => {
      if (!file?.trim()) throw new Error('Which file should I print?');
      const full = safeWorkspacePath(file);
      if (!existsSync(full)) throw new Error(`No file at "${file}" in your workspace.`);

      pushCard({ kind: 'status', title: 'Printing in progress', value: file.trim(), subtitle: 'Sent to your default printer' });

      exec(printCommand(full), (err) => {
        if (err) console.log(`[print] failed for ${full}: ${err.message}`);
      });
      return `Sending "${file.trim()}" to your printer now — a printing card is on screen. If nothing prints, check that a default printer is set on the PC.`;
    },
  });
} else {
  console.log('[print] dormant — set workspace.root in config.json to enable printing from the workspace.');
}
