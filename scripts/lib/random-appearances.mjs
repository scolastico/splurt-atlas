// Stable visual examples are previews, not a recreation of a round's random seed.
import { splitTop } from './dmm.mjs';
import { unquote } from './dm.mjs';

const VENDING = /^\/obj\/machinery\/vending(?:\/|$)/;
const RANDOM_SPAWNER = /^\/obj\/effect\/spawner\/random(?:\/|$)/;
const pools = new WeakMap();
const literal = (db, value) => String(db.literal ? db.literal(String(value ?? '')) : (value ?? ''));
const PLANT = /^\/obj\/item\/kirbyplants\/random(?:\/|$)/;
const GIBSPAWNER = /^\/obj\/effect\/gibspawner(?:\/|$)/;
const FORGERY = /^\/obj\/item\/fakeartefact(?:\/|$)/;
const BOOKCASE = /^\/obj\/structure\/bookcase(?:\/|$)/;

/** Static gib declarations only; movement and the round's blood DNA are not simulated. */
export function gibPreviews(atom, x, y, z, db) {
  const vars = { ...db.resolve(atom.path), ...atom.vars };
  const raw = literal(db, vars.gibtypes).trim();
  if (!/^list\([\s\S]*\)$/.test(raw)) return [];
  const paths = [];
  for (const entry of splitTop(raw.slice(5, -1))) {
    if (!entry.trim()) continue;
    const match = entry
      .trim()
      .match(/^(\/obj\/effect\/decal\/cleanable\/blood\/gibs(?:\/[\w/]+)?)\s*=\s*(\d+)$/);
    if (!match || Number(match[2]) > 32 || paths.length + Number(match[2]) > 64) return [];
    paths.push(...Array(Number(match[2])).fill(match[1]));
  }
  return paths.flatMap((path, index) => {
    const chosen = db.resolve(path);
    if (!chosen.icon) return [];
    const random = literal(db, chosen.random_icon_states).trim();
    const states = /^list\([\s\S]*\)$/.test(random)
      ? splitTop(random.slice(5, -1))
          .filter((state) => /^"[^"\\]*"$/.test(state.trim()))
          .map(unquote)
      : [unquote(chosen.icon_state)];
    const available = states.filter(
      (state) => state && (!db.hasIconState || db.hasIconState(unquote(chosen.icon), state)),
    );
    if (!available.length) return [];
    const state =
      available[((seedFor(atom, x, y, z) + Math.imul(index, 2654435761)) >>> 0) % available.length];
    const placement = Object.fromEntries(
      ['pixel_x', 'pixel_y', 'pixel_w', 'pixel_z'].map((key) => [key, literal(db, vars[key] || '0')]),
    );
    const preview = {
      path,
      vars: { ...placement, icon: chosen.icon, icon_state: JSON.stringify(state), atlas_random_preview: '1' },
    };
    // Flesh/bone detail is an untinted overlay above the blood-colored base.
    if (
      !['FALSE', '0'].includes(literal(db, chosen.has_overlay ?? 'TRUE')) &&
      db.hasIconState?.(unquote(chosen.icon), `${state}-overlay`)
    )
      return [
        preview,
        {
          path,
          vars: { ...preview.vars, icon_state: JSON.stringify(`${state}-overlay`), color: '"#ffffff"' },
        },
      ];
    return [preview];
  });
}

export function plantPreviewStates(atom, db) {
  const vars = { ...db.resolve(atom.path), ...atom.vars };
  if (['TRUE', '1'].includes(literal(db, vars.dead))) return ['plant-25'];
  if (/\/random\/fullysynthetic(?:\/|$)/.test(atom.path)) return [26, 27, 28, 29].map((n) => `plant-${n}`);
  const cap = Number(literal(db, vars.random_state_cap || '43'));
  if (!Number.isInteger(cap) || cap < 1 || cap > 512) return [];
  // generate_states() adds these two special plants after its numbered states.
  return [
    ...Array.from({ length: cap }, (_, index) => `plant-${String(index + 1).padStart(2, '0')}`),
    'applebush',
    'monkeyplant',
  ];
}

function seedFor(atom, x, y, z) {
  let seed = ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0;
  for (const char of atom.path) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0;
  return seed;
}

/** Only finite, guaranteed, non-scattered vendor selections get a visual preview. */
export function vendingPreviewPool(atom, db, seen = new Set()) {
  if (!RANDOM_SPAWNER.test(atom.path) || seen.has(atom.path) || seen.size >= 12) return [];
  const vars = { ...db.resolve(atom.path), ...atom.vars };
  if (!pools.has(db)) pools.set(db, new Map());
  const cache = pools.get(db);
  const cacheKey = JSON.stringify([atom.path, atom.vars]);
  if (!seen.size && cache.has(cacheKey)) return cache.get(cacheKey);
  const remember = (value) => {
    if (!seen.size) cache.set(cacheKey, value);
    return value;
  };
  const count = Number(literal(db, vars.spawn_loot_count ?? '1'));
  if (
    Number(literal(db, vars.spawn_loot_chance ?? '100')) !== 100 ||
    !Number.isInteger(count) ||
    count < 1 ||
    Number(literal(db, vars.spawn_scatter_radius ?? '0')) !== 0 ||
    ['TRUE', '1'].includes(literal(db, vars.spawn_all_loot))
  )
    return remember([]);
  const rawLoot = literal(db, vars.loot);
  const loot = !rawLoot || rawLoot === 'null' ? 'list()' : rawLoot;
  // Reject null/unknown keys and nested weighted expressions rather than
  // silently ignoring a possible "spawn nothing" outcome.
  if (!/^list\([\s\S]*\)$/.test(loot.trim())) return remember([]);
  const entries = splitTop(loot.trim().slice(5, -1));
  const paths = [];
  for (const entry of entries) {
    const match = entry.trim().match(/^(\/obj\/[\w/]+)(?:\s*=\s*([\d.]+))?$/);
    if (!match || (match[2] !== undefined && Number(match[2]) <= 0)) return remember([]);
    paths.push(match[1]);
  }
  for (const [property, includeBase] of [
    ['loot_type_path', true],
    ['loot_subtype_path', false],
  ]) {
    const base = literal(db, vars[property]);
    if (!base || base === 'null') continue;
    if (!VENDING.test(base)) return remember([]);
    if (includeBase) paths.push(base);
    for (const type of db.types?.keys() || []) if (type.startsWith(base + '/')) paths.push(type);
  }
  const next = new Set(seen).add(atom.path);
  const candidates = [];
  for (const path of paths) {
    if (VENDING.test(path)) candidates.push(path);
    else {
      const nested = vendingPreviewPool({ path, vars: {} }, db, next);
      if (!nested.length) return remember([]);
      candidates.push(...nested);
    }
  }
  return remember([...new Set(candidates)].sort());
}

/** Random objects only: deterministic structure helpers and fixed posters stay ordinary. */
export function randomSourceInfo(atom, db) {
  if (!/^\/(obj|mob)\//.test(atom.path) || atom.path.startsWith('/obj/effect/mapping_helpers/')) return null;
  const vars = { ...db.resolve(atom.path), ...atom.vars };
  if (GIBSPAWNER.test(atom.path)) return { kind: 'gibs' };
  if (FORGERY.test(atom.path)) return { kind: 'forgery' };
  if (
    BOOKCASE.test(atom.path) &&
    (atom.path.includes('/random') || ['TRUE', '1'].includes(literal(db, vars.load_random_books)))
  )
    return { kind: 'bookcase' };
  if (PLANT.test(atom.path)) return { kind: 'plant' };
  if (/^\/obj\/structure\/trash_pile(?:\/|$)/.test(atom.path)) return { kind: 'trash' };
  if (/^\/obj\/structure\/sign\/poster(?:\/|$)/.test(atom.path) && vars.random_basetype?.startsWith('/'))
    return { kind: 'poster' };
  if (
    RANDOM_SPAWNER.test(atom.path) ||
    /\/random(?:ise)?(?:\/|$)/.test(atom.path) ||
    (atom.path.includes('/spawner/') && vars.loot)
  ) {
    return vendingPreviewPool(atom, db).length ? { kind: 'vending', guaranteed: true } : { kind: 'spawn' };
  }
  return null;
}

export const VENDING_PREVIEW_DESCRIPTION =
  'A vending machine is guaranteed to spawn here, but its exact model is not known. The normal atlas view shows one possible outcome; the actual machine is chosen when the round starts.';

/** Keep ordinary atoms untouched; give random previews and mapper markers separate channels. */
export function randomAppearances(atoms, originals, x, y, z, db) {
  const previews = atoms.flatMap((atom) => {
    const info = randomSourceInfo(atom, db);
    if (!info) return [atom];
    if (info.kind === 'gibs') return gibPreviews(atom, x, y, z, db);
    if (info.kind === 'bookcase') {
      const vars = { ...db.resolve(atom.path), ...atom.vars };
      const loading = ['TRUE', '1'].includes(literal(db, vars.load_random_books));
      const configured = Number(literal(db, vars.books_to_load || '0'));
      const jitter =
        atom.path.includes('/random') && configured ? [-1, -1, 0, 1, 1][seedFor(atom, x, y, z) % 5] : 0;
      const count = loading && Number.isFinite(configured) ? Math.max(0, configured + jitter) : 0;
      const state = `book-${Math.min(5, count)}`;
      if (db.hasIconState && !db.hasIconState(unquote(vars.icon), state)) return [];
      return [
        { ...atom, vars: { ...atom.vars, icon_state: JSON.stringify(state), atlas_random_preview: '1' } },
      ];
    }
    if (info.kind === 'forgery') {
      const vars = { ...db.resolve(atom.path), ...atom.vars };
      const pool = (vars.possible?.match(/\/obj\/item\/[\w/]+/g) || [])
        .map((path) => db.resolve(path))
        .filter(
          (candidate) =>
            candidate.icon &&
            candidate.icon_state &&
            (!db.hasIconState || db.hasIconState(unquote(candidate.icon), unquote(candidate.icon_state))),
        );
      if (!pool.length) return [];
      const chosen = pool[seedFor(atom, x, y, z) % pool.length];
      return [
        {
          ...atom,
          vars: { ...atom.vars, icon: chosen.icon, icon_state: chosen.icon_state, atlas_random_preview: '1' },
        },
      ];
    }
    if (info.kind === 'plant') {
      const icon = db.resolve('/obj/item/kirbyplants').icon;
      const states = plantPreviewStates(atom, db).filter(
        (state) => !db.hasIconState || db.hasIconState(unquote(icon), state),
      );
      if (icon && states.length) {
        const state = states[seedFor(atom, x, y, z) % states.length];
        return [
          {
            ...atom,
            vars: {
              ...atom.vars,
              icon,
              icon_state: JSON.stringify(state),
              base_icon_state: JSON.stringify(state),
              atlas_random_preview: '1',
            },
          },
        ];
      }
    }
    const pool = info.kind === 'vending' ? vendingPreviewPool(atom, db) : [];
    if (pool.length) {
      const path = pool[seedFor(atom, x, y, z) % pool.length];
      const chosen = db.resolve(path);
      const vars = { ...db.resolve(atom.path), ...atom.vars };
      const placement = { dir: literal(db, vars.dir || '2') };
      for (const key of ['pixel_x', 'pixel_y'])
        if (Number(literal(db, vars[key] || '0')) !== 0) placement[key] = literal(db, vars[key]);
      return [
        {
          path,
          vars: {
            ...placement,
            ...(chosen.icon ? { icon: chosen.icon } : {}),
            ...(chosen.icon_state ? { icon_state: chosen.icon_state } : {}),
            atlas_random_preview: '1',
          },
        },
      ];
    }
    // Tag real poster/trash examples so the mapper foreground can omit only
    // randomized appearances while preserving every ordinary mapped object.
    return [{ ...atom, vars: { ...atom.vars, atlas_random_preview: '1' } }];
  });
  const markers = [];
  const seen = new Set();
  for (const atom of originals) {
    if (!randomSourceInfo(atom, db)) continue;
    const vars = { ...db.resolve(atom.path), ...atom.vars };
    const placement = Object.fromEntries(
      ['pixel_x', 'pixel_y', 'pixel_w', 'pixel_z'].map((key) => [key, literal(db, vars[key] || '0')]),
    );
    const key = JSON.stringify(placement);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [state, layer] of [
      ['rainbow', '3'],
      ['questionmark', '3.001'],
    ])
      markers.push({
        path: atom.path,
        vars: {
          ...placement,
          icon: "'icons/effects/random_spawners.dmi'",
          icon_state: JSON.stringify(state),
          dir: '2',
          color: '""',
          alpha: '255',
          layer,
          atlas_random_marker: '1',
        },
      });
  }
  return [...previews, ...markers];
}
