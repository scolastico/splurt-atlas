import { unquote } from './dm.mjs';
import { splitTop } from './dmm.mjs';

const TELECOMMS = /^\/obj\/machinery\/telecomms(?:\/|$)/;
const caches = new WeakMap();
const literal = (db, value) => String(db.literal ? db.literal(String(value ?? '')) : (value ?? ''));
const flag = (db, value) => ['TRUE', '1'].includes(literal(db, value));

function declarations(db) {
  if (caches.has(db)) return caches.get(db);
  const methods = new Map(),
    channels = new Map();
  for (const [, text] of db.files || []) {
    for (const match of text.matchAll(
      /^(\/obj\/machinery\/telecomms[\w/]*?)\/Initialize\([^\n]*\)\s*\n([\s\S]*?)(?=^\/|^#|$(?![\s\S]))/gm,
    )) {
      if (!methods.has(match[1])) methods.set(match[1], []);
      methods.get(match[1]).push(match[2]);
    }
    for (const match of text.matchAll(/^\s*#define\s+FREQ_(\w+)\s+/gm)) {
      const frequency = Number(literal(db, `FREQ_${match[1]}`));
      const label = literal(db, `RADIO_CHANNEL_${match[1]}`);
      if (Number.isFinite(frequency) && /^"/.test(label)) channels.set(frequency, unquote(label));
    }
  }
  const result = { methods, channels };
  caches.set(db, result);
  return result;
}

function list(value, db) {
  const raw = literal(db, value).trim();
  if (raw === 'null' || !raw) return { values: [], unknown: false };
  if (!/^list\([\s\S]*\)$/.test(raw)) return { values: [], unknown: true };
  const values = [];
  let unknown = false;
  for (const entry of splitTop(raw.slice(5, -1))) {
    if (!entry.trim()) continue;
    const resolved = literal(db, entry.trim());
    if (/^"(?:\\.|[^"\\])*"$/.test(resolved)) values.push(unquote(resolved));
    else if (/^-?\d+(?:\.\d+)?$/.test(resolved)) values.push(Number(resolved));
    else unknown = true;
  }
  return { values: [...new Set(values)], unknown };
}

function initializers(type, db, methods, seen = new Set()) {
  if (!TELECOMMS.test(type) || seen.has(type)) return [];
  seen.add(type);
  db.resolve(type); // Include inherited declarations in the export dependency inventory.
  const own = methods.get(type);
  const parent = db.types?.get(type)?.vars?.parent_type || type.slice(0, type.lastIndexOf('/'));
  const inherited =
    !own || own.some((body) => /\.\.\(/.test(body)) ? initializers(parent, db, methods, seen) : [];
  return [...inherited, ...(own || [])];
}

/** Literal preset settings plus the source's finite public-frequency initialization loops. */
export function telecommsSettings(atom, db) {
  const vars = { ...db.resolve(atom.path), ...atom.vars };
  const { methods, channels } = declarations(db);
  const tags = list(vars.autolinkers, db),
    parsed = list(vars.freq_listening, db);
  const frequencies = new Set(parsed.values.filter((value) => typeof value === 'number'));
  let unknown = parsed.unknown || parsed.values.some((value) => typeof value !== 'number');
  for (const body of initializers(atom.path, db, methods)) {
    const remaining = body.replace(
      /for\(var\/(\w+)\s*=\s*(\w+),\s*\1\s*<=\s*(\w+),\s*\1\s*\+=\s*(\d+)\)\s*\n\s*freq_listening\s*\|=\s*\1\b/g,
      (_match, _variable, min, max, step) => {
        const first = Number(literal(db, min)),
          last = Number(literal(db, max)),
          increment = Number(step);
        if (
          !Number.isFinite(first) ||
          !Number.isFinite(last) ||
          !increment ||
          last < first ||
          (last - first) / increment > 1000
        ) {
          unknown = true;
          return '';
        }
        for (let value = first; value <= last; value += increment) frequencies.add(value);
        return '';
      },
    );
    if (/\bfreq_listening\b/.test(remaining)) unknown = true;
  }
  const settings = {
    machineId: unquote(literal(db, vars.id)),
    network: unquote(literal(db, vars.network)),
    autolinkers: tags.values,
    frequencyMode: unknown ? 'unknown' : frequencies.size ? 'filtered' : 'all',
    frequencies: [...frequencies]
      .sort((a, b) => a - b)
      .map((value) => ({ value, ...(channels.has(value) ? { name: channels.get(value) } : {}) })),
    longRange: flag(db, vars.long_range_link),
    enabled: flag(db, vars.toggled ?? 'TRUE'),
    unresolved: [...(tags.unknown ? ['autolinkers'] : []), ...(unknown ? ['frequencies'] : [])],
  };
  for (const key of ['broadcasting', 'receiving', 'compressing'])
    if (vars[key] !== undefined) settings[key] = flag(db, vars[key]);
  if (vars.change_frequency !== undefined) {
    const frequency = Number(literal(db, vars.change_frequency));
    if (Number.isFinite(frequency)) settings.changeFrequency = frequency;
  }
  return settings;
}

/** Reconstruct static post_machine_initialize links; network labels are not link predicates. */
export function collectTelecomms(cells, dictionary, db, levels, config = {}) {
  const machines = [];
  for (const cell of cells)
    for (const [atomIndex, atom] of (dictionary.get(cell.key) || [])
      .filter((atom) => !atom.path.startsWith('/area'))
      .entries()) {
      if (!TELECOMMS.test(atom.path)) continue;
      const vars = { ...db.resolve(atom.path), ...atom.vars };
      machines.push({
        id: machines.length,
        x: cell.x,
        y: cell.y,
        z: cell.z,
        atomIndex,
        path: atom.path,
        name: unquote(vars.name) || 'Telecomms equipment',
        ...telecommsSettings(atom, db),
        links: [],
      });
    }
  const parent = new Map(levels.map((z) => [z, z]));
  const root = (z) => {
    while (parent.get(z) !== z) z = parent.get(z);
    return z;
  };
  for (let i = 1; i < levels.length; i++)
    if (config.height_autosetup !== false || config.traits?.[i]?.Down)
      parent.set(root(levels[i]), root(levels[i - 1]));
  for (let i = 0; i < machines.length; i++)
    for (let j = i + 1; j < machines.length; j++) {
      const a = machines[i],
        b = machines[j];
      if (!a.autolinkers.some((tag) => b.autolinkers.includes(tag))) continue;
      const connected = root(a.z) === root(b.z);
      const nearby = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 20;
      if (!connected && !nearby && !(a.longRange && b.longRange)) continue;
      a.links.push(b.id);
      b.links.push(a.id);
    }
  return machines;
}
