// First and second visit of the demo page in Chrome over the DevTools protocol, and a later visit with no network:
//   - time from opening the page to the result of a file handed to the file input as soon as the page says Ready
//   - bytes over the network: Network.loadingFinished.encodedDataLength of every target (the page, the OCR workers
//     and their threads, the service worker), each request once, responses answered by the service worker left out (the
//     service worker's own request is counted), up to that result and up to the end of the downloads in the background
//   - the hosts the page contacted
//   - offline (--offline): Chrome started again on the same profile with every host name unresolvable and this
//     server stopped, the page opened, a photo and a PDF read
// Each run is a new empty profile; the server (record/serve.mjs, the GitHub Pages way) is started here.
// usage: node demo/record/visit.mjs [--runs 3] [--file examples/receipt.jpg] [--offline] [--out DIR] [--chrome PATH] [--port 8090]
//        [--url URL] (a page served elsewhere instead of this server; no --offline then)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const DEMO = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const RUNS = Number(opt('--runs', 3));
const FILE = join(DEMO, opt('--file', 'examples/receipt.jpg'));
const PDF = join(DEMO, 'examples/inventory-scan.pdf');
const OFFLINE = args.includes('--offline');
const OUT = opt('--out', join(DEMO, 'record/out/visit'));
const PORT = Number(opt('--port', 8090));
const CHROME = opt('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const DEBUG_PORT = Number(opt('--debug-port', 9361));
const URL_GIVEN = opt('--url', null);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error(`no DevTools connection at ${wsUrl}`)); });
  let id = 0;
  const pending = new Map();
  const handlers = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
      return;
    }
    for (const h of handlers) h(m);
  };
  return {
    send(method, params = {}, sessionId) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        setTimeout(() => { if (pending.delete(mid)) rej(new Error(`${method} timed out`)); }, 60000);
      });
    },
    on(h) { handlers.add(h); },
    close() { ws.close(); },
  };
}

async function launch(profile, extra = []) {
  const proc = spawn(CHROME, [`--user-data-dir=${profile}`, '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run',
    '--no-default-browser-check', '--mute-audio', '--use-mock-keychain', '--password-store=basic', '--disable-background-networking',
    ...extra, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('Chrome did not start')), 30000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); res(m[1]); }
    });
  });
  const cdp = await cdpConnect(wsUrl);
  // every target, the service worker included; each one's network counted
  const net = { bytes: 0, byHost: {}, hosts: new Set(), requests: new Map(), sw: new Set(), counted: new Set(), failed: [] };
  // a target can have two sessions (a service worker is attached from the browser and again as a child of the page it
  // controls; each session reports the same requests): requests are keyed by target, and each is counted once
  const sessions = new Map();
  const targetOf = new Map();
  // sent in order without waiting for each answer: a target paused at its start (a service worker) answers only
  // after it runs, so waiting for Network.enable before letting it run would keep it paused
  const attach = (sid) => {
    cdp.send('Network.enable', {}, sid).catch(() => {});
    cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).catch(() => {});
    cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
  };
  cdp.on((m) => {
    const key = `${targetOf.get(m.sessionId) ?? m.sessionId}|${m.params?.requestId}`;
    if (m.method === 'Target.attachedToTarget') {
      targetOf.set(m.params.sessionId, m.params.targetInfo.targetId);
      if (!sessions.has(m.params.targetInfo.targetId)) sessions.set(m.params.targetInfo.targetId, m.params.sessionId);
      attach(m.params.sessionId);
    }
    else if (m.method === 'Network.requestWillBeSent') {
      try {
        const u = new URL(m.params.request.url);
        if (u.protocol.startsWith('http')) {
          net.requests.set(key, u.host);
          net.hosts.add(u.host);
        }
      } catch { /* data: */ }
    } else if (m.method === 'Network.responseReceived') {
      if (m.params.response.fromServiceWorker) net.sw.add(key);
    } else if (m.method === 'Network.loadingFinished') {
      const host = net.requests.get(key);
      if (host && !net.sw.has(key) && !net.counted.has(key)) {
        net.counted.add(key);
        net.bytes += m.params.encodedDataLength;
        net.byHost[host] = (net.byHost[host] ?? 0) + m.params.encodedDataLength;
      }
    } else if (m.method === 'Network.loadingFailed') {
      const host = net.requests.get(key);
      if (host) net.failed.push(`${host}: ${m.params.errorText}`);
    }
  });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  return { proc, cdp, net, sessions };
}

async function newTab(B) {
  const { targetId } = await B.cdp.send('Target.createTarget', { url: 'about:blank' });
  for (let i = 0; i < 200 && !B.sessions.has(targetId); i++) await sleep(25);
  const sessionId = B.sessions.get(targetId);
  if (!sessionId) throw new Error('the new tab was not attached');
  await B.cdp.send('Page.enable', {}, sessionId);
  await B.cdp.send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}

async function evaluate(cdp, sid, expr) {
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    return r.result?.value;
  } catch {
    return undefined; // the page is between documents (coi-serviceworker reloads it once)
  }
}

async function until(cdp, sid, expr, ms, step = 50) {
  const t = Date.now();
  for (;;) {
    const v = await evaluate(cdp, sid, expr);
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await sleep(step);
  }
}

async function handFile(cdp, sid, path) {
  const n = await evaluate(cdp, sid, 'window.demoRuns.length');
  const { root } = await cdp.send('DOM.getDocument', { depth: 1 }, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' }, sid);
  await cdp.send('DOM.setFileInputFiles', { files: [path], nodeId }, sid);
  return until(cdp, sid, `(() => { const j = window.demoRuns[${n}]; return j && j.done ? j : null; })()`, 240000);
}

async function settle(net, quietMs = 2000, maxMs = 120000) {
  const t = Date.now();
  let last = net.bytes, since = Date.now();
  while (Date.now() - t < maxMs) {
    await sleep(250);
    if (net.bytes !== last) { last = net.bytes; since = Date.now(); }
    if (Date.now() - since >= quietMs) return;
  }
}

/** One visit in a new tab: open, wait for Ready, hand the file, wait for its result and for the background downloads. */
async function visit(B, url) {
  const before = B.net.bytes;
  const tab = await newTab(B);
  const t0 = Date.now();
  await B.cdp.send('Page.navigate', { url }, tab.sessionId);
  const ready = await until(B.cdp, tab.sessionId, `window.demoState?.phase === 'ready' ? window.demoState.readyAt : (window.demoState?.phase === 'failed' ? -1 : null)`, 240000);
  if (!ready || ready < 0) return { error: `not ready: ${JSON.stringify(await evaluate(B.cdp, tab.sessionId, 'window.demoState'))}` };
  const job = await handFile(B.cdp, tab.sessionId, FILE);
  const first = { ms: job ? job.endedAt - t0 : null, bytes: B.net.bytes - before, readyMs: ready - t0, screenMs: job?.ms, lines: job?.lines?.length, error: job?.error ?? null };
  await until(B.cdp, tab.sessionId, `window.demoState?.converter === 'ready' || window.demoState?.converter === 'failed'`, 240000);
  await settle(B.net);
  const state = await evaluate(B.cdp, tab.sessionId, 'window.demoState');
  return { first, all: { bytes: B.net.bytes - before, converterReadyMs: state?.converterReadyAt ? state.converterReadyAt - t0 : null }, state, tab };
}

const report = { when: new Date().toISOString(), chrome: null, file: FILE, runs: [], offline: null };
const server = URL_GIVEN ? { close: async () => {} } : await startServer({ port: PORT });
const url = URL_GIVEN ?? `http://localhost:${server.port}/`;
let keepProfile = null;
for (let i = 0; i < RUNS; i++) {
  const profile = mkdtempSync(join(tmpdir(), 'litert-ocr-demo-visit-'));
  const B = await launch(profile);
  report.chrome ??= (await B.cdp.send('Browser.getVersion')).product;
  const v1 = await visit(B, url);
  const v2 = await visit(B, url);
  const hosts = [...B.net.hosts].sort();
  report.runs.push({ run: i + 1, first: { ...v1.first, allBytes: v1.all?.bytes, converterReadyMs: v1.all?.converterReadyMs, threads: v1.state?.info?.threads, isolated: v1.state?.isolated, error: v1.error }, second: { ...v2.first, allBytes: v2.all?.bytes, error: v2.error }, hosts, byHost: B.net.byHost, failed: B.net.failed.slice(0, 20) });
  console.log(`run ${i + 1}: first ${v1.first?.ms} ms, ${(v1.first?.bytes / 1e6).toFixed(2)} MB to the result, ${(v1.all?.bytes / 1e6).toFixed(2)} MB in all | second ${v2.first?.ms} ms, ${(v2.first?.bytes / 1e6).toFixed(2)} MB | hosts ${hosts.join(' ')}`);
  await B.cdp.send('Browser.close').catch(() => {});
  await sleep(1500);
  B.proc.kill('SIGTERM');
  if (OFFLINE && i === RUNS - 1) keepProfile = profile;
  else rmSync(profile, { recursive: true, force: true });
}

if (OFFLINE && keepProfile && !URL_GIVEN) {
  // no network: this server stopped, every host name unresolvable; the same profile (its service worker and caches)
  await server.close();
  const B = await launch(keepProfile, ['--host-resolver-rules=MAP * ~NOTFOUND']);
  const tab = await newTab(B);
  const t0 = Date.now();
  await B.cdp.send('Page.navigate', { url }, tab.sessionId).catch((e) => ({ error: e.message }));
  const ready = await until(B.cdp, tab.sessionId, `window.demoState?.phase === 'ready' ? window.demoState.readyAt : (window.demoState?.phase === 'failed' ? -1 : null)`, 60000);
  const out = { opened: !!ready && ready > 0, readyMs: ready > 0 ? ready - t0 : null, title: await evaluate(B.cdp, tab.sessionId, 'document.title'), state: await evaluate(B.cdp, tab.sessionId, 'window.demoState') };
  if (out.opened) {
    await until(B.cdp, tab.sessionId, `window.demoState?.converter === 'ready' || window.demoState?.converter === 'failed'`, 60000);
    const photo = await handFile(B.cdp, tab.sessionId, FILE);
    const pdf = await handFile(B.cdp, tab.sessionId, PDF);
    out.photo = { ms: photo?.ms, lines: photo?.lines?.length, error: photo?.error ?? null };
    out.pdf = { ms: pdf?.ms, lines: pdf?.lines?.length, error: pdf?.error ?? null, pages: pdf?.pages ?? null };
    out.converter = await evaluate(B.cdp, tab.sessionId, 'window.demoState.converter');
  } else {
    out.text = await evaluate(B.cdp, tab.sessionId, 'document.body?.innerText?.slice(0, 400)');
  }
  out.bytes = B.net.bytes;
  out.failedRequests = B.net.failed.slice(0, 20);
  report.offline = out;
  console.log(`offline: opened ${out.opened}, photo ${JSON.stringify(out.photo)}, pdf ${JSON.stringify(out.pdf)}`);
  await B.cdp.send('Browser.close').catch(() => {});
  await sleep(1500);
  B.proc.kill('SIGTERM');
  rmSync(keepProfile, { recursive: true, force: true });
} else {
  await server.close();
}

const med = (v) => { const s = v.filter((x) => typeof x === 'number').sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
report.median = {
  firstMs: med(report.runs.map((r) => r.first.ms)),
  firstBytes: med(report.runs.map((r) => r.first.bytes)),
  firstAllBytes: med(report.runs.map((r) => r.first.allBytes)),
  secondMs: med(report.runs.map((r) => r.second.ms)),
  secondBytes: med(report.runs.map((r) => r.second.bytes)),
};
writeFileSync(join(OUT, 'visit.json'), JSON.stringify(report, null, 2));
console.log(`median: ${JSON.stringify(report.median)} -> ${join(OUT, 'visit.json')}`);
process.exit(0);
