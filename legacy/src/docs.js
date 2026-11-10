/**
 * Reading documents — Word, PDF, plain text (v1.51).
 *
 * Legacy could write files and list them and delete them, and could not read a
 * single one. Contracts, briefs and quotes arrive as .docx and .pdf, so that
 * was the gap that mattered.
 *
 * No dependencies. A .docx is a zip of XML and Node can already inflate; a PDF
 * hides its text in compressed content streams and the operators are readable
 * once you know where to look.
 *
 * WHAT THIS HONESTLY CANNOT DO: a scanned contract is a photograph of words,
 * not words. There is no text in it to find. Rather than hand back silence or
 * mojibake and let Shahyd think he has been read the terms, it says plainly
 * that the file looks like a scan and needs OCR.
 */
import { inflateRawSync, inflateSync } from 'node:zlib';

/* --------------------------------- zip --------------------------------- */
/** Minimal reader: enough of the spec to pull one named entry out of a zip. */
function zipEntries(buf) {
  // The end-of-central-directory record sits at the end, after an optional
  // comment, so it has to be found by scanning backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let i = 0; i < count && pos + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localAt = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.set(name, { method, compSize, localAt });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  const at = e.localAt;
  if (buf.readUInt32LE(at) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const start = at + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  try {
    if (e.method === 0) return raw;                 // stored
    if (e.method === 8) return inflateRawSync(raw); // deflate
  } catch { return null; }
  return null;
}

/* --------------------------------- docx --------------------------------- */
const unxml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

export function readDocx(buf) {
  const entries = zipEntries(buf);
  if (!entries) return { error: 'That does not look like a Word file — I could not read its structure.' };
  const doc = zipRead(buf, entries, 'word/document.xml');
  if (!doc) return { error: 'That Word file has no readable document inside it.' };
  const xml = doc.toString('utf8');

  // Paragraphs and line breaks become real breaks; runs of text join up.
  let text = xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ');
  const parts = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|(\n)|(\t)|( \| )/g;
  let m;
  while ((m = re.exec(text))) parts.push(m[1] != null ? unxml(m[1]) : (m[2] ?? m[3] ?? m[4]));
  const out = parts.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out ? { text: out, kind: 'Word document' } : { error: 'That Word file appears to have no text in it.' };
}

/* ---------------------------------- pdf ---------------------------------- */
/** Undo PDF string escapes: \( \) \\ \n \t and octal \101. */
function pdfString(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => {
    const simple = { n: '\n', r: '\n', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' };
    if (simple[c] !== undefined) return simple[c];
    const code = parseInt(c, 8);
    return code >= 32 && code < 127 ? String.fromCharCode(code) : '';
  });
}

function pdfHex(h) {
  const clean = h.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const code = parseInt(clean.slice(i, i + 2), 16);
    if (code >= 32 && code < 127) out += String.fromCharCode(code);
  }
  return out;
}

/** Pull readable text out of one decompressed content stream. */
function pdfContentText(content) {
  const out = [];
  // Text-showing operators: (str) Tj / (str) ' / [(a) 5 (b)] TJ / <hex> Tj
  const re = /\((?:\\.|[^\\()])*\)\s*(?:Tj|'|")|\[[^\]]*\]\s*TJ|<[0-9A-Fa-f\s]+>\s*Tj|\bT\*|\bTd\b|\bTD\b|\bET\b/g;
  let m;
  while ((m = re.exec(content))) {
    const tok = m[0];
    if (/^(T\*|Td|TD|ET)$/.test(tok.trim())) { out.push('\n'); continue; }
    if (tok.startsWith('[')) {
      const inner = tok.slice(0, tok.lastIndexOf(']'));
      let s = '';
      const sre = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|-?\d+(?:\.\d+)?/g;
      let sm;
      while ((sm = sre.exec(inner))) {
        const t = sm[0];
        if (t.startsWith('(')) s += pdfString(t.slice(1, -1));
        else if (t.startsWith('<')) s += pdfHex(t.slice(1, -1));
        else if (Number(t) < -180) s += ' ';   // a big kern is a word gap
      }
      out.push(s);
    } else if (tok.startsWith('<')) {
      out.push(pdfHex(tok.slice(1, tok.indexOf('>'))));
    } else {
      out.push(pdfString(tok.slice(1, tok.lastIndexOf(')'))));
    }
  }
  return out.join('');
}

export function readPdf(buf) {
  const raw = buf.toString('latin1');
  if (!raw.startsWith('%PDF')) return { error: 'That does not look like a PDF.' };

  const pageCount = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length || null;
  const chunks = [];

  // Walk every stream; inflate the compressed ones, keep the plain ones.
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    const slice = buf.subarray(start, end);
    let content = null;
    try { content = inflateSync(slice).toString('latin1'); }
    catch {
      try { content = inflateRawSync(slice).toString('latin1'); }
      catch {
        const s = slice.toString('latin1');
        if (/\bTj\b|\bTJ\b/.test(s)) content = s;   // uncompressed content stream
      }
    }
    if (content && /\bTj\b|\bTJ\b/.test(content)) chunks.push(pdfContentText(content));
    re.lastIndex = end;
  }

  let text = chunks.join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Is what came back actually words? A scanned page yields nothing; a PDF
  // with custom font encodings yields symbol soup. Both must be admitted to.
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const readable = text.length ? letters / text.length : 0;

  if (!text || letters < 40) {
    return {
      error: 'I could not find any text in that PDF. It is almost certainly a scan — ' +
        'a photograph of the pages rather than words — and reading it would need OCR, ' +
        'which I cannot do. If you can get a text version, or type me the clause you ' +
        'care about, I can work with that.',
      pageCount,
    };
  }
  if (readable < 0.45) {
    return {
      error: 'That PDF has text in it but it comes out as gibberish — it uses embedded ' +
        'fonts with a custom encoding, which I cannot decode. Try "Save as" or export ' +
        'to Word from your PDF reader, and I will read that.',
      pageCount,
    };
  }
  return { text, kind: 'PDF', pageCount };
}

/* ------------------------------ plain text ------------------------------ */
export function readPlain(buf) {
  const text = buf.toString('utf8');
  // A quick sanity check that this really is text and not a binary we guessed at.
  const bad = (text.match(/\uFFFD/g) || []).length;
  if (bad > text.length * 0.02) return { error: 'That file is not readable as text.' };
  return { text: text.trim(), kind: 'text file' };
}

/* -------------------------- the good PDF reader -------------------------- */
/**
 * pdf-parse (already a dependency) handles embedded font encodings that the
 * reader above cannot, so it goes first and the built-in one is the fallback.
 *
 * It leans on pdf.js, which chatters font complaints straight to the console —
 * "TT: undefined function: 21", "invalid function id: 136". They are harmless
 * (a glyph program pdf.js does not implement) but they are NOISE in Shahyd's
 * terminal and they make a working read look broken. Silenced for the duration
 * of the parse only, and real errors still surface.
 */
export async function quietPdfParse(buf) {
  let pdfParse;
  try { pdfParse = (await import('pdf-parse')).default; }
  catch { return null; }   // not installed — caller falls back

  const { warn, log, error } = console;
  const noisy = /^(Warning: )?TT: |^Warning: (Invalid|Indexing|Unsupported|Unimplemented)|fontkit|FormatError|getPathGenerator/i;
  const filter = (orig) => (...args) => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (noisy.test(first)) return;
    orig.apply(console, args);
  };
  console.warn = filter(warn); console.log = filter(log); console.error = filter(error);
  try {
    const out = await pdfParse(buf);
    return { text: String(out?.text ?? '').trim(), pages: out?.numpages ?? null };
  } catch {
    return null;
  } finally {
    console.warn = warn; console.log = log; console.error = error;
  }
}
