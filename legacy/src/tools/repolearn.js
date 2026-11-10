/**
 * Learning from GitHub repos — Roadmap 6 #9.
 *
 * "Legacy, learn how to use the Canva API from github.com/canva/docs."
 * The division of labour is deliberate:
 *   fetch_repo_docs (this file) — the HANDS: pulls a repo's README and docs
 *     as plain text, honestly capped.
 *   Legacy herself — the MIND: reads it, distills the parts that matter for
 *     Shahyd, and writes a create_skill so the lesson sticks forever.
 * Legacy never executes repo code — reading is learning; running strangers'
 * code is how machines get owned. Runnable integrations belong in the tool
 * armory (MCP), where the approval gate guards every call.
 */
import { registerTool } from './registry.js';
import { appendAudit } from '../audit.js';

const GH = 'https://api.github.com';
const HEADERS = { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'LegacyAssistant', 'X-GitHub-Api-Version': '2022-11-28' };
const PER_FILE = 25_000;
const TOTAL = 70_000;

function parseRepoUrl(url) {
  const m = String(url ?? '').trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (!m) throw new Error('That does not look like a GitHub repo link — I need github.com/owner/repo.');
  return { owner: m[1], repo: m[2] };
}

async function gh(path, raw = false) {
  const r = await fetch(`${GH}${path}`, { headers: raw ? HEADERS : { ...HEADERS, Accept: 'application/vnd.github+json' } });
  if (r.status === 404) throw new Error('GitHub says that repo (or file) does not exist — private repos are invisible to me.');
  if (r.status === 403 || r.status === 429) throw new Error('GitHub refused the request (403) — usually rate-limiting; wait a few minutes. If it persists, the network may be blocking api.github.com.');
  if (!r.ok) throw new Error(`GitHub said ${r.status}.`);
  return raw ? r.text() : r.json();
}

registerTool({
  name: 'fetch_repo_docs',
  description:
    "Read a GitHub repo's documentation (README + docs folder) as plain " +
    'text. THE LEARNING WORKFLOW: 1) fetch_repo_docs, 2) distill what ' +
    'actually matters for Shahyd, 3) create_skill so the knowledge sticks ' +
    'for every future job. Reading only — never suggests running repo code; ' +
    'runnable integrations belong in the tool armory.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The repo link, e.g. https://github.com/owner/repo' },
      file: { type: 'string', description: 'Optional: one specific file path inside the repo (e.g. docs/api.md) instead of the default README+docs sweep.' },
    },
    required: ['url'],
  },
  handler: async ({ url, file }) => {
    const { owner, repo } = parseRepoUrl(url);
    const parts = [];
    let used = 0;
    const take = (name, text) => {
      const room = TOTAL - used;
      if (room <= 0) return false;
      const slice = String(text ?? '').slice(0, Math.min(PER_FILE, room));
      used += slice.length;
      parts.push(`===== ${name} =====\n${slice}${slice.length < String(text ?? '').length ? '\n…[trimmed]' : ''}`);
      return true;
    };

    if (file?.trim()) {
      const clean = file.trim().replace(/^\/+/, '');
      take(clean, await gh(`/repos/${owner}/${repo}/contents/${clean}`, true));
      return `From ${owner}/${repo}:\n\n${parts.join('\n\n')}`;
    }

    // 0) prove the repo EXISTS before anything is swallowed by softer
    // catches below — otherwise a typo'd repo "succeeds" with zero content.
    const meta = await gh(`/repos/${owner}/${repo}`);
    if (meta?.description) parts.push(`===== ABOUT =====\n${meta.description}`);

    // 1) the README — every repo's front door
    try { take('README', await gh(`/repos/${owner}/${repo}/readme`, true)); }
    catch { parts.push('===== README =====\n(this repo has no README)'); }

    // 2) a docs/ folder if there is one — up to 5 markdown files
    try {
      const listing = await gh(`/repos/${owner}/${repo}/contents/docs`);
      const mds = (Array.isArray(listing) ? listing : []).filter((f) => f.type === 'file' && /\.mdx?$/i.test(f.name)).slice(0, 5);
      for (const f of mds) {
        if (!take(`docs/${f.name}`, await gh(`/repos/${owner}/${repo}/contents/docs/${f.name}`, true))) break;
      }
    } catch { /* no docs folder — the README will have to do */ }

    return `Documentation from ${owner}/${repo} (${used.toLocaleString()} chars):\n\n${parts.join('\n\n')}\n\nNow distill what matters and write it down with create_skill so it sticks.`;
  },
});

/* ------------------------- installing skill repos ------------------------- */
/**
 * Many GitHub projects ship an agent "skill" — a SKILL.md (sometimes with data
 * files) meant to be dropped into an assistant. This installs one into Legacy's
 * own custom skills folder (data/skills/), where it survives upgrades and is
 * readable by every agent through list_skills / read_skill.
 *
 * Reading only: files are downloaded and stored as text. Nothing is executed,
 * ever — runnable integrations belong in the tool armory, not here.
 */
const SKILL_CANDIDATES = [
  'SKILL.md', 'skill.md',
  '.claude/skills/{name}/SKILL.md',
  'skills/{name}/SKILL.md',
  'src/{name}/SKILL.md',
  '{name}/SKILL.md',
  'README.md',
];

registerTool({
  name: 'install_skill_repo',
  description:
    "Install an agent skill published on GitHub into Legacy's own skills, so " +
    'every agent can read it from then on. Give it the repo link. It looks for ' +
    "the repo's SKILL.md (falling back to the README), saves it under " +
    'data/skills/, and reports what it found. Downloads text only — it never ' +
    'runs repo code. Use when Shahyd says "install this skill" with a GitHub link.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'github.com/owner/repo' },
      name: { type: 'string', description: 'What to call it locally. Defaults to the repo name.' },
      path: { type: 'string', description: 'Exact path to the skill file inside the repo, if you already know it.' },
      branch: { type: 'string', description: 'Defaults to main, then master.' },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description:
          'For repos that publish SEVERAL skills under skills/<name>/SKILL.md, ' +
          'the ones to install. Example for heygen-com/hyperframes: ' +
          '["hyperframes","hyperframes-core","hyperframes-animation",' +
          '"hyperframes-keyframes","hyperframes-cli","media-use"].',
      },
    },
    required: ['url'],
  },
  handler: async ({ url, name, path, branch, skills }) => {
    const { owner, repo } = parseRepoUrl(url);
    const local = (name?.trim() || repo).toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 60);
    const branches = branch ? [branch] : ['main', 'master'];

    // A SKILL PACK: several skills published under skills/<name>/SKILL.md in
    // one repo. Installed individually so each stays readable on its own and
    // a single missing one never sinks the rest.
    if (Array.isArray(skills) && skills.length) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const USER = new URL('../../data/skills/', import.meta.url);
      mkdirSync(USER, { recursive: true });
      const got = [], missed = [];
      for (const raw of skills.slice(0, 25)) {
        const slug = String(raw).trim().replace(/^\//, '').toLowerCase().replace(/[^a-z0-9._-]/g, '-');
        if (!slug) continue;
        let hit = null;
        for (const b of branches) {
          for (const p of [`skills/${slug}/SKILL.md`, `.claude/skills/${slug}/SKILL.md`, `${slug}/SKILL.md`]) {
            try {
              const text = await gh(`/${owner}/${repo}/${b}/${p}`, true);
              if (text?.trim()) { hit = { text, path: p, branch: b }; break; }
            } catch { /* try the next shape */ }
          }
          if (hit) break;
        }
        if (!hit) { missed.push(slug); continue; }
        const body = hit.text.length > 60_000 ? hit.text.slice(0, 60_000) : hit.text;
        writeFileSync(new URL(`${slug}.md`, USER),
          `# ${slug}\n> Installed from github.com/${owner}/${repo} — reference copy, Legacy never runs repo code.\n\nSource: ${hit.path} on ${hit.branch}, fetched ${new Date().toISOString().slice(0, 10)}.\n\n---\n\n${body.trim()}\n`);
        got.push(slug);
      }
      appendAudit('skill_pack_installed', { repo: `${owner}/${repo}`, installed: got, missing: missed });
      if (!got.length) {
        return `I could not find any of those skills in ${owner}/${repo}. I looked for skills/<name>/SKILL.md and tried: ${missed.join(', ')}.`;
      }
      return `Installed ${got.length} skill${got.length === 1 ? '' : 's'} from ${owner}/${repo}: ${got.join(', ')}.` +
        (missed.length ? ` I could not find: ${missed.join(', ')}.` : '') +
        ' Every agent can read them now with read_skill.';
    }

    const tryFetch = async (p) => {
      for (const b of branches) {
        try {
          const text = await gh(`/${owner}/${repo}/${b}/${p}`, true);
          if (text?.trim()) return { text, path: p, branch: b };
        } catch { /* try the next branch */ }
      }
      return null;
    };

    const tried = [];
    let found = null;
    const candidates = path?.trim()
      ? [path.trim()]
      : SKILL_CANDIDATES.map((c) => c.replace('{name}', repo));
    for (const c of candidates) {
      tried.push(c);
      found = await tryFetch(c);
      if (found) break;
    }
    if (!found) {
      return `I could not find a skill file in ${owner}/${repo}. I looked for: ${tried.join(', ')}. ` +
        'If you know the exact path inside the repo, give it to me as "path" and I will fetch that.';
    }

    // Keep it sane in size — a skill is meant to be read, not scrolled.
    const CAP = 60_000;
    let body = found.text;
    let trimmed = false;
    if (body.length > CAP) { body = body.slice(0, CAP); trimmed = true; }

    // Write it exactly where create_skill writes, so it behaves like any other
    // custom skill: lives in data/skills/, survives upgrades, overrides a
    // shipped skill of the same name.
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const USER = new URL('../../data/skills/', import.meta.url);
    mkdirSync(USER, { recursive: true });
    const md = `# ${local}\n> Installed from github.com/${owner}/${repo} — reference copy, Legacy never runs repo code.\n\nSource: ${found.path} on ${found.branch}, fetched ${new Date().toISOString().slice(0, 10)}.\n\n---\n\n${body.trim()}\n`;
    writeFileSync(new URL(`${local}.md`, USER), md);
    appendAudit('skill_installed', { name: local, repo: `${owner}/${repo}`, path: found.path });

    return `Installed "${local}" from ${owner}/${repo} — ${found.path} on ${found.branch}` +
      `${trimmed ? ', trimmed to the first 60,000 characters' : ''}. ` +
      `Every agent can read it now with read_skill.` +
      (found.path === 'README.md' ? ' Note: this repo had no SKILL.md, so I saved the README — tell me the exact path if there is a better file.' : '');
  },
});
