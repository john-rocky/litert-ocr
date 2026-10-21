// Draws the Markdown that convert() writes: '#' headings, '- ' list items, GFM tables, paragraphs, and the
// '<!-- page N -->' lines between pages. Every piece of text goes in as textContent: what OCR read is never HTML.

export function renderMarkdown(md, root) {
  root.replaceChildren();
  const blocks = md.split(/\n{2,}/).map((b) => b.replace(/^\n+|\n+$/g, '')).filter(Boolean);
  let list = null;
  for (const b of blocks) {
    const page = /^<!-- page (\d+)(?::\s*([\s\S]*?))? -->$/.exec(b);
    if (page) {
      list = null;
      const p = el('p', 'page-mark', page[2] ? `Page ${page[1]}: ${page[2]}` : `Page ${page[1]}`);
      root.append(p);
      continue;
    }
    const lines = b.split('\n');
    if (lines.length >= 2 && isRow(lines[0]) && /^\|(\s*-{3,}\s*\|)+$/.test(lines[1].replace(/\s/g, '').replace(/-+/g, '---'))) {
      list = null;
      root.append(table(lines));
      continue;
    }
    const h = /^(#{1,6}) (.*)$/s.exec(b);
    if (h) {
      list = null;
      root.append(el(`h${Math.min(6, h[1].length + 2)}`, null, h[2]));
      continue;
    }
    if (b.startsWith('- ')) {
      if (!list) {
        list = el('ul');
        root.append(list);
      }
      // one item per block as convert() writes them; a block of several '- ' lines is several items
      const items = lines.every((l) => l.startsWith('- ')) ? lines.map((l) => l.slice(2)) : [b.slice(2)];
      for (const item of items) list.append(el('li', null, item));
      continue;
    }
    list = null;
    root.append(el('p', null, b));
  }
}

function isRow(line) {
  return line.startsWith('|') && line.endsWith('|');
}

/** '| a | b \| c |' -> ['a', 'b | c'] */
function cells(line) {
  const out = [];
  let cur = '';
  for (let i = 1; i < line.length - 1; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function table(lines) {
  const wrap = el('div', 'table-wrap');
  const t = el('table');
  const head = el('thead');
  const hr = el('tr');
  for (const c of cells(lines[0])) hr.append(el('th', null, c));
  head.append(hr);
  const body = el('tbody');
  for (const line of lines.slice(2)) {
    const tr = el('tr');
    for (const c of cells(line)) tr.append(el('td', null, c));
    body.append(tr);
  }
  t.append(head, body);
  wrap.append(t);
  return wrap;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
