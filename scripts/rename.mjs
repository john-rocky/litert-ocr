// Rename the package everywhere at once: the npm name, the command, the CDN and GitHub URLs, the import specifiers,
// the cache names and the docs. The current name and repository are read from package.json (name, repository.url).
//   node scripts/rename.mjs <npm name> [--repo <owner>/<name>] [--dry-run]
// The command (bin), the cache directory and the other labels take the name without its npm scope; --repo defaults
// to the current GitHub owner and that name. --dry-run lists the files and the replacements without writing. After a
// rename the script prints `git diff --stat`; then run `npm run build && npm test`.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const DRY = args.includes('--dry-run');
const NEW = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--repo');
if (!NEW) {
  console.error('usage: node scripts/rename.mjs <npm name> [--repo <owner>/<name>] [--dry-run]');
  process.exit(1);
}
// npm's rules: lower case, URL-safe, at most 214 characters, an optional @scope/
if (!/^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(NEW) || NEW.length > 214) {
  console.error(`"${NEW}" is not a valid npm package name (lower case letters, digits, - . _ ~, optionally @scope/name).`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const OLD = pkg.name;
const oldRepo = /github\.com\/([^/]+)\/([^/.#]+)/.exec(pkg.repository?.url ?? '');
if (!oldRepo) {
  console.error('package.json has no repository.url on github.com to rename.');
  process.exit(1);
}
const [, OWNER, OLD_REPO_NAME] = oldRepo;
const bare = (n) => n.replace(/^@[^/]+\//, '');
const env = (n) => bare(n).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const tgz = (n) => n.replace(/^@/, '').replace('/', '-');
const OLD_BARE = bare(OLD), NEW_BARE = bare(NEW);
const NEW_REPO = opt('--repo') ?? `${OWNER}/${NEW_BARE}`;
if (!/^[\w.-]+\/[\w.-]+$/.test(NEW_REPO)) {
  console.error(`--repo must be <owner>/<name>, got "${NEW_REPO}".`);
  process.exit(1);
}
if (NEW === OLD && NEW_REPO === `${OWNER}/${OLD_REPO_NAME}` && !DRY) {
  console.log(`The package is already named ${OLD} (repository ${NEW_REPO}); nothing to do.`);
  process.exit(0);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const O = esc(OLD), OB = esc(OLD_BARE);
// Ordered rules. Each match becomes a placeholder first, so a new name that contains the old one is never
// replaced twice; the placeholders become the new text at the end.
const RULES = [
  ['GitHub URL', new RegExp(`(github\\.com|raw\\.githubusercontent\\.com)/${esc(OWNER)}/${esc(OLD_REPO_NAME)}(?![\\w-])`, 'g'), (m, host) => `${host}/${NEW_REPO}`],
  ['checkout path', new RegExp(`/path/to/${esc(OLD_REPO_NAME)}/`, 'g'), () => `/path/to/${NEW_REPO.split('/')[1]}/`],
  ['CDN URL', new RegExp(`cdn\\.jsdelivr\\.net/npm/${O}@`, 'g'), () => `cdn.jsdelivr.net/npm/${NEW}@`],
  ['node_modules path', new RegExp(`node_modules/${O}/`, 'g'), () => `node_modules/${NEW}/`],
  ['npx package', new RegExp(`npx (-y )?${O}(?![\\w./-])`, 'g'), (m, y) => `npx ${y ?? ''}${NEW}`],
  ['packed tarball', new RegExp(`${esc(tgz(OLD))}-(\\d+\\.\\d+\\.\\d+)\\.tgz`, 'g'), (m, v) => `${tgz(NEW)}-${v}.tgz`],
  ['bin name', new RegExp(`("bin":\\s*\\{\\s*")${OB}(")`, 'g'), (m, a, b) => `${a}${NEW_BARE}${b}`],
  ['MCP server key', new RegExp(`"${OB}"(:\\s*\\{)`, 'g'), (m, rest) => `"${NEW_BARE}"${rest}`],
  ['module specifier', new RegExp(`(['"])${O}(/extract)?\\1`, 'g'), (m, q, sub) => `${q}${NEW}${sub ?? ''}${q}`],
  ['subpath in text', new RegExp(`${O}/extract`, 'g'), () => `${NEW}/extract`],
  ['environment variable', new RegExp(`\\b${esc(env(OLD))}_`, 'g'), () => `${env(NEW)}_`],
  ['name', new RegExp(OB, 'g'), () => NEW_BARE],
];

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
const BINARY = /\.(png|jpe?g|gif|webp|pdf|tflite|wasm|ico|zip)$/i;
const report = [];
for (const f of files) {
  if (BINARY.test(f) || f === 'scripts/rename.mjs') continue;
  const path = join(ROOT, f);
  // regular files only (a tracked symlink, or a submodule, is left alone)
  let st;
  try { st = lstatSync(path); } catch { continue; }
  if (!st.isFile()) continue;
  const before = readFileSync(path, 'utf8');
  if (before.includes('\0')) continue;
  const hold = [];
  const counts = {};
  let text = before;
  for (const [label, re, to] of RULES) {
    text = text.replace(re, (...m) => {
      counts[label] = (counts[label] ?? 0) + 1;
      hold.push(to(...m));
      return `\u0000${hold.length - 1}\u0000`;
    });
  }
  if (!hold.length) continue;
  const after = text.replace(/\u0000(\d+)\u0000/g, (m, i) => hold[Number(i)]);
  report.push({ file: f, n: hold.length, counts, changed: after !== before });
  if (!DRY && after !== before) {
    writeFileSync(`${path}.rename-tmp`, after);
    renameSync(`${path}.rename-tmp`, path);
  }
}

console.log(`${DRY ? 'Dry run: ' : ''}${OLD} -> ${NEW} (command, cache and labels: ${NEW_BARE}; GitHub: ${OWNER}/${OLD_REPO_NAME} -> ${NEW_REPO}; environment: ${env(OLD)}_ -> ${env(NEW)}_)`);
for (const r of report) console.log(`  ${r.file}: ${r.n} (${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', ')})`);
console.log(`${report.length} files, ${report.reduce((s, r) => s + r.n, 0)} replacements${DRY ? ' (nothing written)' : ''}.`);
if (!DRY) {
  try {
    console.log('\n' + execFileSync('git', ['diff', '--stat'], { cwd: ROOT, encoding: 'utf8' }));
  } catch { /* not a git checkout */ }
  console.log('Next: npm install && npm run build && npm test (the cache directory and the Cache API names changed: the models download once more).');
}
