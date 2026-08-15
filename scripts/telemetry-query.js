#!/usr/bin/env node
// Reads telemetry/events-*.jsonl (lib/telemetry.js) and answers the kind of
// questions you'd normally reach for jq for -- written in plain Node
// instead since jq isn't installed on terraserver and Node already has to
// be (it's running the app). No dependencies.
//
// Usage (run from the repo root, or `node scripts/telemetry-query.js ...`
// from anywhere):
//   node scripts/telemetry-query.js summary [hours=1]
//   node scripts/telemetry-query.js recent [n=50]
//   node scripts/telemetry-query.js errors [n=50]
//   node scripts/telemetry-query.js latency <pathSubstring> [hours=1]
//   node scripts/telemetry-query.js slow [n=20] [hours=1]
//   node scripts/telemetry-query.js outbound [hours=1]

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'telemetry');

function readEvents(sinceMs) {
  if (!fs.existsSync(DIR)) return [];
  const events = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!sinceMs || e.ts >= sinceMs) events.push(e);
      } catch {}
    }
  }
  return events;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length));
  return sorted[idx];
}

function fmtStats(label, mss) {
  if (!mss.length) return `  ${label}: (no data)`;
  const sorted = [...mss].sort((a, b) => a - b);
  const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  return `  ${label}: n=${sorted.length} avg=${avg}ms p50=${percentile(sorted, 50)}ms p95=${percentile(sorted, 95)}ms max=${sorted[sorted.length - 1]}ms`;
}

const [, , cmd, ...args] = process.argv;
const hoursArg = n => (parseFloat(n) || 1) * 3600000;

if (cmd === 'summary') {
  const since = Date.now() - hoursArg(args[0]);
  const events = readEvents(since);
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
  console.log(`Last ${args[0] || 1}h -- ${events.length} events`);
  for (const [t, c] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${c}`);
  const httpMs = events.filter(e => e.type === 'http').map(e => e.ms);
  console.log(fmtStats('http latency', httpMs));
  const outboundMs = events.filter(e => e.type === 'outbound').map(e => e.ms);
  console.log(fmtStats('outbound latency', outboundMs));
  const errCount = events.filter(e => e.type === 'error').length;
  const httpErrCount = events.filter(e => e.type === 'http' && e.status >= 400).length;
  const outboundErrCount = events.filter(e => e.type === 'outbound' && (e.status === 0 || e.status >= 400)).length;
  console.log(`  errors: ${errCount} process, ${httpErrCount} http 4xx/5xx, ${outboundErrCount} outbound failed`);

} else if (cmd === 'recent') {
  const n = parseInt(args[0], 10) || 50;
  const events = readEvents(0).slice(-n);
  for (const e of events) console.log(JSON.stringify(e));

} else if (cmd === 'errors') {
  const n = parseInt(args[0], 10) || 50;
  const events = readEvents(0).filter(e => e.type === 'error' || (e.type === 'http' && e.status >= 400) || (e.type === 'outbound' && (e.status === 0 || e.status >= 400))).slice(-n);
  for (const e of events) console.log(JSON.stringify(e));

} else if (cmd === 'latency') {
  const needle = args[0];
  if (!needle) { console.error('usage: latency <pathSubstring> [hours=1]'); process.exit(1); }
  const since = Date.now() - hoursArg(args[1]);
  const mss = readEvents(since).filter(e => e.type === 'http' && e.path && e.path.includes(needle)).map(e => e.ms);
  console.log(fmtStats(`http ${needle}`, mss));

} else if (cmd === 'slow') {
  const n = parseInt(args[0], 10) || 20;
  const since = Date.now() - hoursArg(args[1]);
  const events = readEvents(since).filter(e => e.type === 'http').sort((a, b) => b.ms - a.ms).slice(0, n);
  for (const e of events) console.log(`${e.ms}ms  ${e.status}  ${e.method} ${e.path}  ${new Date(e.ts).toISOString()}`);

} else if (cmd === 'outbound') {
  const since = Date.now() - hoursArg(args[0]);
  const events = readEvents(since).filter(e => e.type === 'outbound');
  const byKey = {};
  for (const e of events) {
    const k = `${e.host}${e.path}`;
    (byKey[k] = byKey[k] || []).push(e);
  }
  for (const [k, list] of Object.entries(byKey).sort((a, b) => b[1].length - a[1].length)) {
    const fails = list.filter(e => e.status === 0 || e.status >= 400).length;
    console.log(fmtStats(`${k}${fails ? `  (${fails} failed)` : ''}`, list.map(e => e.ms)));
  }

} else {
  console.log(`Usage: node telemetry-query.js <command> [args]
Commands:
  summary [hours=1]                  event counts + latency overview
  recent [n=50]                      last n raw events
  errors [n=50]                      last n error/failure events
  latency <pathSubstring> [hours=1]  latency stats for a matching http path
  slow [n=20] [hours=1]              n slowest http requests
  outbound [hours=1]                 outbound API latency, grouped by host+path`);
}
