/**
 * File drop — Roadmap 5 #11.
 *
 * Shahyd drops files (paperclip or drag anywhere), then tells Legacy what to
 * do with them: "save all this to my second brain", "build the app in that
 * roadmap", "turn this into a promo". Two halves:
 *
 *   handleFileDrop()  — runs on upload: saves each file into the workspace
 *                       (Dropped/YYYY-MM-DD/) and EXTRACTS its text now.
 *   takePendingDrop() — server.js calls this on the next turn; the extracted
 *                       content wraps Shahyd's command, then the staging
 *                       clears. Consumed exactly once.
 *
 * Extraction is honest about what it can read:
 *   - text family (txt/md/csv/json/code/…) — read directly, no dependencies
 *   - PDF — via pdf-parse, imported LAZILY so a missing package can never
 *     stop Legacy booting; if it's absent she says so plainly
 *   - DOCX — unzipped with Node's own zlib (no dependency) and stripped
 *   - images — handed to the vision path as the turn's image, so Legacy
 *     actually LOOKS at them rather than guessing from a filename
 *   - anything else — filed and named, with an honest "I can't read inside"
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, basename, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { config } from './config.js';
import { appendAudit } from './audit.js';

const MAX_FILE_BYTES = 12 * 1024 * 1024;   // per file
const MAX_TEXT_CHARS = 30_000;             // per file, into the turn
const MAX_TOTAL_CHARS = 90_000;            // across the whole drop

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yml', '.yaml',
  '.js', '.mjs', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h',
  '.cpp', '.cs', '.php', '.sh', '.sql', '.html', '.htm', '.css', '.xml', '.srt', '.vtt', '.ini', '.env',
]);
const IMAGE_MEDIA = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

const clean = (s) => String(s ?? '').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const kb = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** DOCX is a zip; the text lives in word/document.xml. Read it with zlib alone. */
function docxText(buf) {
  const entries = [];
  // Walk local file headers (PK\x03\x04) — enough for the one entry we want.
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    if (name === 'word/document.xml' && compSize > 0) {
      const raw = buf.slice(start, start + compSize);
      entries.push(method === 8 ? inflateRawSync(raw) : raw);
      break;
    }
  }
  if (!entries.length) throw new Error('no document.xml inside');
  const xml = entries[0].toString('utf8');
  return clean(xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<[^>]+>/g, ''));
}

async function pdfText(buf) {
  // Goes through docs.js so pdf.js's harmless font chatter ("TT: undefined
  // function: 21") stays out of Shahyd's terminal, and so a scanned PDF gets
  // the same honest answer here as it does from read_document.
  const { quietPdfParse, readPdf } = await import('./docs.js');
  const good = await quietPdfParse(buf);
  if (good && (good.text.match(/[A-Za-z]/g) || []).length >= 40) return clean(good.text);
  const fallback = readPdf(buf);
  if (fallback.error) throw new Error(fallback.error);
  return clean(fallback.text);
}

let pending = null; // { summaryLines[], blocks[], image }

/**
 * Called by POST /file-drop. Returns { staged, lines } for the UI card.
 */
export async function handleFileDrop(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('No files arrived.');
  const root = config.workspace?.root?.trim();
  const day = new Date().toISOString().slice(0, 10);
  const dir = root ? resolve(root, 'Dropped', day) : null;
  if (dir) {
    if (!dir.startsWith(resolve(root) + sep)) throw new Error('Invalid workspace path.');
    mkdirSync(dir, { recursive: true });
  }

  const summaryLines = [];
  const blocks = [];
  let image = null;
  let totalChars = 0;

  for (const f of files.slice(0, 12)) {
    const name = basename(String(f?.name ?? 'file')).slice(0, 120);
    const ext = extname(name).toLowerCase();
    let buf;
    try { buf = Buffer.from(String(f?.data64 ?? ''), 'base64'); }
    catch { summaryLines.push(`• ${name} — couldn't decode that upload`); continue; }
    if (!buf.length) { summaryLines.push(`• ${name} — arrived empty`); continue; }
    if (buf.length > MAX_FILE_BYTES) { summaryLines.push(`• ${name} (${kb(buf.length)}) — too big, skipped (limit ${kb(MAX_FILE_BYTES)})`); continue; }

    // Keep the original in the workspace so nothing is lost after the turn.
    let savedAt = null;
    if (dir) {
      try { const p = join(dir, name); writeFileSync(p, buf); savedAt = join('Dropped', day, name); }
      catch { /* saving is a bonus; extraction still proceeds */ }
    }

    try {
      if (IMAGE_MEDIA[ext]) {
        if (!image) image = { b64: buf.toString('base64'), mediaType: IMAGE_MEDIA[ext] };
        summaryLines.push(`• ${name} (${kb(buf.length)}) — image, I'm looking at it${savedAt ? ` · saved ${savedAt}` : ''}`);
        continue;
      }
      let text = null, kind = null;
      if (ext === '.pdf') { text = await pdfText(buf); kind = 'PDF'; }
      else if (ext === '.docx') { text = docxText(buf); kind = 'Word document'; }
      else if (TEXT_EXT.has(ext) || !ext) { text = clean(buf.toString('utf8')); kind = ext.replace('.', '') || 'text'; }
      else {
        summaryLines.push(`• ${name} (${kb(buf.length)}) — filed, but I can't read inside a ${ext || 'file'} like this${savedAt ? ` · saved ${savedAt}` : ''}`);
        continue;
      }
      if (!text) {
        summaryLines.push(`• ${name} — no readable text found (a scanned page has no text layer)`);
        continue;
      }
      const room = Math.max(0, MAX_TOTAL_CHARS - totalChars);
      const slice = text.slice(0, Math.min(MAX_TEXT_CHARS, room));
      totalChars += slice.length;
      const trimmed = slice.length < text.length;
      summaryLines.push(`• ${name} (${kb(buf.length)}) — ${kind}, ${text.length.toLocaleString()} chars read${trimmed ? ' (trimmed)' : ''}${savedAt ? ` · saved ${savedAt}` : ''}`);
      if (slice) blocks.push(`--- ${name} ---\n${slice}${trimmed ? '\n…[trimmed]' : ''}`);
    } catch (e) {
      summaryLines.push(`• ${name} — couldn't read it: ${e.message}`);
    }
  }

  if (!summaryLines.length) throw new Error('None of those files could be handled.');
  pending = { summaryLines, blocks, image, at: Date.now() };
  appendAudit('files_dropped', { count: files.length, chars: totalChars, image: Boolean(image) });
  return { staged: summaryLines.length, lines: summaryLines };
}

/** server.js: pull the staged drop into the next turn, exactly once. */
export function takePendingDrop() {
  if (!pending) return null;
  // A drop older than 30 minutes is stale — Shahyd moved on.
  if (Date.now() - pending.at > 30 * 60_000) { pending = null; return null; }
  const out = pending;
  pending = null;
  return out;
}

export function peekPendingDrop() { return pending; }
