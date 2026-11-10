/**
 * read_document (v1.51) — open what Shahyd drops in the workspace.
 *
 * Deliberately one tool for every kind of document rather than one per format.
 * He says "read the contract"; which parser that needs is Legacy's problem,
 * not his.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, sep, extname, basename } from 'node:path';
import { config } from '../config.js';
import { registerTool } from './registry.js';
import { readDocx, readPdf, readPlain, quietPdfParse } from '../docs.js';

const TEXTY = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.rtf', '.html', '.htm', '.xml', '.srt', '.vtt']);

function workspaceRoot() {
  const p = config.workspace?.root?.trim();
  if (!p) throw new Error('The workspace folder is not set — put a path in config.json under workspace -> root.');
  return resolve(p);
}
function safePath(root, rel) {
  if (!rel?.trim()) throw new Error('Which file?');
  const full = resolve(root, rel.trim());
  if (full !== root && !full.startsWith(root + sep)) throw new Error('That path is outside your workspace.');
  return full;
}

registerTool({
  name: 'read_document',
  description:
    'Open and read a document in the workspace — Word (.docx), PDF, or any ' +
    'text file (.txt, .md, .csv, .json, .srt). Use whenever Shahyd asks her ' +
    'to read, check, summarise or pull something out of a file: a contract, a ' +
    'brief, a quote, a rider, a script, lyrics, a transcript. If he asks about ' +
    "a document at all, read it first rather than asking him what is in it.",
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path inside the workspace, e.g. "contracts/ifilms-party-score.docx".' },
      find: { type: 'string', description: 'Optional: only return the parts mentioning this, for a long document.' },
    },
    required: ['file'],
  },
  handler: async ({ file, find }) => {
    const root = workspaceRoot();
    const full = safePath(root, file);
    if (!existsSync(full)) return `I cannot find "${file}" in your workspace.`;
    if (statSync(full).isDirectory()) return `"${file}" is a folder, not a document.`;
    const size = statSync(full).size;
    if (size > 60 * 1024 * 1024) return 'That file is over 60 MB — too big for me to read in one go.';

    const ext = extname(full).toLowerCase();
    const buf = readFileSync(full);

    let r;
    if (ext === '.docx') r = readDocx(buf);
    else if (ext === '.pdf') {
      // pdf-parse decodes embedded fonts the built-in reader cannot, so try it
      // first; fall back so a missing package never costs him the document.
      const good = await quietPdfParse(buf);
      const letters = good ? (good.text.match(/[A-Za-z]/g) || []).length : 0;
      r = good && letters >= 40
        ? { text: good.text, kind: 'PDF', pageCount: good.pages }
        : readPdf(buf);
    }
    else if (TEXTY.has(ext) || !ext) r = readPlain(buf);
    else if (ext === '.doc') {
      return 'That is an old-format .doc file, which I cannot read. Open it in Word and ' +
        '"Save as" .docx, and I will read it straight away.';
    } else if (ext === '.pages' || ext === '.odt') {
      return `I cannot read ${ext} files. Export it as .docx or PDF and I will read it.`;
    } else {
      r = readPlain(buf);
      if (r.error) return `I do not know how to read ${ext} files. I can read Word, PDF, and text files.`;
    }

    if (r.error) return r.error;

    let text = r.text;
    let note = '';

    // A "find" turns a 40-page contract into the paragraph he actually asked
    // about, which is usually what he wanted.
    if (find?.trim()) {
      const needle = find.trim().toLowerCase();
      const paras = text.split(/\n{2,}|\n(?=\s*\d+[\.\)]\s)/);
      const hits = paras.filter((p) => p.toLowerCase().includes(needle));
      if (!hits.length) {
        return `I read ${basename(full)} (${r.kind}${r.pageCount ? `, ${r.pageCount} pages` : ''}) and found nothing mentioning "${find}". ` +
          `It is ${text.length.toLocaleString('en-US')} characters long — ask me for the whole thing if you want me to go through it.`;
      }
      text = hits.join('\n\n');
      note = ` — the ${hits.length} part${hits.length === 1 ? '' : 's'} mentioning "${find}"`;
    }

    // Cap what comes back so one enormous file cannot swamp the turn.
    const CAP = 24_000;
    let trimmed = false;
    if (text.length > CAP) { text = text.slice(0, CAP); trimmed = true; }

    return `${basename(full)} (${r.kind}${r.pageCount ? `, ${r.pageCount} pages` : ''})${note}:\n\n${text}` +
      (trimmed ? `\n\n[...that is the first ${CAP.toLocaleString('en-US')} characters. Ask me to look for something specific and I will find just that part.]` : '');
  },
});
