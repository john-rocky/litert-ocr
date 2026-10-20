// The litert-ocr command: PDFs and images -> Markdown, JSON or text on this machine, and `litert-ocr mcp`, an MCP
// server over stdio for coding agents.
//   litert-ocr <file...> [--md | --json | --text] [--pages 1-3] [--engine auto|layer|ocr] [--layout auto|model|geometry]
//              [--out DIR] [--timings] [--password P] [--max-pages N] [--model-base DIR] [--layout-model-base DIR] [--quiet]
//   litert-ocr mcp [--allow-http] [--model-base DIR] [--layout-model-base DIR]
// Exit code: 0 = every page of every file read, 2 = an input could not be read, 3 = some page came back empty or
// failed (named in the JSON pages[].status), 1 = a usage error.

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { createConverter, OcrError, type ConvertOptions, type ConverterOptions } from 'litert-ocr';

const VERSION = '0.1.0';

const HELP = `litert-ocr ${VERSION}: PDFs, scans and photos -> Markdown (with tables), JSON or text, on this machine.

usage: litert-ocr <file...> [options]
       litert-ocr mcp [--allow-http] [--model-base DIR] [--layout-model-base DIR]

  --md | --json | --text   output format (default --md)
  --pages 1-3              pages to read: 1-3, 1,4,7-9, 5- (default: all)
  --engine auto|layer|ocr  auto: PDF text layer where a page has one, OCR elsewhere (default)
  --layout auto|model|geometry
                           how OCR pages are cut into blocks (default auto: the layout model when available)
  --out DIR                write <name>.md / .json / .txt into DIR instead of stdout
  --timings                per-page milliseconds and downloaded bytes on stderr
  --password P             password of an encrypted PDF
  --max-pages N            refuse documents with more selected pages (default 100)
  --model-base DIR         OCR model files from DIR instead of Hugging Face
  --layout-model-base DIR  layout model files from DIR (needed while the layout model is not published)
  --quiet                  no progress notes on stderr

Files never leave the machine; the models download once into ~/.cache/litert-ocr.
Exit code: 0 all pages read, 2 an input could not be read, 3 some pages empty or failed.`;

interface Args {
  files: string[];
  to: ConvertOptions['to'];
  pages?: string;
  engine?: ConvertOptions['engine'];
  layout?: ConvertOptions['layout'];
  out?: string;
  timings: boolean;
  password?: string;
  maxPages?: number;
  modelBase?: string;
  layoutModelBase?: string;
  quiet: boolean;
  allowHttp: boolean;
}

function parse(argv: string[]): Args {
  const a: Args = { files: [], to: 'md', timings: false, quiet: false, allowHttp: false };
  const need = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Usage(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const eq = t.indexOf('=');
    const [flag, inline] = t.startsWith('--') && eq > 0 ? [t.slice(0, eq), t.slice(eq + 1)] : [t, undefined];
    const val = () => (inline !== undefined ? inline : need(i++, flag));
    switch (flag) {
      case '--md': a.to = 'md'; break;
      case '--json': a.to = 'json'; break;
      case '--text': a.to = 'text'; break;
      case '--pages': a.pages = val(); break;
      case '--engine': a.engine = oneOf(val(), ['auto', 'layer', 'ocr'], flag) as Args['engine']; break;
      case '--layout': a.layout = oneOf(val(), ['auto', 'model', 'geometry'], flag) as Args['layout']; break;
      case '--out': a.out = val(); break;
      case '--timings': a.timings = true; break;
      case '--password': a.password = val(); break;
      case '--max-pages': {
        const v = Number(val());
        if (!Number.isInteger(v) || v < 1) throw new Usage('--max-pages needs a whole number of at least 1.');
        a.maxPages = v;
        break;
      }
      case '--model-base': a.modelBase = resolve(val()); break;
      case '--layout-model-base': a.layoutModelBase = resolve(val()); break;
      case '--quiet': a.quiet = true; break;
      case '--allow-http': a.allowHttp = true; break;
      default:
        if (t.startsWith('--')) throw new Usage(`Unknown option ${t}.`);
        a.files.push(t);
    }
  }
  return a;
}

class Usage extends Error {}

function oneOf(v: string, list: string[], flag: string): string {
  if (!list.includes(v)) throw new Usage(`${flag} must be one of ${list.join(', ')} (got ${v}).`);
  return v;
}

export function converterOptions(a: Pick<Args, 'modelBase' | 'layoutModelBase' | 'layout' | 'maxPages' | 'quiet' | 'timings'>, onLog?: (line: string) => void): Partial<ConverterOptions> {
  const o: Partial<ConverterOptions> = {};
  if (a.modelBase) o.modelBase = a.modelBase;
  if (a.layoutModelBase) o.layoutModelBase = a.layoutModelBase;
  if (a.layout) o.layout = a.layout;
  if (a.maxPages) o.maxPages = a.maxPages;
  const seen = new Set<string>();
  o.logger = (m) => {
    if (m.status === 'notice' && m.message && !seen.has(m.message)) {
      seen.add(m.message);
      if (!a.quiet) onLog?.(`note: ${m.message}`);
    }
    if (m.status === 'loading model' || m.status === 'loading layout model') {
      if (m.progress === 1 && m.file && !seen.has(`${m.status}:${m.file}`)) {
        seen.add(`${m.status}:${m.file}`);
        if (a.timings && !a.quiet) onLog?.(`${m.status}: ${m.loaded ?? 0} bytes${m.fromCache ? ' (cache)' : ''}`);
      }
    }
  };
  return o;
}

async function main(argv: string[]): Promise<number> {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP);
    return argv.length ? 0 : 1;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(VERSION);
    return 0;
  }
  if (argv[0] === 'mcp') {
    const a = parse(argv.slice(1));
    const { runMcp } = await import('./mcp.js');
    await runMcp({ allowHttp: a.allowHttp, converter: converterOptions({ ...a, quiet: true }) });
    return 0;
  }
  let a: Args;
  try {
    a = parse(argv);
  } catch (e) {
    if (e instanceof Usage) {
      console.error(`litert-ocr: ${e.message}\n\n${HELP}`);
      return 1;
    }
    throw e;
  }
  if (!a.files.length) {
    console.error(`litert-ocr: no input file.\n\n${HELP}`);
    return 1;
  }
  if (a.out) mkdirSync(a.out, { recursive: true });
  const err = (s: string) => process.stderr.write(s + '\n');
  const converter = createConverter(converterOptions(a, err));
  let code = 0;
  const ext = a.to === 'json' ? '.json' : a.to === 'text' ? '.txt' : '.md';
  try {
    for (const file of a.files) {
      const t0 = performance.now();
      try {
        const o: Partial<ConvertOptions> = { to: a.to };
        if (a.pages) o.pages = a.pages;
        if (a.engine) o.engine = a.engine;
        if (a.password !== undefined) o.password = a.password;
        const r = await converter.convert(file, o);
        const bad = r.document.pages.filter((p) => p.status !== 'ok');
        if (bad.length) code = Math.max(code, 3);
        if (a.out) {
          const outFile = join(a.out, basename(file, extname(file)) + ext);
          writeFileSync(outFile, r.content.endsWith('\n') || !r.content ? r.content : r.content + '\n');
          if (!a.quiet) err(`${file} -> ${outFile}`);
        } else {
          process.stdout.write(r.content.endsWith('\n') || !r.content ? r.content : r.content + '\n');
        }
        for (const p of bad) err(`${file}: page ${p.page} ${p.status}: ${p.reason}`);
        if (a.timings) {
          for (const p of r.document.pages) err(`timing ${file} page ${p.page} ${p.engine ?? '-'}${p.layout ? `/${p.layout.used}${p.layout.backend ? ':' + p.layout.backend : ''}` : ''} ${p.ms.toFixed(1)} ms ${p.status}`);
          err(`timing ${file} total ${(performance.now() - t0).toFixed(1)} ms`);
        }
      } catch (e) {
        code = 2;
        const c = e instanceof OcrError ? ` [${e.code}]` : '';
        err(`litert-ocr: ${file}: ${(e as Error)?.message ?? e}${c}`);
        // an error of the setup (models, runtime) would repeat for every file
        if (e instanceof OcrError && ['MODEL_FETCH_FAILED', 'MODEL_SHA256_MISMATCH', 'RUNTIME_LOAD_FAILED', 'WORKER_START_FAILED'].includes(e.code)) break;
      }
    }
  } finally {
    await converter.terminate();
  }
  return code;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // a handle left open by a dependency must not keep the command running (the timer itself does not)
    setTimeout(() => process.exit(code), 3000).unref();
  },
  (e) => {
    process.stderr.write(`litert-ocr: ${(e as Error)?.stack ?? e}\n`);
    process.exitCode = 2;
    setTimeout(() => process.exit(2), 3000).unref();
  },
);
