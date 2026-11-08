import { unquote, classify } from './dm.mjs';
import { utilityExposed } from './utility-visibility.mjs';
import { atmosPorts } from './atmos-appearance.mjs';
export const cardinals = [
  [1, 0, 1, 2],
  [2, 0, -1, 1],
  [4, 1, 0, 8],
  [8, -1, 0, 4],
];
const flags = {
  NORTH: 1,
  SOUTH: 2,
  EAST: 4,
  WEST: 8,
  ALL_CARDINALS: 15,
  NONE: 0,
  CABLE_LAYER_1: 1,
  CABLE_LAYER_2: 2,
  CABLE_LAYER_3: 4,
  PIPING_ALL_LAYER: 1,
  PIPING_ALL_COLORS: 16,
  PIPING_DISTRO_AND_WASTE_LAYERS: 64,
  PIPING_ONE_PER_TURF: 2,
};
export function bits(value, fallback = 0) {
  if (value == null) return fallback;
  let text = String(value).trim();
  while (text.startsWith('(') && text.endsWith(')')) {
    let depth = 0,
      outer = true;
    for (let i = 0; i < text.length - 1; i++) {
      if (text[i] === '(') depth++;
      if (text[i] === ')') depth--;
      if (depth === 0) {
        outer = false;
        break;
      }
    }
    if (!outer) break;
    text = text.slice(1, -1).trim();
  }
  if (/^-?\d+$/.test(text)) return +text;
  if (text.includes('|')) return text.split('|').reduce((n, v) => n | bits(v, 0), 0);
  const shift = text.match(/^\(?\s*1\s*<<\s*(\d+)\s*\)?$/);
  if (shift) return 1 << +shift[1];
  return flags[text] ?? fallback;
}
const colors = {
  supply: '#4488ff',
  scrubbers: '#ed5959',
  yellow: '#e6c85a',
  cyan: '#63d3dd',
  green: '#7bcd6d',
  orange: '#e79850',
  purple: '#b879d9',
  general: '#b7bec6',
};
export function buildInfrastructure(cells, at, db, levels) {
  const nodes = [],
    locations = new Map(),
    transitions = [];
  const key = (x, y, z) => `${x},${y},${z}`;
  const vars = (a) => ({ ...db.resolve(a.path), ...a.vars });
  for (const cell of cells) {
    for (const [atomIndex, atom] of cell.appearance.entries()) {
      if (atom.vars?.atlas_random_marker === '1') continue;
      const channel = classify(atom.path);
      if (
        !['power', 'pipes', 'fluid'].includes(channel) ||
        /^\/obj\/machinery\/meter(?:\/|$)/.test(atom.path)
      )
        continue;
      const v = vars(atom),
        literal = (value) => (db.literal ? db.literal(value) : value);
      const layer =
        channel === 'fluid'
          ? bits(literal(v.duct_layer), 4)
          : channel === 'power'
            ? bits(v.cable_layer, atom.path.includes('/layer1') ? 1 : atom.path.includes('/layer3') ? 4 : 2)
            : +(atom.path.match(/\/layer([1-5])(?:\/|$)/)?.[1] || v.piping_layer || 3);
      const ports = channel === 'pipes' ? atmosPorts(atom.path, v, db, bits) : 15;
      const n = {
        id: nodes.length,
        x: cell.x,
        y: cell.y,
        z: cell.z,
        channel,
        layer,
        ports,
        banned: bits(v.banned_links),
        links: 0,
        network: 0,
        exposed: utilityExposed(atom, cell.appearance, db),
        atomIndex,
        cell,
        atom,
        path: atom.path,
        color: unquote(literal(channel === 'fluid' ? v.duct_color || v.color : v.pipe_color || v.color)),
      };
      if (channel === 'fluid' && !/^#[\da-f]{6}$/i.test(n.color)) n.color = '#eeeeee';
      if (!/^#[\da-f]{6}$/i.test(n.color))
        n.color =
          Object.entries(colors).find(([part]) => atom.path.split('/').includes(part))?.[1] ||
          (channel === 'power' ? '#e5bd69' : '#77c9b5');
      n.pipeFlags = bits(v.pipe_flags);
      n.connections = [];
      n.simpleEligible = channel === 'power' || atom.path.includes('/pipe/');
      nodes.push(n);
      const k = key(n.x, n.y, n.z);
      if (!locations.has(k)) locations.set(k, []);
      locations.get(k).push(n);
    }
  }
  const parent = nodes.map((_, i) => i);
  const root = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const join = (a, b) => {
    parent[root(a.id)] = root(b.id);
  };
  for (const n of nodes) {
    if (n.channel === 'power' && n.path.includes('/multilayer'))
      for (const other of locations.get(key(n.x, n.y, n.z)) || [])
        if (other.channel === 'power' && n.layer & other.layer) join(n, other);
    for (const [dir, dx, dy, reverse] of cardinals) {
      if (!(n.ports & dir) || n.banned & dir) continue;
      for (const other of locations.get(key(n.x + dx, n.y + dy, n.z)) || []) {
        if (n.channel !== other.channel || !(other.ports & reverse) || other.banned & reverse) continue;
        if (n.channel === 'power') {
          if (!(n.layer & other.layer)) continue;
        } else if (n.channel === 'fluid') {
          if (!(n.layer & other.layer)) continue;
          const own = n.color.toLowerCase(),
            next = other.color.toLowerCase();
          if (own !== next && own !== '#eeeeee' && next !== '#eeeeee') continue;
        } else {
          const allLayers = !!((n.pipeFlags | other.pipeFlags) & 1);
          if (!allLayers) {
            if (n.pipeFlags & 64) {
              if (other.layer % 2) continue;
            } else if (other.pipeFlags & 64) {
              if (n.layer % 2) continue;
            } else if (n.layer !== other.layer) continue;
          }
          if (
            n.color.toLowerCase() !== other.color.toLowerCase() &&
            !((n.pipeFlags | other.pipeFlags) & 16) &&
            !['#eeeeee', '#77c9b5'].includes(n.color.toLowerCase()) &&
            !['#eeeeee', '#77c9b5'].includes(other.color.toLowerCase())
          )
            continue;
        }
        // SMES storage input/output must remain separate even when adjacent.
        const own = at(n.x, n.y, n.z) || [],
          next = at(other.x, other.y, other.z) || [];
        if (
          n.channel === 'power' &&
          ((own.some((a) => a.path.includes('/power/smes')) &&
            next.some((a) => a.path.includes('/power/terminal'))) ||
            (next.some((a) => a.path.includes('/power/smes')) &&
              own.some((a) => a.path.includes('/power/terminal'))))
        )
          continue;
        n.links |= dir;
        n.connections.push({ direction: dir, node: other });
        if (n.channel === 'power') join(n, other);
      }
    }
    if (n.path.includes('/cable/multilayer/multiz'))
      for (const z of [n.z - 1, n.z + 1])
        for (const other of locations.get(key(n.x, n.y, z)) || [])
          if (other.path.includes('/cable/multilayer/multiz')) join(n, other);
  }
  const ids = new Map();
  for (const n of nodes) {
    if (n.channel === 'fluid') {
      const v = vars(n.atom),
        icon = unquote(v.icon),
        base = unquote(v.icon_state || '"nduct"');
      // The game appends connected cardinal names in N, S, E, W order.
      const state =
        base +
        [
          [1, 'n'],
          [2, 's'],
          [4, 'e'],
          [8, 'w'],
        ]
          .filter(([dir]) => n.links & dir)
          .map(([, name]) => '_' + name)
          .join('');
      if (db.hasIconState(icon, state))
        n.cell.appearance[n.atomIndex] = {
          ...n.atom,
          vars: { ...n.atom.vars, icon_state: JSON.stringify(state), color: JSON.stringify(n.color) },
        };
    } else if (n.channel === 'power') {
      const r = root(n.id);
      if (!ids.has(r)) ids.set(r, ids.size + 1);
      n.network = ids.get(r);
      if (!n.path.includes('/multilayer')) {
        const v = vars(n.atom),
          junction =
            n.banned ||
            (at(n.x, n.y, n.z) || []).some((a) =>
              /\/machinery\/power\/|\/structure\/grille|\/table\/reinforced/.test(a.path),
            );
        const dirs = cardinals.filter(([dir]) => n.links & dir).map(([dir]) => dir);
        const state = `l${n.layer}-${dirs.length ? dirs.join('-') : 'noconnection'}${dirs.length > 1 && junction ? '-node' : ''}`;
        if (db.hasIconState(unquote(v.icon), state))
          n.cell.appearance[n.atomIndex] = {
            ...n.atom,
            vars: { ...n.atom.vars, icon_state: JSON.stringify(state) },
          };
      }
    } else if (n.path.includes('/pipe/layer_manifold')) {
      n.cell.appearance[n.atomIndex] = {
        ...n.atom,
        vars: {
          ...n.atom.vars,
          icon_state: '"manifoldlayer_center"',
          color: JSON.stringify(n.color),
          layer: '2.55',
        },
      };
      const icon = 'icons/obj/pipes_n_cables/layer_manifold_underlays.dmi',
        seen = new Set();
      for (const { direction, node } of n.connections) {
        const layers = node.path.includes('/layer_manifold')
          ? [1, 2, 3, 4, 5]
          : node.path.includes('/airlock_pump')
            ? [4]
            : [node.layer];
        const color = node.path.includes('/airlock_pump')
          ? '#0000ff'
          : node.path.includes('/layer_manifold')
            ? node.color.toLowerCase() === n.color.toLowerCase()
              ? n.color
              : '#eeeeee'
            : node.color.toLowerCase() === '#eeeeee' || node.path.includes('/color_adapter')
              ? n.color
              : node.color;
        for (const layer of layers) {
          const state = `intact_${direction}_${layer}`,
            key = state + color;
          if (seen.has(key) || !db.hasIconState(icon, state)) continue;
          seen.add(key);
          n.cell.appearance.push({
            ...n.atom,
            vars: {
              ...n.atom.vars,
              icon: `'${icon}'`,
              icon_state: JSON.stringify(state),
              dir: '2',
              color: JSON.stringify(color),
              layer: '2.545',
            },
          });
        }
      }
    } else if (n.path.includes('/pipe/smart') || n.path.includes('/pipe/bridge_pipe')) {
      let short = 0;
      const count = (mask) => cardinals.filter(([d]) => mask & d).length;
      if (n.path.includes('/bridge_pipe')) short = n.ports & ~n.links;
      else if (count(n.links) < 2) {
        if (n.links) {
          const reverse = cardinals.find(([d]) => n.links & d)?.[3];
          short |= (reverse || 0) & n.ports;
        }
        for (const [d] of cardinals)
          if (count(n.links | short) < 2 && n.ports & d && !(n.links & d)) short |= d;
      }
      const state = `${n.links | (short << 4)}_${n.layer}`,
        icon = 'icons/obj/pipes_n_cables/!pipes_bitmask.dmi';
      if (db.hasIconState(icon, state))
        n.cell.appearance[n.atomIndex] = {
          ...n.atom,
          vars: {
            ...n.atom.vars,
            icon: `'${icon}'`,
            icon_state: JSON.stringify(state),
            dir: '2',
            color: JSON.stringify(n.color),
          },
        };
      if (n.path.includes('/bridge_pipe')) {
        const offset = (n.layer - 3) * 5;
        n.cell.appearance.push({
          ...n.atom,
          vars: {
            ...n.atom.vars,
            icon: "'icons/obj/pipes_n_cables/bridge_pipe.dmi'",
            icon_state: '"bridge_center"',
            dir: String(n.ports === 12 ? 4 : 2),
            color: JSON.stringify(n.color),
            pixel_x: String(offset),
            pixel_y: String(offset),
            layer: '2.55',
          },
        });
      }
    } else if (n.channel === 'pipes' && n.path.includes('/components/')) {
      const icon = 'icons/obj/pipes_n_cables/pipe_underlays.dmi';
      const v = vars(n.atom);
      const shiftWhole = ['FALSE', '0'].includes(
        String(db.literal ? db.literal(v.shift_underlay_only) : v.shift_underlay_only),
      );
      const underlayLayer = shiftWhole ? 3 : n.layer;
      for (const [direction] of cardinals) {
        if (!(n.ports & direction)) continue;
        const node = n.connections.find((entry) => entry.direction === direction)?.node;
        const state = `${node ? 'intact' : 'exposed'}_${direction}_${underlayLayer}`;
        if (!db.hasIconState(icon, state)) continue;
        n.cell.appearance.push({
          ...n.atom,
          vars: {
            ...n.atom.vars,
            icon: `'${icon}'`,
            icon_state: JSON.stringify(state),
            dir: '2',
            atlas_component_dir: String(v.dir || '2'),
            color: JSON.stringify(node?.color || n.color),
            layer: '2.475',
          },
        });
      }
    }
  }
  const destination = (x, y, z) => {
    const area = (at(x, y, z) || []).find((a) => a.path.startsWith('/area/'))?.path;
    return area
      ? unquote(db.resolve(area).name) || area.split('/').at(-1).replaceAll('_', ' ')
      : 'unmapped area';
  };
  for (const cell of cells)
    for (const atom of cell.appearance) {
      if (/^\/obj\/structure\/ladder(?:\/|$)/.test(atom.path)) {
        const targets = [];
        for (const dz of [-1, 1])
          if (
            levels.includes(cell.z + dz) &&
            (at(cell.x, cell.y, cell.z + dz) || []).some((a) => a.path.startsWith('/obj/structure/ladder'))
          )
            targets.push({
              x: cell.x,
              y: cell.y,
              z: cell.z + dz,
              room: destination(cell.x, cell.y, cell.z + dz),
            });
        transitions.push({ x: cell.x, y: cell.y, z: cell.z, kind: 'Ladder', targets });
      }
      if (/^\/obj\/structure\/stairs(?:\/|$)/.test(atom.path)) {
        const v = vars(atom),
          dir = bits(v.dir, 2),
          step = cardinals.find(([d]) => d === dir) || cardinals[1];
        const next = (at(cell.x + step[1], cell.y + step[2], cell.z) || []).some(
          (a) => a.path.startsWith('/obj/structure/stairs') && bits(vars(a).dir, 2) === dir,
        );
        if (
          v.terminator_mode === 'STAIR_TERMINATOR_NO' ||
          (v.terminator_mode !== 'STAIR_TERMINATOR_YES' && next)
        )
          continue;
        const target = { x: cell.x + step[1], y: cell.y + step[2], z: cell.z + 1 };
        const targets = levels.includes(target.z)
          ? [{ ...target, room: destination(target.x, target.y, target.z) }]
          : [];
        transitions.push({ x: cell.x, y: cell.y, z: cell.z, kind: 'Stairs', targets });
        if (targets.length)
          transitions.push({
            x: cell.x,
            y: cell.y,
            z: target.z,
            kind: 'Stairs',
            targets: [{ x: cell.x, y: cell.y, z: cell.z, room: destination(cell.x, cell.y, cell.z) }],
          });
      }
    }
  return {
    powerNetworks: ids.size,
    nodes: nodes.map(({ cell, atom, atomIndex, banned, path, connections, pipeFlags, ...n }) => n),
    transitions,
  };
}
