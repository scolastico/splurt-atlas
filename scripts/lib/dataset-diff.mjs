/** Stable values, independent of dictionary numbering and JSON key order. */
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

export function tileDefinition(meta, level, x, y) {
  if (!meta || !level || x < 1 || y < 1 || x > meta.width || y > meta.height) return null;
  const definition = meta.definitions[level.grid[(meta.height - y) * meta.width + x - 1]];
  if (!definition) return null;
  return { ...definition, area: meta.areas[definition.area] };
}

/** A concise guide to the full before/after records shown by the inspector. */
export function describeTileChanges(before, after) {
  if (!before || !after)
    return [
      before ? 'Mapped tile removed.' : after ? 'Mapped tile added.' : 'No mapped tile in either dataset.',
    ];
  const notes = [];
  if (canonical(before.area) !== canonical(after.area))
    notes.push(`Area: ${before.area?.name || before.area?.path} → ${after.area?.name || after.area?.path}`);
  if (before.turf !== after.turf) notes.push(`Surface: ${before.turf} → ${after.turf}`);
  const remaining = [...after.atoms];
  const removed = [];
  for (const atom of before.atoms) {
    const index = remaining.findIndex((other) => canonical(other) === canonical(atom));
    if (index < 0) removed.push(atom);
    else remaining.splice(index, 1);
  }
  for (const atom of removed) notes.push(`Removed or changed: ${atom.name || atom.path} (${atom.path})`);
  for (const atom of remaining) notes.push(`Added or changed: ${atom.name || atom.path} (${atom.path})`);
  for (const key of ['aperture', 'runtimeTerrain'])
    if (canonical(before[key]) !== canonical(after[key]))
      notes.push(`${key === 'aperture' ? 'Deck transparency' : 'Generated terrain'} changed.`);
  return notes.length
    ? notes
    : ['Exported source facts are unchanged. Check the sprite comparison for image changes.'];
}

/** Compare source facts at BYOND coordinates, including resized/added/removed decks. */
export function compareDeck(before, beforeLevel, after, afterLevel, z) {
  if (before.id !== after.id) throw new Error('Choose two datasets of the same station');
  const signatures = (meta) =>
    meta.definitions.map((def) => canonical({ ...def, area: meta.areas[def.area] }));
  const a = signatures(before),
    b = signatures(after);
  const at = (meta, level, signatures, x, y) =>
    !level || x > meta.width || y > meta.height
      ? null
      : (signatures[level.grid[(meta.height - y) * meta.width + x - 1]] ?? null);
  const changes = [];
  for (let y = Math.max(before.height, after.height); y >= 1; y--)
    for (let x = 1; x <= Math.max(before.width, after.width); x++) {
      const left = at(before, beforeLevel, a, x, y),
        right = at(after, afterLevel, b, x, y);
      if (left === right) continue;
      changes.push({ x, y, z, kind: left === null ? 'added' : right === null ? 'removed' : 'modified' });
    }
  return changes;
}
