import { classify } from './dm.mjs';

export function utilityExposed(atom, atoms, db) {
  if (/^\/obj\/machinery\/meter(?:\/|$)/.test(atom.path)) return true;
  if (underCatwalk(atom, atoms, db)) return false;
  const channel = classify(atom.path),
    vars = { ...db.resolve(atom.path), ...atom.vars };
  if (!channel || channel === 'transit') return false;
  const literal = (value) => (db.literal ? db.literal(String(value ?? '')) : String(value ?? ''));
  const turf = atoms.find((item) => item.path.startsWith('/turf/'));
  const floor = turf ? { ...db.resolve(turf.path), ...turf.vars } : {};
  const accessibility = literal(floor.underfloor_accessibility);
  const uncovered =
    accessibility !== ''
      ? Number(accessibility) >= 1
      : /\/(plating|space|openspace|glass|catwalk)(?:\/|$)/.test(turf?.path || '');
  if (channel === 'pipes') {
    // Generated connector images inherit the component's type, but not its
    // permanently exposed machinery body. Respect the component's hide setting
    // so above-floor fittings stay exposed and vent caps follow the turf.
    const hide = literal(vars.hide);
    if (String(atom.vars?.icon || '').includes('pipe_underlays'))
      return ['FALSE', '0'].includes(hide) || uncovered;
    return ['FALSE', '0'].includes(hide) || (!hide && atom.path.includes('/components/')) || uncovered;
  }
  if (channel === 'disposal' && !/^\/obj\/structure\/disposal(pipe|construct)(?:\/|$)/.test(atom.path))
    return true;
  return uncovered;
}
export function renderChannel(atom, atoms, db) {
  const channel = classify(atom.path);
  if (underCatwalk(atom, atoms, db)) return channel;
  return channel && channel !== 'transit' && utilityExposed(atom, atoms, db)
    ? channel + '-surface'
    : channel || 'base';
}
/** Visible through the grate, but only revealed above it by the network toggle. */
export function underCatwalk(atom, atoms, db) {
  if (/^\/obj\/machinery\/meter(?:\/|$)/.test(atom.path)) return false;
  if (!atoms.some((item) => /\/catwalk(?:_floor)?(?:\/|$)/.test(item.path))) return false;
  const channel = classify(atom.path);
  if (channel === 'navigation') return beaconVisibility(atom, atoms, db) === 'underfloor';
  if (!channel || channel === 'transit') return false;
  if (
    channel === 'pipes' &&
    atom.path.includes('/components/') &&
    !String(atom.vars?.icon || '').includes('pipe_underlays')
  )
    return false;
  if (channel === 'disposal' && !/^\/obj\/structure\/disposal(pipe|construct)(?:\/|$)/.test(atom.path))
    return false;
  const vars = { ...db.resolve(atom.path), ...atom.vars };
  if (channel === 'pipes' && ['FALSE', '0'].includes(String(db.literal ? db.literal(vars.hide) : vars.hide)))
    return false;
  return true;
}
const MAPPING_HELPER = /^\/obj\/effect\/mapping_helpers(?:\/|$)/;
const NAVBEACON = /^\/obj\/machinery\/navbeacon(?:\/|$)/;

/** Nav beacons are real undertile devices, not disposable mapping helpers. */
export function beaconVisibility(atom, atoms, db) {
  if (!NAVBEACON.test(atom.path)) return null;
  return undertileVisibility(atoms, db);
}

export function floorSafeVisibility(atom, atoms, db) {
  if (!/^\/obj\/structure\/safe\/floor(?:\/|$)/.test(atom.path)) return null;
  return undertileVisibility(atoms, db);
}

function undertileVisibility(atoms, db) {
  const turf = atoms.find((item) => item.path.startsWith('/turf/'));
  const vars = turf ? { ...db.resolve(turf.path), ...turf.vars } : {};
  const raw = vars.underfloor_accessibility;
  const value =
    raw === undefined
      ? /\/(plating|space|openspace)(?:\/|$)/.test(turf?.path || '')
        ? 2
        : /\/(glass|catwalk(?:_floor)?)(?:\/|$)/.test(turf?.path || '')
          ? 1
          : 0
      : Number(db.literal ? db.literal(raw) : raw);
  return value >= 2 ? 'surface' : value >= 1 ? 'underfloor' : 'hidden';
}

export function bakedChannel(atom, atoms, db) {
  if (atom.vars?.atlas_random_marker === '1') return 'random-markers';
  if (atom.vars?.atlas_random_preview === '1') return 'foreground';
  if (floorSafeVisibility(atom, atoms, db) === 'underfloor') return 'base';
  // Mapping helpers only guide mappers (mail sorting, access, lighting...); they never exist in a round.
  if (MAPPING_HELPER.test(atom.path)) return 'helpers';
  if (/^\/obj\/machinery\/meter(?:\/|$)/.test(atom.path)) return 'pipes-equipment';
  if (
    /\/components\/unary\/(vent_pump|vent_scrubber|passive_vent)(?:\/|$)/.test(atom.path) &&
    !String(atom.vars?.icon || '').includes('pipe_underlays')
  )
    return 'pipes-floor-equipment';
  const beacon = beaconVisibility(atom, atoms, db);
  if (beacon) return beacon === 'surface' ? 'navigation-surface' : 'navigation';
  // Atmospherics components (vents, scrubbers, pumps...) stay visible under intact floors; only their pipe caps hide.
  if (
    classify(atom.path) === 'pipes' &&
    atom.path.includes('/components/') &&
    !String(atom.vars?.icon || '').includes('pipe_underlays')
  )
    return 'pipes-equipment';
  const channel = renderChannel(atom, atoms, db);
  if (channel.endsWith('-surface')) {
    if (
      channel === 'disposal-surface' &&
      !/^\/obj\/structure\/disposal(pipe|construct)(?:\/|$)/.test(atom.path)
    )
      return 'foreground';
    return channel;
  }
  if (/^\/obj\/structure\/(lattice|catwalk)(?:\/|$)/.test(atom.path)) return 'base';
  if (
    channel === 'base' &&
    /^\/(obj|mob)\//.test(atom.path) &&
    !atom.path.startsWith('/obj/effect/turf_decal')
  )
    return 'foreground';
  return channel;
}
