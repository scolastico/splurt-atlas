// DMM and TGM share the same grammar. Delimiters inside strings and nested
// lists must not split atom definitions or variable overrides.
export function splitTop(text, delimiter = ',') {
  let quote = '', escaped = false, depth = 0, start = 0;
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
    else if (c === delimiter && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}
export function parseVars(text) {
  const vars = {};
  for (const part of splitTop(text, ';')) {
    const m = part.match(/^\s*([\w/]+)\s*=\s*([\s\S]*)$/);
    if (m) vars[m[1].split('/').at(-1)] = m[2].trim();
  }
  return vars;
}
export function parseDmm(text) {
  const dictionary = new Map();
  const re = /"([a-zA-Z]+)"\s*=\s*\(/g;
  let match;
  while ((match = re.exec(text))) {
    let i = re.lastIndex, start = i, depth = 1, quote = '', escape = false;
    for (; i < text.length && depth; i++) {
      const c = text[i];
      if (quote) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    if (depth) throw new Error(`Unterminated DMM dictionary entry ${match[1]}`);
    dictionary.set(match[1], splitTop(text.slice(start, i - 1)).map(atom => {
      const b = atom.indexOf('{');
      return { path: (b < 0 ? atom : atom.slice(0, b)).trim(), vars: b < 0 ? {} : parseVars(atom.slice(b + 1, atom.lastIndexOf('}'))) };
    }));
    re.lastIndex = i;
  }
  if (!dictionary.size) throw new Error('No DMM dictionary found');
  const keySize = dictionary.keys().next().value.length;
  const cells = [], levels = new Set();
  const grids = /\((\d+),\s*(\d+),\s*(\d+)\)\s*=\s*\{"\r?\n?([\s\S]*?)"\}/g;
  let width = 0, height = 0;
  while ((match = grids.exec(text))) {
    const [, sx, sy, sz, body] = match, x = +sx, y = +sy, z = +sz;
    const rows = body.replace(/\r/g, '').replace(/^\n|\n$/g, '').split('\n');
    levels.add(z);
    for (let row = 0; row < rows.length; row++) {
      if (rows[row].length % keySize) throw new Error(`Invalid DMM row at ${x},${y},${z}`);
      for (let col = 0; col < rows[row].length / keySize; col++) {
        const key = rows[row].slice(col * keySize, (col + 1) * keySize);
        if (!dictionary.has(key)) throw new Error(`Unknown map key ${key}`);
        const cx = x + col, cy = y + rows.length - 1 - row;
        cells.push({ x: cx, y: cy, z, key });
        width = Math.max(width, cx); height = Math.max(height, cy);
      }
    }
  }
  if (!cells.length) throw new Error('No DMM coordinate blocks found');
  return { dictionary, cells, width, height, levels: [...levels].sort((a, b) => a - b) };
}
