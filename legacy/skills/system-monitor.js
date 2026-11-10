/**
 * System monitor — a Legacy skill (v3.22), and the example she copies.
 *
 * LIVE: CPU, memory, disk C:, Windows errors in the last hour, and the
 * hungriest program — on screen, every couple of seconds.
 * BACKGROUND (every minute): if CPU or memory stays above 90% for three
 * minutes, his phone hears which programs to end. If Windows logs a CRITICAL
 * error, he hears that too. Each at most once every 20 minutes — an alarm
 * that repeats every minute gets muted, then misses the one that mattered.
 *
 * IT NEVER ENDS A PROGRAM BY ITSELF. It names them; end_task asks him first.
 */
import os from 'node:os';

let prevCpu = null;
let prevProcs = null;           // { at, byId: { id: cpuSeconds } }
let top = [];                   // [{ name, id, cpu, memMB }]
let disk = null, diskAt = 0, errs = null, errsAt = 0, lastRecord = 0;
const hot = { cpu: 0, ram: 0 };
const lastAlert = { cpu: 0, ram: 0, crit: 0 };
const PROTECTED = /^(system|idle|csrss|wininit|winlogon|services|lsass|smss|dwm|explorer|svchost|node|registry|memory compression)$/i;

function cpuPct() {
  const t = os.cpus().reduce((a, c) => { for (const [k, v] of Object.entries(c.times)) a[k] = (a[k] ?? 0) + v; return a; }, {});
  const total = Object.values(t).reduce((a, b) => a + b, 0), idle = t.idle;
  let pct = null;
  if (prevCpu) { const dt = total - prevCpu.total, di = idle - prevCpu.idle; pct = dt > 0 ? Math.round((1 - di / dt) * 100) : 0; }
  prevCpu = { total, idle };
  return pct;
}
const ramPct = () => Math.round((1 - os.freemem() / os.totalmem()) * 100);

async function readDisk(ctx) {
  if (Date.now() - diskAt < 60_000) return disk;
  diskAt = Date.now();
  const r = await ctx.ps("$d = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\"; '{0},{1}' -f $d.Size, $d.FreeSpace");
  const [size, free] = r.out.split(',').map(Number);
  disk = size > 0 ? Math.round((1 - free / size) * 100) : null;
  return disk;
}

async function readErrors(ctx) {
  if (Date.now() - errsAt < 60_000) return errs;
  errsAt = Date.now();
  const r = await ctx.ps(
    "$e = Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=1,2; StartTime=(Get-Date).AddHours(-1)} -ErrorAction SilentlyContinue; " +
    "'{0},{1}' -f @($e).Count, @($e | Where-Object { $_.Level -eq 1 }).Count");
  const [all, crit] = r.out.split(',').map(Number);
  errs = Number.isFinite(all) ? { all, crit: crit || 0 } : null;
  return errs;
}

/** Per-program CPU from the change in CPU-seconds between two samples. */
async function readTop(ctx) {
  const r = await ctx.ps('Get-Process | Select-Object Name,Id,CPU,WorkingSet64 | ConvertTo-Json -Compress');
  let list; try { list = JSON.parse(r.out || '[]'); } catch { return top; }
  const now = Date.now(), cores = os.cpus().length || 1, byId = {};
  const rows = [];
  for (const p of Array.isArray(list) ? list : [list]) {
    byId[p.Id] = p.CPU ?? 0;
    const before = prevProcs?.byId?.[p.Id];
    const cpu = before != null && prevProcs ? Math.max(0, ((p.CPU ?? 0) - before) / ((now - prevProcs.at) / 1000) / cores * 100) : 0;
    rows.push({ name: p.Name, id: p.Id, cpu: Math.round(cpu), memMB: Math.round((p.WorkingSet64 ?? 0) / 1048576) });
  }
  prevProcs = { at: now, byId };
  top = rows.filter((x) => !PROTECTED.test(x.name)).sort((a, b) => (b.cpu - a.cpu) || (b.memMB - a.memMB)).slice(0, 6);
  return top;
}

const fmtTop = (by) => [...top].sort((a, b) => by === 'ram' ? b.memMB - a.memMB : b.cpu - a.cpu).slice(0, 3)
  .map((p) => (by === 'ram' ? `${p.name} ${p.memMB >= 1024 ? `${(p.memMB / 1024).toFixed(1)}GB` : `${p.memMB}MB`}` : `${p.name} ${p.cpu}%`)).join(', ');

export default {
  name: 'system-monitor',
  title: 'System monitor',
  description: 'Live CPU, memory, disk and Windows errors; warns him which programs to end when the PC is overloaded.',

  widget: {
    title: 'SYSTEM',
    async read(ctx) {
      const cpu = cpuPct(), ram = ramPct();
      const d = await readDisk(ctx), e = await readErrors(ctx);
      const rows = [
        { label: 'CPU', value: cpu ?? '…', unit: '%', pct: cpu ?? 0, warn: (cpu ?? 0) > 90 },
        { label: 'Memory', value: ram, unit: '%', pct: ram, warn: ram > 90 },
      ];
      if (d != null) rows.push({ label: 'Disk C:', value: d, unit: '%', pct: d, warn: d > 92 });
      if (e) rows.push({ label: 'Win errors 1h', value: e.all, unit: e.crit ? ` (${e.crit} critical)` : '', warn: e.crit > 0 });
      if (top[0]) rows.push({ label: 'Busiest', value: top[0].name, unit: top[0].cpu ? ` ${top[0].cpu}%` : '' });
      return rows;
    },
  },

  check: {
    every: 60_000,
    async run(ctx) {
      if (process.platform !== 'win32') return;
      await readTop(ctx);
      const cpu = cpuPct() ?? 0, ram = ramPct();
      hot.cpu = cpu > 90 ? hot.cpu + 1 : 0;
      hot.ram = ram > 90 ? hot.ram + 1 : 0;
      const quiet = 20 * 60_000;
      if (hot.cpu >= 3 && Date.now() - lastAlert.cpu > quiet) {
        lastAlert.cpu = Date.now();
        const msg = `Your PC has been at ${cpu}% CPU for 3 minutes. Using the most: ${fmtTop('cpu')}. Tell me which to end.`;
        await ctx.notify(msg, 'important'); await ctx.phone(`🖥 ${msg}`);
      }
      if (hot.ram >= 3 && Date.now() - lastAlert.ram > quiet) {
        lastAlert.ram = Date.now();
        const msg = `Memory is at ${ram}% for 3 minutes. Biggest: ${fmtTop('ram')}. Tell me which to end.`;
        await ctx.notify(msg, 'important'); await ctx.phone(`🖥 ${msg}`);
      }
      // New CRITICAL events since the last look.
      const r = await ctx.ps(
        "Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=1; StartTime=(Get-Date).AddMinutes(-5)} -ErrorAction SilentlyContinue | " +
        'Select-Object -First 3 RecordId,ProviderName,@{n="Msg";e={($_.Message -split "`n")[0]}} | ConvertTo-Json -Compress');
      let ev = []; try { ev = [].concat(JSON.parse(r.out || '[]')); } catch {}
      const fresh = ev.filter((x) => x && x.RecordId > lastRecord);
      if (fresh.length) {
        lastRecord = Math.max(...fresh.map((x) => x.RecordId));
        if (Date.now() - lastAlert.crit > quiet) {
          lastAlert.crit = Date.now();
          const msg = `Windows logged a critical error — ${fresh[0].ProviderName}: ${String(fresh[0].Msg ?? '').slice(0, 140)}`;
          await ctx.notify(msg, 'important'); await ctx.phone(`⚠ ${msg}`);
        }
      }
    },
  },

  tools: [
    {
      name: 'system_status',
      description: 'How the PC is doing right now — CPU, memory, disk, recent Windows errors, and which programs use the most.',
      inputSchema: { type: 'object', properties: {} },
      async handler(_i, ctx) {
        await readTop(ctx); await new Promise((r) => setTimeout(r, 1500)); await readTop(ctx);
        const cpu = cpuPct() ?? 0, ram = ramPct(), d = await readDisk(ctx), e = await readErrors(ctx);
        return `CPU ${cpu}%, memory ${ram}%${d != null ? `, disk C: ${d}% full` : ''}.` +
          (e ? ` ${e.all} Windows error${e.all === 1 ? '' : 's'} in the last hour${e.crit ? `, ${e.crit} critical` : ''}.` : '') +
          (top.length ? `\nMost CPU: ${fmtTop('cpu')}.\nMost memory: ${fmtTop('ram')}.` : '');
      },
    },
    {
      name: 'windows_errors',
      description: 'The most recent Windows errors and critical events, in plain words.',
      inputSchema: { type: 'object', properties: { hours: { type: 'number' } } },
      async handler({ hours = 6 }, ctx) {
        const r = await ctx.ps(
          "Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=1,2; StartTime=(Get-Date).AddHours(-[double]$env:H)} -ErrorAction SilentlyContinue | " +
          'Select-Object -First 8 TimeCreated,LevelDisplayName,ProviderName,@{n="Msg";e={($_.Message -split "`n")[0]}} | ConvertTo-Json -Compress',
          { H: String(Math.min(72, Math.max(1, Number(hours) || 6))) });
        let ev = []; try { ev = [].concat(JSON.parse(r.out || '[]')); } catch {}
        if (!ev.length) return r.ok ? 'No Windows errors in that time.' : 'I could not read the Windows event log.';
        return ev.map((x) => `· ${x.LevelDisplayName} — ${x.ProviderName}: ${String(x.Msg ?? '').slice(0, 120)}`).join('\n');
      },
    },
    {
      name: 'end_task',
      description: 'End a program that is hogging the PC — by name or process id. He confirms first.',
      requiresConfirmation: true,
      describeAction: ({ name }) => `END ${name} — like End task in Task Manager (unsaved work in it is lost)`,
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Program name or process id.' } }, required: ['name'] },
      async handler({ name }, ctx) {
        const q = String(name ?? '').trim().replace(/\.exe$/i, '');
        if (!q || PROTECTED.test(q)) return `I will not end ${q || 'that'} — Windows or I need it.`;
        const r = await ctx.ps(
          '$q = $env:Q; $p = if ($q -match "^\\d+$") { Get-Process -Id ([int]$q) -ErrorAction SilentlyContinue } else { Get-Process -Name $q -ErrorAction SilentlyContinue }; ' +
          '$n = @($p).Count; $p | Stop-Process -Force -ErrorAction SilentlyContinue; $n', { Q: q });
        const n = Number(r.out) || 0;
        return n ? `Ended ${q} (${n} process${n === 1 ? '' : 'es'}).` : `Nothing running matched ${q}.`;
      },
    },
  ],
};
