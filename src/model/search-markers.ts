import type { SearchRecord } from '../core/types.ts';

/** Combined results retain the placed subset; a possible-only result stays possible. */
export function placedFindingKeys(result: SearchRecord): Set<string> {
  const points = result.placedPoints ?? (result.kind === 'placed' ? result.points : []);
  const keys = new Set<string>();
  for (let index = 0; index < points.length; index += 3)
    keys.add(`${points[index]},${points[index + 1]},${points[index + 2]}`);
  return keys;
}
