#!/usr/bin/env node
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DIR       = __dirname;
const IS_WIN    = process.platform === 'win32';
const CF_DOMAIN = 'codecade.co.za';

// ── Logging ───────────────────────────────────────────────────────────────────
const ts  = () => new Date().toTimeString().slice(0, 8);
const log = m => console.log(`[${ts()}] ${m}`);
const ok  = m => console.log(`  ok   ${m}`);
const inf = m => console.log(`  ..   ${m}`);
const die = m => { console.log(`\n  ERR  ${m}\n`); process.exit(1); };

// ── Find binary: bundled bin/ first, then system PATH ─────────────────────────
function findBin(name) {
  const platform = IS_WIN ? 'win' : 'linux';
  const ext      = IS_WIN ? '.exe' : '';
  const bundled  = path.join(DIR, 'bin', platform, name + ext);
  if (fs.existsSync(bundled)) return bundled;
  try {
    const cmd   = IS_WIN ? 'where' : 'which';
    const found = execFileSync(cmd, [name], { encoding: 'utf8' }).trim().split('\n')[0].trim();
    if (found) return found;
  } catch {}
  return null;
}

// ── Generate config.yml with absolute paths for this machine ──────────────────
function writeCfConfig() {
  const cfDir = path.join(DIR, '.cloudflared');
  if (!fs.existsSync(cfDir)) return null;
  const jsons = fs.readdirSync(cfDir).filter(f => /^[0-9a-f-]{36}\.json$/i.test(f));
  if (!jsons.length) return null;
  const tunnelId   = jsons[0].replace('.json', '');
  const credsFile  = path.join(cfDir, jsons[0]);
  const configFile = path.join(cfDir, 'config.yml');
  fs.writeFileSync(configFile, [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credsFile}`,
    `ingress:`,
    `  - hostname: ${CF_DOMAIN}`,
    `    service: https://localhost:3001`,
    `    originRequest:`,
    `      noTLSVerify: true`,
    `  - service: http_status:404`,
    '',
  ].join('\n'));
  return { tunnelId, configFile };
}

// ── Kill any process listening on a port ──────────────────────────────────────
function killPort(port) {
  try {
    if (IS_WIN) {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const pid = line.trim().split(/\s+/).pop();
          if (pid && pid !== '0')
            try { execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' }); } catch {}
        }
      }
    } else {
      try { execFileSync('fuser', ['-k', `${port}/tcp`], { stdio: 'ignore' }); } catch {}
    }
  } catch {}
}

// ── Spawners ──────────────────────────────────────────────────────────────────
function startServer() {
  killPort(3001);
  return spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: DIR, stdio: 'inherit',
  });
}

function executableBin(src) {
  // Check if Start.sh already copied it to /tmp
  const precopied = path.join(os.tmpdir(), 'speaker-' + path.basename(src, IS_WIN ? '.exe' : ''));
  if (!IS_WIN && fs.existsSync(precopied)) return precopied;
  // Otherwise copy now — bypasses noexec mounts (Linux) and security blocks (Windows)
  try {
    const dest = path.join(os.tmpdir(), 'speaker-' + path.basename(src));
    fs.copyFileSync(src, dest);
    if (!IS_WIN) {
      fs.chmodSync(dest, 0o755);
    } else {
      try { execFileSync('powershell', ['-Command', `Unblock-File -LiteralPath '${dest}'`], { stdio: 'ignore' }); } catch {}
    }
    return dest;
  } catch {
    return src;
  }
}

function startTunnel(cfg) {
  const cfBin = findBin('cloudflared');
  if (!cfBin || !cfg) return null;
  const certFile = path.join(DIR, '.cloudflared', 'cert.pem');
  const args = [];
  if (fs.existsSync(certFile)) args.push('--origincert', certFile);
  args.push('--config', cfg.configFile, 'tunnel', 'run');
  const proc = spawn(executableBin(cfBin), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.on('error', err => {
    log(`tunnel spawn error: ${err.message}`);
    if (err.code === 'EACCES') log('cloudflared is not executable — check drive mount flags');
  });
  return proc;
}

// ── Header ────────────────────────────────────────────────────────────────────
console.log('\n  Speaker');
console.log(`  ${os.platform()} — ${DIR}\n`);

// ── Preflight ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(DIR, 'node_modules')))
  die('node_modules missing — copy the full Speaker folder including node_modules');

fs.mkdirSync(path.join(DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(DIR, '.run'), { recursive: true });

const cfCfg = writeCfConfig();

// ── Start server ──────────────────────────────────────────────────────────────
inf('starting server...');
let server = startServer();
let tunnel = null;
let panel  = null;

function startPanel() {
  if (!fs.existsSync(path.join(DIR, 'control-panel.js'))) return null;
  const port = process.env.PANEL_PORT || '9090';
  const proc = spawn(process.execPath, [path.join(DIR, 'control-panel.js')], {
    cwd: DIR, stdio: 'inherit',
    env: { ...process.env, PANEL_PORT: port, INSTALL_SH: path.join(DIR, 'install.sh') },
  });
  try { fs.writeFileSync(path.join(DIR, '.run', 'panel.pid'), String(proc.pid)); } catch {}
  return proc;
}

setTimeout(() => {
  if (server.exitCode !== null)
    die('server.js exited immediately — check the output above');
  log(`server running  PID ${server.pid}`);

  inf('starting control panel...');
  panel = startPanel();
  if (panel) {
    setTimeout(() => {
      if (panel && panel.exitCode === null) ok(`control panel running  PID ${panel.pid}`);
      else log('control panel failed to start — check control-panel.js');
    }, 1500);
  }

  if (!cfCfg) {
    log('no tunnel credentials — running local only');
    return;
  }
  inf('starting tunnel...');
  tunnel = startTunnel(cfCfg);
  setTimeout(() => {
    if (!tunnel || tunnel.exitCode !== null) {
      log('tunnel failed to start — running local only');
      tunnel = null;
    } else {
      ok(`tunnel live → https://${CF_DOMAIN}`);
    }
  }, 3000);
}, 2000);

// ── Update check ─────────────────────────────────────────────────────────────
function checkForUpdate() {
  try {
    const local  = execFileSync('git', ['rev-parse', 'HEAD'],                        { cwd: DIR, encoding: 'utf8' }).trim();
    const remote = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'],   { cwd: DIR, encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (!remote || local === remote) return;
    log(`update detected (${local.slice(0,7)} → ${remote.slice(0,7)}) — pulling and restarting...`);
    const pullOut = execFileSync('git', ['pull'], { cwd: DIR, encoding: 'utf8' });
    if (pullOut.trim()) pullOut.trim().split('\n').forEach(l => log(l));
    log('pull complete — restarting server + panel');
    server.kill();
    server = startServer();
    log(`server restarted  PID ${server.pid}`);
    if (panel) { try { panel.kill(); } catch {} }
    panel = startPanel();
  } catch {}
}

// ── Monitor & restart ─────────────────────────────────────────────────────────
console.log('  Running — Ctrl+C to quit.\n');

setInterval(() => {
  if (server.exitCode !== null) {
    log('server crashed — restarting');
    server = startServer();
    log(`server restarted  PID ${server.pid}`);
  }
  if (cfCfg && tunnel && tunnel.exitCode !== null) {
    log('tunnel died — restarting');
    tunnel = startTunnel(cfCfg);
  }
  if (panel && panel.exitCode !== null) {
    log('control panel crashed — restarting');
    panel = startPanel();
  }
}, 5000);

setInterval(checkForUpdate, 60_000);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown() {
  console.log('\n  Shutting down...');
  try { server?.kill(); } catch {}
  try { tunnel?.kill(); } catch {}
  try { panel?.kill(); } catch {}
  try { fs.unlinkSync(path.join(DIR, '.run', 'panel.pid')); } catch {}
  console.log('  Done.\n');
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
