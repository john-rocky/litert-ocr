// A take of the demo page in Chrome on an Android phone over adb, driven like a finger: the file button, the phone's
// file picker, a photo; then the button again and a PDF. The phone records its own screen; the cut keeps the time from
// choosing the file to the result as it was and shortens only the waits of the driver.
//   1. the photo goes to Pictures and the PDF to Download (the media index scans both); Chrome opens the page and loads
//      the model into its cache
//   2. --airplane: airplane mode on (Wi-Fi off too), checked; the page opens again and must reach Ready without network
//   3. scout: the picker is opened once per file and the taps that reach the file are found from the screen's UI tree,
//      then the picker is closed without choosing (no file is read before the take)
//   4. waits for a rested phone: thermal status 0, battery at most 36 C, no CPU clock cap (and Adreno level 0 if any)
//   5. the take: screenrecord, the button, the picker, the file, the result; the same for the PDF
//   6. --failures DIR (a path the page's server serves): the failure inputs dropped on the page, each followed by an
//      example, and a password PDF with a wrong and the right password
//   7. restores airplane mode and Wi-Fi, removes the pushed files, clears the page's caches and service worker, closes
//      the tab; then cuts the recording (30 fps, the left half of the status bar painted over: other apps' icons)
// usage: node demo/record/android-take.mjs --serial SERIAL --url http://localhost:8961/ --out DIR [--airplane]
//        [--reverse PORT] [--photo examples/receipt.jpg] [--pdf examples/inventory-scan.pdf] [--failures record/out/failure]
//        [--cdp-port 9339] [--rest-max 600] [--scout-only] [--no-reopen]
//        node demo/record/android-take.mjs --cut-only --out DIR   (the cut again from DIR/take-raw.mp4 and DIR/run.json)
// --reverse PORT runs `adb reverse tcp:PORT tcp:PORT` for a page served on this machine (localhost is a secure context,
// which the service worker needs). The phone must be unlocked.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const DEMO = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SERIAL = opt('--serial', null);
const URL0 = opt('--url', 'http://localhost:8961/');
const OUT = opt('--out', join(DEMO, 'record/out/android-take'));
const AIRPLANE = args.includes('--airplane');
const REVERSE = opt('--reverse', null);
const PHOTO = join(DEMO, opt('--photo', 'examples/receipt.jpg'));
const PDF = join(DEMO, opt('--pdf', 'examples/inventory-scan.pdf'));
const FAILURES = opt('--failures', null);
const CDP_PORT = Number(opt('--cdp-port', 9339));
const REST_MAX = Number(opt('--rest-max', 600)) * 1000;
const SCOUT_ONLY = args.includes('--scout-only');
const CUT_ONLY = args.includes('--cut-only');
const REOPEN = !args.includes('--no-reopen');
const HOLD_MS = 3000;
const CHROME = 'com.android.chrome';
if (!SERIAL && !CUT_ONLY) throw new Error('--serial is required');
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 60000 }).replace(/\r/g, '');
const adbRaw = (...a) => execFileSync('adb', ['-s', SERIAL, ...a], { maxBuffer: 64 << 20, timeout: 60000 });
const sh = (cmd) => adb('shell', cmd);
const now = () => Number(sh('date +%s%3N').trim());
const run = CUT_ONLY ? JSON.parse(readFileSync(join(OUT, 'run.json'), 'utf8')) : { when: new Date().toISOString(), serial: SERIAL, url: URL0, events: [], screens: [], failures: [], checks: [] };
const log = (what, extra = {}) => {
  const e = { t: Date.now(), what, ...extra };
  run.events.push(e);
  console.log(`${new Date().toISOString().slice(11, 19)} ${what}${Object.keys(extra).length ? ' ' + JSON.stringify(extra).slice(0, 200) : ''}`);
};
const check = (name, ok, detail) => {
  run.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 200) : ''}`);
};
const save = () => writeFileSync(join(OUT, 'run.json'), JSON.stringify(run, null, 2));

// ---- the screen's UI tree ----

function dump(tag) {
  const out = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
  const xml = out.slice(0, out.lastIndexOf('</hierarchy>') + '</hierarchy>'.length);
  if (tag) writeFileSync(join(OUT, `ui-${tag}.xml`), xml);
  return [...xml.matchAll(/<node ([^>]*?)\/?>/g)].map((m) => {
    const a = {};
    for (const [, k, v] of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[k] = v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds ?? '');
    return { text: a.text ?? '', desc: a['content-desc'] ?? '', id: a['resource-id'] ?? '', cls: a.class ?? '', pkg: a.package ?? '', clickable: a.clickable === 'true', box: b ? b.slice(1).map(Number) : null };
  }).filter((n) => n.box && n.box[2] > n.box[0] && n.box[3] > n.box[1]);
}
const center = (n) => [Math.round((n.box[0] + n.box[2]) / 2), Math.round((n.box[1] + n.box[3]) / 2)];
const tap = ([x, y], what) => { sh(`input tap ${x} ${y}`); log(`tap ${what}`, { x, y, device: now() }); };
function screenshot(name) {
  const png = adbRaw('exec-out', 'screencap', '-p');
  writeFileSync(join(OUT, name), png);
  return png;
}
function focus() {
  const s = sh('dumpsys window | grep -E "mCurrentFocus=|mFocusedApp="');
  return /mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^/ }]+)/.exec(s)?.[1] ?? s.trim().slice(0, 120);
}
async function waitFocus(test, ms, step = 150) {
  const t = Date.now();
  for (;;) {
    const f = focus();
    if (test(f)) return f;
    if (Date.now() - t > ms) return null;
    await sleep(step);
  }
}

// ---- the page over the DevTools protocol (Chrome's devtools socket forwarded to this machine) ----

async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error(`no DevTools connection at ${wsUrl}`)); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  return {
    send(method, params = {}) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params }));
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        setTimeout(() => { if (pending.delete(mid)) rej(new Error(`${method} timed out`)); }, 60000);
      });
    },
    close() { ws.close(); },
  };
}
let page = null;
let targetId = null;
async function attachPage() {
  let opened = false;
  for (let i = 0; i < 160; i++) {
    let list = [];
    try {
      list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    } catch {
      list = []; // Chrome's devtools socket is not up yet
    }
    const t = list.find((x) => x.type === 'page' && x.url.startsWith(URL0));
    if (t) {
      targetId = t.id;
      page = await cdpConnect(t.webSocketDebuggerUrl);
      return t;
    }
    // the intent did not open the page (Chrome was running and only came to the front): a new tab from DevTools
    if (i >= 12 && !opened && list.length) {
      opened = true;
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${URL0}`, { method: 'PUT' }).catch(() => {});
      log('opened the page from DevTools');
    }
    await sleep(250);
  }
  throw new Error(`no Chrome tab with ${URL0}`);
}
async function evaluate(expr, opts = {}) {
  try {
    const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, ...opts });
    return r.result?.value;
  } catch {
    return undefined;
  }
}
async function until(expr, ms, step = 100) {
  const t = Date.now();
  for (;;) {
    const v = await evaluate(expr);
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await sleep(step);
  }
}
const readyExpr = `window.demoState?.phase === 'ready' && ['ready', 'failed'].includes(window.demoState?.converter) ? window.demoState : (window.demoState?.phase === 'failed' ? { failed: window.demoState } : null)`;
const runsLength = () => evaluate('window.demoRuns.length');
const waitRun = (n, ms = 240000) => until(`(() => { const j = window.demoRuns[${n}]; return j && j.done ? j : null; })()`, ms);

// ---- the phone's state ----

function rest() {
  const status = Number(/Thermal Status: (\d+)/.exec(sh('dumpsys thermalservice | grep -m1 "Thermal Status"'))?.[1] ?? -1);
  const battery = Number(/temperature: (\d+)/.exec(sh('dumpsys battery | grep temperature'))?.[1] ?? 0) / 10;
  const caps = sh('for p in /sys/devices/system/cpu/cpufreq/policy*; do m=$(cat $p/scaling_max_freq); h=$(cat $p/cpuinfo_max_freq); [ "$m" = "$h" ] || echo "${p##*/} $m<$h"; done').trim();
  const kgsl = sh('cat /sys/class/kgsl/kgsl-3d0/thermal_pwrlevel 2>/dev/null').trim();
  return { status, battery, caps: caps || null, kgslLevel: kgsl === '' ? null : Number(kgsl), ok: status === 0 && battery <= 36.0 && !caps && (kgsl === '' || kgsl === '0') };
}
function airplane() {
  return { airplane: sh('settings get global airplane_mode_on').trim(), wifi: /Wifi is (enabled|disabled)/.exec(sh('cmd wifi status'))?.[1] ?? 'unknown' };
}

// ---- the picker: from the screen's UI tree, the taps that reach a file ----

// first the camera prompt Chrome raises for an image input ("only this time": nothing stays granted), then locations;
// English and Japanese labels (the phone's language)
const ONCE = ['Only this time', '今回のみ', 'Just once', 'JUST ONCE', 'Only once', '1 回のみ', '1回のみ'];
const NAV = {
  image: [...ONCE, 'Pictures', 'ピクチャ', 'Images', '画像', 'Files', 'ファイル', 'My Files', 'マイファイル', 'Browse', '参照', 'Show roots', 'ルートを表示', 'Recent', '最近'],
  pdf: [...ONCE, 'Downloads', 'ダウンロード', 'Download', 'Documents', 'ドキュメント', 'Files', 'ファイル', 'My Files', 'マイファイル', 'Browse', '参照', 'Show roots', 'ルートを表示', 'Recent', '最近'],
};
function findFile(nodes, name) {
  const stem = name.replace(/\.[^.]+$/, '');
  return nodes.find((n) => n.text === name || n.desc === name) ?? nodes.find((n) => n.text.startsWith(stem) || n.desc.includes(name));
}
/** In the picker: tap through the locations until the file shows; tap the file only when `choose`. */
async function reachFile(kind, name, tag, choose) {
  const steps = [];
  const used = new Set();
  for (let i = 0; i < 6; i++) {
    await sleep(700);
    const nodes = dump(`${tag}-${i}`);
    const pkg = nodes.find((n) => n.pkg)?.pkg ?? '';
    if (pkg === CHROME) return { ok: false, steps, why: 'the picker closed' };
    const file = findFile(nodes, name);
    if (file) {
      steps.push({ step: 'file', label: file.text || file.desc, pkg, at: center(file) });
      if (choose) tap(center(file), `file ${name}`);
      return { ok: true, steps };
    }
    const nav = NAV[kind].map((label) => nodes.find((n) => (n.text === label || n.desc === label) && !used.has(label))).find(Boolean);
    if (!nav) return { ok: false, steps, why: `no ${name} and no known location in the picker (${pkg})` };
    used.add(nav.text || nav.desc);
    steps.push({ step: 'location', label: nav.text || nav.desc, pkg, at: center(nav) });
    tap(center(nav), `picker ${nav.text || nav.desc}`);
  }
  return { ok: false, steps, why: 'too many steps' };
}
/** The file button on the screen: from the UI tree, else from the page's own box of it inside Chrome's web view. */
async function buttonAt() {
  const nodes = dump();
  const b = nodes.find((n) => n.text === 'Choose a photo or PDF' || n.desc === 'Choose a photo or PDF');
  if (b) return center(b);
  // Chrome keeps the page's elements out of the UI tree: the page's own box of the button, under Chrome's toolbar
  const holder = nodes.find((n) => n.id === `${CHROME}:id/compositor_view_holder`);
  const bar = nodes.find((n) => n.id === `${CHROME}:id/control_container`);
  const r = await evaluate(`(() => { const b = document.getElementById('pick-label').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, dpr: devicePixelRatio }; })()`);
  if (!holder || !r) return null;
  const top = bar && bar.box[1] <= holder.box[1] + 4 && bar.box[3] > holder.box[1] ? bar.box[3] : holder.box[1];
  return [Math.round(holder.box[0] + r.x * r.dpr), Math.round(top + r.y * r.dpr)];
}
async function closePicker() {
  for (let i = 0; i < 5; i++) {
    const f = focus();
    if (f.startsWith(CHROME)) return true;
    sh('input keyevent KEYCODE_BACK');
    await sleep(600);
  }
  return focus().startsWith(CHROME);
}

// ---- main ----

let recorder = null;
const pushed = [];
let air0 = null;
let wifiTurnedOff = false;
const devPhoto = `/sdcard/Pictures/${basename(PHOTO)}`;
const devPdf = `/sdcard/Download/${basename(PDF)}`;

async function main() {
  run.device = { model: sh('getprop ro.product.model').trim(), android: sh('getprop ro.build.version.release').trim(), size: sh('wm size').trim(), density: sh('wm density').trim() };
  const lock = sh('dumpsys window | grep -E "isKeyguardShowing|mShowingLockscreen"');
  if (/=true/.test(lock)) throw new Error('the phone is locked: unlock it first');
  if (REVERSE) adb('reverse', `tcp:${REVERSE}`, `tcp:${REVERSE}`);
  adb('forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote');
  // the files, newest in the media index
  for (const [local, dev] of [[PHOTO, devPhoto], [PDF, devPdf]]) {
    // never over a file that is already there (it would be removed at the end)
    if (sh(`[ -e "${dev}" ] && echo there || true`).trim() === 'there') throw new Error(`${dev} already exists on the phone`);
    adb('push', local, dev);
    sh(`touch "${dev}" && am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://${dev}" >/dev/null`);
    pushed.push(dev);
  }
  log('pushed', { files: pushed });

  // visit 1, online: the model into the cache
  sh(`am start -n ${CHROME}/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d "${URL0}"`);
  const t = await attachPage();
  run.chrome = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).Browser;
  let st = await until(readyExpr, 300000);
  if (!st || st.failed) throw new Error(`the page did not get ready: ${JSON.stringify(st ?? (await evaluate('window.demoState')))}`);
  run.visit1 = { info: st.info, isolated: st.isolated, bytes: st.bytes, notes: st.notes, converterMs: st.converterMs, tab: t.id };
  log('visit 1 ready', { threads: st.info.threads, detector: st.info.detector, network: st.bytes.network });

  // airplane mode, then the page again from the caches
  if (AIRPLANE) {
    air0 = airplane();
    sh('cmd connectivity airplane-mode enable');
    let a = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      a = airplane();
      if (a.airplane === '1' && a.wifi === 'disabled') break;
    }
    if (a.wifi !== 'disabled') {
      sh('svc wifi disable');
      wifiTurnedOff = true;
      await sleep(1500);
      a = airplane();
    }
    const ping = (() => { try { sh('ping -c 1 -W 2 8.8.8.8'); return 'answered'; } catch { return 'no answer'; } })();
    const network = sh('dumpsys connectivity | grep -m1 "Active default network"').trim();
    run.airplane = { before: air0, during: a, ping, network, wifiTurnedOff };
    log('airplane mode', run.airplane);
    check('airplane mode on, Wi-Fi off, no network', a.airplane === '1' && a.wifi === 'disabled' && ping === 'no answer' && /none/i.test(network), run.airplane);
  }
  // the page of visit 1 stays open (Ready, the model in memory); the network goes away under it
  st = await evaluate('window.demoState');
  run.visit2 = { info: st.info, isolated: st.isolated, bytes: st.bytes, notes: st.notes, onLine: await evaluate('navigator.onLine'), crossOriginIsolated: await evaluate('self.crossOriginIsolated'), same: 'the page of visit 1, not opened again' };
  log('page kept from visit 1', { onLine: run.visit2.onLine, crossOriginIsolated: run.visit2.crossOriginIsolated, threads: st.info?.threads });
  run.wakeLock = await evaluate(`navigator.wakeLock ? navigator.wakeLock.request('screen').then(() => 'held', (e) => 'refused: ' + e.message) : 'no API'`, { userGesture: true });

  // scout the picker for both files without choosing
  const button0 = await buttonAt();
  if (!button0) throw new Error('the file button is not in the screen\'s UI tree');
  run.button = button0;
  for (const [kind, name] of [['image', basename(PHOTO)], ['pdf', basename(PDF)]]) {
    tap(button0, `button (scout ${kind})`);
    const picker = await waitFocus((f) => !f.startsWith(CHROME), 8000);
    const r = await reachFile(kind, name, `scout-${kind}`, false);
    screenshot(`scout-${kind}.png`);
    const back = await closePicker();
    run[`scout_${kind}`] = { picker, ...r, backInChrome: back };
    log(`scout ${kind}`, run[`scout_${kind}`]);
    if (!r.ok || !back) throw new Error(`scout ${kind}: ${r.why ?? 'could not return to Chrome'}`);
  }
  check('scouting read no file', (await runsLength()) === 0);
  save();
  if (SCOUT_ONLY) return;

  // a rested phone
  const t0 = Date.now();
  let r = rest();
  while (!r.ok && Date.now() - t0 < REST_MAX) {
    log('waiting for a rested phone', r);
    await sleep(10000);
    r = rest();
  }
  run.restAtTake = { ...r, waitedMs: Date.now() - t0 };
  if (!r.ok) throw new Error(`the phone did not rest in ${REST_MAX / 1000} s: ${JSON.stringify(r)}`);
  await evaluate('window.scrollTo(0, 0)');
  await sleep(800);
  screenshot('take-ready.png');
  const sb = statusBar();

  // the take
  const dev = `/sdcard/Movies/litert-ocr-take.mp4`;
  sh(`rm -f ${dev}`);
  recorder = spawn('adb', ['-s', SERIAL, 'shell', 'screenrecord', '--bit-rate', '16000000', '--time-limit', '170', dev], { stdio: 'ignore' });
  const recStart = now();
  log('recording', { device: recStart });
  await sleep(1500);
  for (const [kind, path] of [['image', PHOTO], ['pdf', PDF]]) {
    const name = basename(path);
    if (kind === 'pdf') {
      // back to the top, as a finger does, then the button where it is now
      const [w, h] = (/(\d+)x(\d+)/.exec(run.device.size) ?? [0, 1080, 2340]).slice(1).map(Number);
      sh(`input swipe ${Math.round(w / 2)} ${Math.round(h * 0.35)} ${Math.round(w / 2)} ${Math.round(h * 0.85)} 250`);
      await sleep(700);
    }
    const at = kind === 'image' ? button0 : ((await buttonAt()) ?? button0);
    const n = await runsLength();
    const tapButton = now();
    tap(at, `button (${kind})`);
    await waitFocus((f) => !f.startsWith(CHROME), 8000);
    const pick = await reachFile(kind, name, `take-${kind}`, true);
    const tapFile = now();
    if (!pick.ok) throw new Error(`take ${kind}: ${pick.why}`);
    const job = await waitRun(n);
    const shown = await evaluate(`({ took: document.getElementById('took').textContent, detail: document.getElementById('took-detail').textContent })`);
    run.screens.push({ kind, file: name, tapButton, tapFile, startedAt: job?.startedAt, endedAt: job?.endedAt, screenMs: job?.ms, lines: job?.lines ?? null, markdown: job?.markdown ?? null, text: job?.text ?? null, error: job?.error ?? null, shown, rest: rest() });
    log(`result ${kind}`, { screenMs: job?.ms, lines: job?.lines?.length, shown });
    await sleep(HOLD_MS);
  }
  sh('pkill -INT screenrecord');
  await new Promise((res) => recorder.on('exit', res));
  recorder = null;
  run.recording = { device: dev, start: recStart, end: now(), statusBar: sb };
  adb('pull', dev, join(OUT, 'take-raw.mp4'));
  sh(`rm -f ${dev}`);
  screenshot('take-end.png');
  save();

  await restoreAirplane();

  // failure paths and the next file, dropped on the page
  if (FAILURES) {
    const drop = async (url, name) => {
      const n = await runsLength();
      await evaluate(`(async () => { const b = await (await fetch(${JSON.stringify(url)})).blob(); const dt = new DataTransfer(); dt.items.add(new File([b], ${JSON.stringify(name)}, { type: b.type })); document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
      return waitRun(n);
    };
    const visible = () => evaluate(`({ errorTitle: document.getElementById('error').hidden ? null : document.getElementById('error-title').textContent, notes: [...document.querySelectorAll('.result-note')].map((e) => e.textContent), passwordField: !document.getElementById('password-form').hidden, empty: document.getElementById('pane-text').textContent.includes('No text was found') })`);
    const base = new URL(FAILURES.replace(/\/?$/, '/'), URL0).href;
    for (const name of ['notes.txt', 'broken.png', 'blank.jpg', 'broken.pdf', 'long.pdf', 'locked.pdf']) {
      const job = await drop(base + name, name);
      const v = await visible();
      run.failures.push({ file: name, error: job?.error ?? null, notes: job?.notes ?? [], partial: job?.partial ?? false, pages: job?.pages ?? null, lines: job?.lines?.length ?? null, visible: v });
      if (name === 'locked.pdf') {
        for (const pw of ['not-it', 'demo']) {
          const n = await runsLength();
          await evaluate(`(() => { document.getElementById('password').value = ${JSON.stringify(pw)}; document.getElementById('password-form').requestSubmit(); return true; })()`);
          const j = await waitRun(n);
          run.failures.push({ file: `${name} (${pw === 'demo' ? 'right' : 'wrong'} password)`, error: j?.error ?? null, lines: j?.lines?.length ?? null, visible: await visible() });
        }
      }
      const next = await drop(new URL('examples/receipt.jpg', URL0).href, 'receipt.jpg');
      run.failures.push({ file: `after ${name}: receipt.jpg`, error: next?.error ?? null, lines: next?.lines?.length ?? null });
    }
    log('failure paths', { cases: run.failures.length });
  }

  // the page opened again with airplane mode on: what it says (recorded, not a condition of the take)
  if (AIRPLANE && REOPEN) {
    air0 = airplane();
    sh('cmd connectivity airplane-mode enable');
    for (let i = 0; i < 40; i++) { await sleep(250); const a = airplane(); if (a.airplane === '1' && a.wifi === 'disabled') break; }
    await page.send('Page.reload', { ignoreCache: false });
    await sleep(1500);
    const again = await until(readyExpr, 60000);
    run.reopenOffline = {
      airplane: airplane(),
      state: again ?? (await evaluate('window.demoState')),
      controller: await evaluate('!!navigator.serviceWorker?.controller'),
      crossOriginIsolated: await evaluate('self.crossOriginIsolated'),
      navigation: await evaluate('(() => { const n = performance.getEntriesByType("navigation")[0]; return n ? { type: n.type, workerStart: n.workerStart, deliveryType: n.deliveryType ?? null, transferSize: n.transferSize } : null; })()'),
    };
    log('reopen offline', { ready: !!again && !again.failed, controller: run.reopenOffline.controller, crossOriginIsolated: run.reopenOffline.crossOriginIsolated, navigation: run.reopenOffline.navigation });
    await restoreAirplane();
  }
}

async function restoreAirplane() {
  if (!air0) return;
  const before = air0;
  air0 = null;
  if (before.airplane !== '1') sh('cmd connectivity airplane-mode disable');
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const a = airplane();
    if (a.airplane === before.airplane && (a.wifi === before.wifi || i > 30)) break;
  }
  let a = airplane();
  if (a.wifi !== before.wifi) {
    sh(`svc wifi ${before.wifi === 'enabled' ? 'enable' : 'disable'}`);
    await sleep(2000);
    a = airplane();
  }
  (run.airplaneRestores ??= []).push({ before, after: a, at: new Date().toISOString() });
  log('airplane mode back', { before, after: a });
}

/** Height of the status bar, from the top of Chrome's window in the UI tree; its colour from the screenshot. */
function statusBar() {
  const nodes = dump('take-ready');
  const top = Math.min(...nodes.filter((n) => n.pkg === CHROME && n.box[1] > 0).map((n) => n.box[1]));
  const png = PNG.sync.read(readFileSync(join(OUT, 'take-ready.png')));
  const y = Math.max(0, Math.round(top / 2));
  const i = (png.width * y + Math.round(png.width / 2) - 4) * 4;
  const hex = [png.data[i], png.data[i + 1], png.data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  return { height: Number.isFinite(top) ? top : 0, color: `0x${hex}`, width: png.width, screenHeight: png.height };
}

async function cleanup() {
  const done = {};
  try { if (recorder) { sh('pkill -INT screenrecord'); await sleep(1500); } } catch (e) { done.recorder = e.message; }
  try {
    if (page) {
      done.pageReset = await evaluate(`(async () => { const k = await caches.keys(); await Promise.all(k.map((x) => caches.delete(x))); const r = await navigator.serviceWorker.getRegistrations(); await Promise.all(r.map((x) => x.unregister())); return { caches: k, serviceWorkers: r.length }; })()`);
      page.close();
    }
    if (targetId) await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${targetId}`).catch(() => {});
  } catch (e) { done.page = e.message; }
  try {
    await restoreAirplane();
    done.airplane = airplane();
  } catch (e) { done.airplaneError = e.message; }
  try {
    for (const f of pushed) sh(`rm -f "${f}" && am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://${f}" >/dev/null`);
    done.removed = pushed;
  } catch (e) { done.files = e.message; }
  try { adb('forward', '--remove', `tcp:${CDP_PORT}`); } catch { /* not set */ }
  try { if (REVERSE) adb('reverse', '--remove', `tcp:${REVERSE}`); } catch { /* not set */ }
  run.cleanup = done;
  log('cleanup', done);
}

/** The cut: 30 fps, from 1 s before the first tap to the last result + hold, the driver's waits shortened to 1.5 s
 * (never inside choosing a file -> its result -> hold), the left half of the status bar painted. */
function cut() {
  const raw = join(OUT, 'take-raw.mp4');
  const frames = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', raw], { encoding: 'utf8' }).trim().split('\n').map(Number).filter(Number.isFinite);
  const t0 = run.recording.start;
  const at = (dev) => (dev - t0) / 1000;
  const keep = run.screens.map((s) => [at(s.tapFile) - 0.3, at(s.endedAt) + HOLD_MS / 1000]);
  const start = Math.max(0, at(run.screens[0].tapButton) - 1.0);
  const end = Math.min(frames.at(-1) ?? 0, at(run.screens.at(-1).endedAt) + HOLD_MS / 1000);
  // the screen is still between two frames; the part of a still gap outside `keep` is the driver waiting: longer than
  // 1.5 s, it is cut to 1.5 s
  const removed = [];
  for (let i = 0; i + 1 < frames.length; i++) {
    let pieces = [[Math.max(frames[i], start), Math.min(frames[i + 1], end)]];
    for (const [k0, k1] of keep) pieces = pieces.flatMap(([a, b]) => (b <= k0 || a >= k1 ? [[a, b]] : [[a, Math.min(b, k0)], [Math.max(a, k1), b]].filter(([x, y]) => y > x)));
    for (const [a, b] of pieces) if (b - a > 1.5) removed.push([a + 1.5, b]);
  }
  const segs = [];
  let s0 = start;
  for (const [a, b] of removed.sort((x, y) => x[0] - y[0])) {
    if (a > s0) segs.push([s0, a]);
    s0 = Math.max(s0, b);
  }
  if (end > s0) segs.push([s0, end]);
  const sb = run.recording.statusBar;
  const paint = sb.height > 0 ? `,drawbox=x=0:y=0:w=${Math.floor(sb.width / 2)}:h=${sb.height}:color=${sb.color}:t=fill` : '';
  const split = `[0:v]fps=30:round=up,split=${segs.length}${segs.map((_, i) => `[s${i}]`).join('')}`;
  const parts = segs.map(([a, b], i) => `[s${i}]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`).join(';');
  const filter = `${split};${parts};${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1[c];[c]format=yuv420p${paint}[out]`;
  const mp4 = join(OUT, 'take.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-filter_complex', filter, '-map', '[out]', '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', '-an', mp4]);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames:format=duration', '-of', 'json', mp4], { encoding: 'utf8' }));
  run.cut = { segments: segs, keep, start, end, mp4, probe, rawFrames: frames.length };
  log('cut', { segments: segs.length, duration: probe.format.duration });
}

if (CUT_ONLY) {
  cut();
  save();
  process.exit(0);
}

let failed = null;
try {
  await main();
} catch (e) {
  failed = e;
  run.error = e.message;
  log('stopped', { error: e.message });
} finally {
  await cleanup();
  save();
}
if (!failed && !SCOUT_ONLY && run.recording) {
  try { cut(); } catch (e) { run.cutError = e.message; }
  save();
}
console.log(`${failed ? 'STOPPED: ' + failed.message : 'done'} -> ${join(OUT, 'run.json')}`);
process.exit(failed ? 1 : 0);
