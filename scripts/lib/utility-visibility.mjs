import { classify } from './dm.mjs';

export function utilityExposed(atom, atoms, db) {
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
    const hide = literal(vars.hide);
    return ['FALSE', '0'].includes(hide) || (!hide && atom.path.includes('/components/')) || uncovered;
  }
  if (channel === 'disposal' && !/^\/obj\/structure\/disposal(pipe|construct)(?:\/|$)/.test(atom.path))
    return true;
  return uncovered;
}
export function renderChannel(atom, atoms, db) {
  const channel = classify(atom.path);
  return channel && channel !== 'transit' && utilityExposed(atom, atoms, db)
    ? channel + '-surface'
    : channel || 'base';
}
const MAPPING_HELPER = /^\/obj\/effect\/mapping_helpers(?:\/|$)/;

export function bakedChannel(atom, atoms, db) {
  // Mapping helpers only guide mappers (mail sorting, access, lighting...); they never exist in a round.
  if(MAPPING_HELPER.test(atom.path))return 'helpers';
  // Atmospherics components (vents, scrubbers, pumps...) stay visible under intact floors; only their pipe caps hide.
  if (
    classify(atom.path) === 'pipes' &&
    atom.path.includes('/components/') &&
    !String(atom.vars?.icon || '').includes('pipe_underlays')
  )
    return 'foreground';
  const channel = renderChannel(atom, atoms, db);
  if (channel.endsWith('-surface')) {
    if (
      channel === 'disposal-surface' &&
      !/^\/obj\/structure\/disposal(pipe|construct)(?:\/|$)/.test(atom.path)
    )
      return 'foreground';
    if (channel === 'pipes-surface' && atom.path.includes('/components/')) return 'foreground';
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
