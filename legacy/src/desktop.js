import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { desktopEnv, groups, importCredentials, readCredentials, saveCredentials } from './credentials.js';

const mode = process.argv[2];

function openBrowser(url) {
  console.log(`Open ${url} in your browser if a tab does not appear.`);
  execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
}

async function configure(required) {
  const token = randomBytes(24).toString('hex');
  const route = `/${token}`;
  const logo = readFileSync(new URL('../public/legacy_studios_logo.png', import.meta.url), 'base64');
  const page = readFileSync(new URL('../desktop/connections.html', import.meta.url), 'utf8')
    .replaceAll('LOGO_DATA_URL', `data:image/png;base64,${logo}`);
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  let saved = false;
  const setup = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
      res.end(body);
    };
    const origin = `http://127.0.0.1:${setup.address().port}`;
    if (saved || req.url !== route || req.headers.host !== new URL(origin).host) return send(404, '{}');
    if (req.method === 'GET') {
      let existing;
      try { existing = readCredentials(desktopEnv); }
      catch { return send(500, 'Could not read the local credentials file.', 'text/plain'); }
      const fields = Object.entries(groups).map(([group, keys], i) => `<details ${i === 0 ? 'open' : ''}>
        <summary>${group}</summary>${keys.map((key) => `<label>${key}${required && key === 'ANTHROPIC_API_KEY' ? ' (required)' : ''}
        <input name="${key}" type="password" autocomplete="off" placeholder="${existing[key] ? 'Saved locally' : 'Enter value'}">
        ${existing[key] ? `<span><input type="checkbox" name="remove" value="${key}"> Remove saved value</span>` : ''}</label>`).join('')}</details>`).join('');
      return send(200, page.replace('<!-- fields -->', fields), 'text/html');
    }
    if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return send(403, '{}');
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 256 * 1024) return send(413, JSON.stringify({ error: 'The file is too large.' }));
        chunks.push(chunk);
      }
      if (saved) return send(409, '{}');
      const { raw, changes, remove } = JSON.parse(Buffer.concat(chunks));
      const patch = { ...importCredentials(raw || ''), ...changes };
      if (required && (remove.includes('ANTHROPIC_API_KEY') || !(patch.ANTHROPIC_API_KEY?.trim() || readCredentials(desktopEnv).ANTHROPIC_API_KEY))) {
        return send(400, JSON.stringify({ error: 'Enter an Anthropic API key to start Legacy AI.' }));
      }
      saveCredentials(desktopEnv, patch, remove);
      saved = true;
      send(200, JSON.stringify({ message: required ? 'Saved. Legacy AI is opening in a new tab.' : 'Saved. Restart Legacy AI to apply the changes.' }));
      setup.close(finish);
    } catch (error) {
      send(400, JSON.stringify({ error: error.message.startsWith('Unexpected') ? 'The request could not be read.' : 'Could not save the credentials. Check the values and try again.' }));
    }
  });
  setup.listen(0, '127.0.0.1');
  await once(setup, 'listening');
  openBrowser(`http://127.0.0.1:${setup.address().port}${route}`);
  await done;
}

if (mode === 'configure') {
  await configure(false);
} else {
  if (!mode && !readCredentials(desktopEnv).ANTHROPIC_API_KEY) await configure(true);
  Object.assign(process.env, readCredentials(desktopEnv));
  if (mode === 'linkedin') await import('./setup-linkedin.js');
  else if (mode === 'tiktok') await import('./setup-tiktok.js');
  else if (mode === 'instagram') {
    process.env.LEGACY_DESKTOP_SETUP = '1';
    await import('./setup-instagram.js');
  } else {
    const { server } = await import('./server.js');
    if (!server.listening) await once(server, 'listening');
    openBrowser(`http://127.0.0.1:${server.address().port}/`);
  }
}
