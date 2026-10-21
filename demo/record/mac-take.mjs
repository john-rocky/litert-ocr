// A take of the demo page in desktop Chrome: the page alone (headless Chrome, 1440 x 900; nothing else on the screen
// is filmed), driven like a person: the file button, the browser's file chooser, a photo; then the button again and a
// scanned PDF. The page is visited once first (the model goes into the cache), then opened again and filmed from Ready.
//   1. rehearsal: screenshots of Ready and of both results (ready.png, screen1.png, screen2.png; the same in a
//      390 x 844 page, the layout of a phone: phone-ready.png, phone-screen1.png, phone-screen2.png) and a run JSON
//   2. with --go FILE: waits for FILE to appear (someone looked at the screenshots; FILE.no = do not film), then films
//      the same two screens with the DevTools screencast and makes take.mp4 (H.264, 30 fps constant, ffmpeg)
// usage: node demo/record/mac-take.mjs --out DIR [--go FILE] [--go-timeout 300] [--photo examples/receipt.jpg]
//        [--pdf examples/inventory-scan.pdf] [--port 8091] [--chrome PATH] [--url URL] (a page served elsewhere)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

const DEMO = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const OUT = opt('--out', join(DEMO, 'record/out/mac-take'));
const GO = opt('--go', null);
const GO_TIMEOUT = Number(opt('--go-timeout', 300)) * 1000;
const PHOTO = join(DEMO, opt('--photo', 'examples/receipt.jpg'));
const PDF = join(DEMO, opt('--pdf', 'examples/inventory-scan.pdf'));
const PORT = Number(opt('--port', 8091));
const CHROME = opt('--chrome', null);
const URL_GIVEN = opt('--url', null);
const VIEW = { width: 1440, height: 900 };
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = { when: new Date().toISOString(), viewport: VIEW, rehearsal: null, take: null };

const server = URL_GIVEN ? { close: async () => {} } : await startServer({ port: PORT });
const url = URL_GIVEN ?? `http://localhost:${server.port}/`;
const profile = mkdtempSync(join(tmpdir(), 'litert-ocr-demo-take-'));
const context = await chromium.launchPersistentContext(profile, {
  ...(CHROME ? { executablePath: CHROME } : { channel: 'chrome' }),
  headless: true,
  viewport: VIEW,
  deviceScaleFactor: 1,
  args: ['--mute-audio'],
});
run.chrome = context.browser()?.version() ?? null;

async function ready(page) {
  await page.goto(url);
  await page.waitForFunction(() => window.demoState?.phase === 'ready' && ['ready', 'failed'].includes(window.demoState?.converter), null, { timeout: 240000 });
  return page.evaluate(() => window.demoState);
}
async function pick(page, path) {
  const n = await page.evaluate(() => window.demoRuns.length);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#pick-label')]);
  await chooser.setFiles(path);
  await page.waitForFunction((k) => window.demoRuns.length > k && window.demoRuns[k].done, n, { timeout: 240000 });
  return page.evaluate((k) => window.demoRuns[k], n);
}
const shown = (page) => page.evaluate(() => ({ took: document.getElementById('took').textContent, detail: document.getElementById('took-detail').textContent, status: document.getElementById('status-text').textContent, info: document.getElementById('detail').textContent }));
const summary = (job, screen) => ({ file: job.name, api: job.api, screenMs: job.ms, lines: job.lines?.length ?? null, error: job.error ?? null, shown: screen });

// visit 1: the model and the runtime into the cache
let page = await context.newPage();
const first = await ready(page);
run.firstVisit = { info: first.info, bytes: first.bytes, isolated: first.isolated };
await page.close();

// rehearsal: the two screens with screenshots
page = await context.newPage();
let state = await ready(page);
await page.screenshot({ path: join(OUT, 'ready.png') });
const r1 = await pick(page, PHOTO);
await sleep(500);
await page.screenshot({ path: join(OUT, 'screen1.png') });
const s1 = await shown(page);
const r2 = await pick(page, PDF);
await sleep(500);
await page.screenshot({ path: join(OUT, 'screen2.png') });
run.rehearsal = { info: state.info, isolated: state.isolated, screens: [summary(r1, s1), summary(r2, await shown(page))] };
await page.close();

// the same two results in a phone-sized page (390 x 844 CSS pixels): the layout a phone shows
page = await context.newPage();
await page.setViewportSize({ width: 390, height: 844 });
await ready(page);
await page.screenshot({ path: join(OUT, 'phone-ready.png') });
const p1 = await pick(page, PHOTO);
await sleep(500);
await page.screenshot({ path: join(OUT, 'phone-screen1.png') });
const ps1 = await shown(page);
const p2 = await pick(page, PDF);
await sleep(500);
await page.screenshot({ path: join(OUT, 'phone-screen2.png') });
run.rehearsal.phone = [summary(p1, ps1), summary(p2, await shown(page))];
await page.close();
writeFileSync(join(OUT, 'run.json'), JSON.stringify(run, null, 2));
console.log(`rehearsal: ${JSON.stringify(run.rehearsal.screens.map((s) => [s.file, Math.round(s.screenMs), s.lines]))}; screenshots in ${OUT}`);
writeFileSync(join(OUT, 'rehearsal.done'), new Date().toISOString());

// the take, after someone looked at the screenshots
if (GO) {
  const t = Date.now();
  while (!existsSync(GO) && !existsSync(`${GO}.no`) && Date.now() - t < GO_TIMEOUT) await sleep(1000);
  if (!existsSync(GO)) {
    run.take = { skipped: existsSync(`${GO}.no`) ? 'not approved' : `no answer in ${GO_TIMEOUT / 1000} s` };
  } else {
    page = await context.newPage();
    state = await ready(page);
    const cdp = await context.newCDPSession(page);
    const frames = [];
    const dir = join(OUT, 'frames');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cdp.on('Page.screencastFrame', async (f) => {
      const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
      frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
      writeFileSync(file, Buffer.from(f.data, 'base64'));
      await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 });
    const marks = { start: Date.now() / 1000 };
    await sleep(1500);
    marks.pick1 = Date.now() / 1000;
    const t1 = await pick(page, PHOTO);
    marks.result1 = Date.now() / 1000;
    await sleep(4000);
    const v1 = await shown(page);
    marks.pick2 = Date.now() / 1000;
    const t2 = await pick(page, PDF);
    marks.result2 = Date.now() / 1000;
    await sleep(5000);
    const v2 = await shown(page);
    await cdp.send('Page.stopScreencast');
    marks.end = Date.now() / 1000;
    await page.screenshot({ path: join(OUT, 'take-end.png') });
    // constant 30 fps from the frames' own times: each frame lasts until the next one, the last until the end
    const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? marks.end) - f.t).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
    writeFileSync(join(OUT, 'frames.txt'), list);
    const mp4 = join(OUT, 'take.mp4');
    // the concat demuxer needs the last image listed twice and then shows it too long: cut at the filmed span
    const span = (marks.end - frames[0].t).toFixed(3);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(OUT, 'frames.txt'), '-vf', 'fps=30,format=yuv420p', '-t', span, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', mp4]);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames:format=duration', '-of', 'json', mp4]).toString());
    run.take = { info: state.info, screens: [summary(t1, v1), summary(t2, v2)], frames: frames.length, marks, firstFrame: frames[0]?.t, mp4, probe };
    console.log(`take: ${JSON.stringify(run.take.screens.map((s) => [s.file, Math.round(s.screenMs), s.lines]))}, ${frames.length} frames, ${probe.format.duration} s -> ${mp4}`);
    await page.close();
  }
}

await context.close();
await server.close();
rmSync(profile, { recursive: true, force: true });
writeFileSync(join(OUT, 'run.json'), JSON.stringify(run, null, 2));
process.exit(0);
