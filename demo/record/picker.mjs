// The phone's file picker, read from its UI tree (uiautomator dump): which node to tap next to reach a file.
// Pure functions, so the steps can be checked against saved dumps without a phone (android-take.mjs uses them).
// Labels in English and Japanese (the phone's language). A file's preview icon also carries its name; it is never
// the node tapped to choose the file (that opens a preview).

/** Nodes of a uiautomator dump: text, content-desc, resource-id, class, package, clickable, bounds. */
export function parseDump(xml) {
  return [...xml.matchAll(/<node ([^>]*?)\/?>/g)].map((m) => {
    const a = {};
    for (const [, k, v] of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[k] = v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds ?? '');
    return { text: a.text ?? '', desc: a['content-desc'] ?? '', id: a['resource-id'] ?? '', cls: a.class ?? '', pkg: a.package ?? '', clickable: a.clickable === 'true', box: b ? b.slice(1).map(Number) : null };
  }).filter((n) => n.box && n.box[2] > n.box[0] && n.box[3] > n.box[1]);
}

export const center = (n) => [Math.round((n.box[0] + n.box[2]) / 2), Math.round((n.box[1] + n.box[3]) / 2)];

/** Chrome's camera prompt for an image input ("only this time": nothing stays granted) and an app chooser's "once". */
export const ONCE = ['Only this time', '今回のみ', 'Just once', 'JUST ONCE', 'Only once', '1 回のみ', '1回のみ'];
const ROOTS = ['Show roots', 'ルートを表示する', 'ルートを表示'];
const FILES_APP = ['Files', 'ファイル', 'My Files', 'マイファイル'];
const DOWNLOADS = ['Downloads', 'ダウンロード', 'Download'];
export const NAV = {
  image: [...ONCE, ...FILES_APP, 'Pictures', 'ピクチャ', 'Images', '画像', 'Browse', '参照', ...ROOTS, 'Recent', '最近'],
  pdf: [...ONCE, ...FILES_APP, ...DOWNLOADS, 'Documents', 'ドキュメント', 'Browse', '参照', ...ROOTS, 'Recent', '最近'],
};
/** With a folder of their own under Download: the prompt, the Files app, then the roots, Downloads and the folder. */
const folderNav = (folder) => [...ONCE, folder, ...FILES_APP, ...DOWNLOADS, ...ROOTS];

const isPreview = (n) => /preview_icon/.test(n.id) || /プレビュー|preview/i.test(n.desc);

/** The node that chooses `name`: its title (exact), else a node that names it which is not a preview icon. */
export function findFile(nodes, name) {
  const stem = name.replace(/\.[^.]+$/, '');
  const ok = nodes.filter((n) => !isPreview(n));
  return ok.find((n) => n.text === name || n.desc === name) ?? ok.find((n) => n.text.startsWith(stem) || n.desc.includes(name)) ?? null;
}

/**
 * The next tap in the picker. state = { kind: 'image' | 'pdf', name, folder (or null), used: Set of labels tapped,
 * inFolder }. -> { step: 'file' | 'location' | 'closed' | 'none', node, label, why }
 * With a folder, a file shown elsewhere (the recent files list) is not chosen: only inside the folder.
 */
export function nextStep(nodes, state, chrome = 'com.android.chrome') {
  const pkg = nodes.find((n) => n.pkg)?.pkg ?? '';
  if (pkg === chrome) return { step: 'closed', why: 'the picker closed' };
  if (!state.folder || state.inFolder) {
    const file = findFile(nodes, state.name);
    if (file) return { step: 'file', node: file, label: file.text || file.desc, pkg };
  }
  const labels = state.folder ? folderNav(state.folder) : NAV[state.kind];
  for (const label of labels) {
    if (state.used.has(label)) continue;
    const n = nodes.find((x) => (x.text === label || x.desc === label) && !isPreview(x));
    if (n) return { step: 'location', node: n, label, pkg, entersFolder: !!state.folder && label === state.folder };
  }
  return { step: 'none', pkg, why: `no ${state.name}${state.folder ? ` in ${state.folder}` : ''} and no known step in the picker (${pkg})` };
}
