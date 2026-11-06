import { unquote, pretty } from './dm.mjs';
import { bits } from './infrastructure.mjs';
const normalized = (value, db) => {
  const raw = unquote(db.literal ? db.literal(String(value ?? '')) : value).trim();
  return !raw || raw === 'null' || raw === '-1' || raw.includes('[') ? null : raw;
};
export function doorControlKeys(door, db) {
  const vars = { ...db.resolve(door.path), ...door.vars },
    keys = [];
  const id = normalized(vars.id, db),
    tag = normalized(vars.id_tag, db);
  if (door.path.startsWith('/obj/machinery/door/poddoor') && id) keys.push({ kind: 'poddoor', id });
  if (door.path.startsWith('/obj/machinery/door/airlock') && tag) keys.push({ kind: 'airlock', id: tag });
  if (id && /\/door\/airlock\/security(?:\/|$)|\/door\/window\/brigdoor(?:\/|$)/.test(door.path))
    keys.push({ kind: 'timer', id });
  return keys;
}
export function collectDoorControls(cells, dictionary, db) {
  const controls = [];
  for (const cell of cells)
    for (const [atomIndex, atom] of (dictionary.get(cell.key) || [])
      .filter((atom) => !atom.path.startsWith('/area'))
      .entries()) {
      const vars = { ...db.resolve(atom.path), ...atom.vars };
      let kind, id, range;
      if (/^\/obj\/machinery\/button\/door(?:\/|$)/.test(atom.path)) {
        const normal = ['1', 'TRUE'].includes(
          db.literal ? db.literal(vars.normaldoorcontrol || 'FALSE') : vars.normaldoorcontrol,
        );
        if (normal) {
          const functions = vars.specialfunctions || 'OPEN';
          if (!(bits(String(functions).replace(/\bOPEN\b/g, '1')) & 1)) continue;
        }
        kind = normal ? 'airlock' : 'poddoor';
        id = normalized(vars.id, db);
      } else if (atom.path.startsWith('/obj/machinery/door_buttons/access_button')) {
        kind = 'airlock';
        id = normalized(vars.idDoor, db);
      } else if (atom.path.startsWith('/obj/machinery/status_display/door_timer')) {
        kind = 'timer';
        id = normalized(vars.id, db);
        range = 20;
      }
      if (id)
        controls.push({
          kind,
          id,
          name: unquote(vars.name) || pretty(atom.path),
          path: atom.path,
          atomIndex,
          x: cell.x,
          y: cell.y,
          z: cell.z,
          range,
        });
    }
  return controls;
}
