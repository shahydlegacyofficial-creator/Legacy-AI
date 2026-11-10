/**
 * Workspace file tools — Roadmap 2 #7: total PC control, done safely.
 *
 * Legacy can create folders and save documents, research, and images — but
 * ONLY inside ONE folder it owns: the workspace, set in config.json
 * ("workspace" -> "root"). Every path is resolved and checked to stay INSIDE
 * that root, exactly like the Obsidian vault guard, so Legacy can organize
 * its own workspace freely while the rest of the PC is untouchable.
 *
 * This is the same permission philosophy as the app whitelist: the sandbox
 * IS the permission system, and Shahyd owns its boundary. Writing and folder
 * creation flow freely inside the workspace; DELETING is destructive and
 * held for Shahyd's approval through the confirmation gate.
 *
 * Dormant until workspace.root is set — with no root, none of these tools
 * register, and nothing about files can error or distract.
 */

import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { registerTool } from './registry.js';
import { config } from '../config.js';

const WORKSPACE_CONFIGURED = Boolean(config.workspace?.root?.trim());
const MAX_TEXT_CHARS = 500_000;

function workspaceRoot() {
  const p = config.workspace?.root?.trim();
  if (!p) {
    throw new Error(
      'The workspace folder is not set. Open config.json and put a folder path ' +
        'in "workspace" -> "root" (forward slashes, e.g. "C:/Users/Shahyd/LegacyWorkspace"), then restart.'
    );
  }
  const root = resolve(p);
  mkdirSync(root, { recursive: true }); // create the workspace itself if missing
  return root;
}

/** Resolve a relative path and REFUSE anything that escapes the workspace. */
function safePath(root, rel) {
  if (!rel?.trim()) throw new Error('A path is required.');
  const full = resolve(root, rel.trim());
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('That path points outside your workspace, which is not allowed.');
  }
  return full;
}

const isImageData = (s) => /^data:image\/(png|jpe?g|gif|webp);base64,/.test(s ?? '');

if (WORKSPACE_CONFIGURED) {
  registerTool({
    name: 'create_folder',
    description:
      "Create a folder in Shahyd's Legacy workspace (his files sandbox). Give a " +
      'path like "Clients/Ocean Films" or "Research/2026"; parent folders are ' +
      'made as needed. Use to organize his documents, research, and images.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Folder path within the workspace.' } },
      required: ['path'],
    },
    handler: ({ path }) => {
      const root = workspaceRoot();
      const full = safePath(root, path);
      mkdirSync(full, { recursive: true });
      return `Created folder: ${relative(root, full) || '.'} (in your workspace).`;
    },
  });

  registerTool({
    name: 'save_file',
    description:
      "Save a text document into Shahyd's Legacy workspace — research write-ups, " +
      'notes, drafts, plans, code, CSV, anything text. Give a path with a file ' +
      'name and extension (e.g. "Research/ocean-studios.md"); folders are created ' +
      'as needed. Use show_card afterwards is not needed — just report the path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path within the workspace, incl. name and extension.' },
        content: { type: 'string', description: 'The text content to write.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing file. Default false.' },
      },
      required: ['path', 'content'],
    },
    handler: ({ path, content, overwrite = false }) => {
      if (content == null) throw new Error('There is no content to save.');
      if (content.length > MAX_TEXT_CHARS) throw new Error(`That file is too large (over ${MAX_TEXT_CHARS} characters).`);
      const root = workspaceRoot();
      const full = safePath(root, path);
      if (existsSync(full) && !overwrite) {
        throw new Error(`"${relative(root, full)}" already exists. Set overwrite true to replace it, or pick another name.`);
      }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return `Saved: ${relative(root, full)} (${content.length.toLocaleString()} characters) in your workspace.`;
    },
  });

  registerTool({
    name: 'save_image',
    description:
      "Save an image into Shahyd's Legacy workspace from a base64 data URL " +
      '(e.g. one produced by an image tool). Give a path ending in .png/.jpg. ' +
      'Folders are created as needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Image file path within the workspace (.png/.jpg/.webp).' },
        data_url: { type: 'string', description: 'A data:image/...;base64,... string.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing file. Default false.' },
      },
      required: ['path', 'data_url'],
    },
    handler: ({ path, data_url, overwrite = false }) => {
      if (!isImageData(data_url)) throw new Error('That is not a valid image data URL (expected data:image/png;base64,...).');
      const root = workspaceRoot();
      const full = safePath(root, path);
      if (existsSync(full) && !overwrite) {
        throw new Error(`"${relative(root, full)}" already exists. Set overwrite true to replace it.`);
      }
      mkdirSync(dirname(full), { recursive: true });
      const b64 = data_url.slice(data_url.indexOf(',') + 1);
      writeFileSync(full, Buffer.from(b64, 'base64'));
      return `Saved image: ${relative(root, full)} in your workspace.`;
    },
  });

  registerTool({
    name: 'list_workspace',
    description:
      "List what's in Shahyd's Legacy workspace, or a subfolder of it. Use to " +
      'see what has been saved before organizing or referring to files.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Optional subfolder; omit for the workspace root.' } },
    },
    handler: ({ path }) => {
      const root = workspaceRoot();
      const dir = path?.trim() ? safePath(root, path) : root;
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`No such folder: ${path ?? '.'}`);
      const entries = readdirSync(dir).map((name) => {
        const st = statSync(join(dir, name));
        return st.isDirectory() ? `${name}/` : `${name} (${st.size.toLocaleString()} bytes)`;
      });
      const here = relative(root, dir) || 'workspace root';
      return entries.length ? `In ${here}:\n${entries.map((e) => `• ${e}`).join('\n')}` : `${here} is empty.`;
    },
  });

  registerTool({
    name: 'delete_path',
    requiresConfirmation: true, // destructive — always held for Shahyd
    describeAction: (input) => `Delete "${input?.path}" from the Legacy workspace — this removes the file or folder (and its contents).`,
    description:
      "Delete a file or folder from Shahyd's Legacy workspace by path. This is " +
      'destructive, so it is HELD for his approval before anything is removed. ' +
      'Only affects the workspace, never the rest of the PC.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'The file or folder to delete, within the workspace.' } },
      required: ['path'],
    },
    handler: ({ path }) => {
      const root = workspaceRoot();
      const full = safePath(root, path);
      if (full === root) throw new Error('I won\'t delete the whole workspace. Name a file or subfolder.');
      if (!existsSync(full)) throw new Error(`Nothing at "${path}" to delete.`);
      rmSync(full, { recursive: true, force: true });
      return `Deleted ${relative(root, full)} from your workspace.`;
    },
  });
} else {
  console.log('[files] workspace tools dormant — set workspace.root in config.json to let Legacy save files, folders, research, and images.');
}
