// The tile inspector: what is on the selected tile, what may spawn there,
// door access and controls, and the objects drawn beside the tile.
import { groupDoorAccess } from '../model/door-highlights.ts';
import { $, escapeHtml, isChecked } from '../core/dom.ts';
import { redraw } from '../core/frame.ts';
import { setSidebarCollapsed, showSidebarView } from './layout.ts';
import { tileCenterX, tileCenterY } from '../rendering/projection.ts';
import { recordJump } from './history.ts';
import { clearFinding, requestTileCandidates } from './search.ts';
import { definitionAt, infrastructureOrder, networkNames, palette, state } from '../core/state.ts';
import { setDeck } from './station.ts';
import type {
  Atom,
  Definition,
  DoorAccess,
  DoorControl,
  SearchRecord,
  TileCandidate,
} from '../core/types.ts';
import { share } from './url-state.ts';
import { viewFragment } from '../model/view-state.ts';
import { randomPreviewMarkup } from '../model/random-preview.ts';
import type { AreaSelection } from '../model/view-state.ts';
import { selectionDefinitions } from '../model/selection-data.ts';
import { validTelecomHighlights } from '../model/telecomms.ts';
import { telecommsSections } from './telecomms.ts';

/** The finding shown with the selection, if the selection came from a search result. */
let inspectedResult: (SearchRecord & { spawner?: string }) | null = null;
/** The detailed (raw) view is rendered once per selection and swapped in on demand. */
let detailedHtml = '';
let tileCandidates: TileCandidate[] = [];

function repositoryUrl(path: string): string {
  const manifest = state.manifest!;
  return `${manifest.repository.replace(/\.git$/, '')}/blob/${manifest.commit}/${path}`;
}

function sourceLink(file: string): string {
  return `<a href="${escapeHtml(repositoryUrl(file))}" target="_blank" rel="noreferrer">${escapeHtml(file)} ↗</a>`;
}

/** Strips DM text markup from names and descriptions. */
function cleanText(text: string | null | undefined): string {
  return String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\\[a-z]+\s*/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();
}

/** Lists names with counts, alphabetically. */
function nameList(items: { name: string }[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = cleanText(item.name);
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `<li>${escapeHtml(name)}${count > 1 ? ` × ${count}` : ''}</li>`)
    .join('');
}

/** Deselects the tile and returns the sidebar to the map view. */
export function clearSelection(): void {
  clearFinding();
  state.selected = null;
  state.selectedArea = null;
  state.selectionDraft = null;
  state.offsetHighlights = new Set();
  state.telecomHighlights = new Set();
  $<HTMLButtonElement>('inspect-tab').disabled = true;
  showSidebarView('explore');
  redraw();
  share();
}

export function receiveTileCandidates(candidates: TileCandidate[]): void {
  tileCandidates = candidates;
  paintInspector();
}

export function clearInspectedResult(): void {
  inspectedResult = null;
}

/** Renders the raw view: every mapped object with its type, overrides and source. */
function detailedMarkup(
  x: number,
  y: number,
  z: number,
  definition: Definition,
  result: typeof inspectedResult,
): string {
  const map = state.map!;
  const area = map.areas[definition.area];
  const contents = definition.atoms.filter((atom) => !atom.path.startsWith('/turf/'));
  const resultMarkup = result
    ? `<p><strong>${escapeHtml(result.name)}</strong><br>${
        result.kind === 'possible'
          ? `Candidate from ${escapeHtml(result.spawner)}. No probability is inferred.`
          : `${escapeHtml(result.kind)} source location`
      }</p>`
    : '';
  const aperture = definition.aperture
    ? `Lower-deck visibility: ${Math.round((definition.aperture / 255) * 100)}% · `
    : '';
  const atomMarkup = (atom: Atom) => {
    const network = atom.network
      ? ` <span style="color:${palette[atom.network]}">[${escapeHtml(networkNames[atom.network])}]</span>`
      : '';
    const source = atom.source
      ? `<br><a href="${escapeHtml(repositoryUrl(atom.source))}" target="_blank" rel="noreferrer">DM declaration ↗</a>`
      : '';
    return `<li>${escapeHtml(atom.name)}${network}<details><summary>Type & overrides</summary><p>${escapeHtml(atom.path)}<br>${escapeHtml(JSON.stringify(atom.vars))}${source}</p></details></li>`;
  };
  return `<button class="close" aria-label="Close inspector">×</button>
<span class="tiny-label">TILE INSPECTOR / Z${z}</span>
<h3>${escapeHtml(area.name)}</h3>
<p>${escapeHtml(area.region.toUpperCase())} · X ${x} / Y ${y}<br>${escapeHtml(area.path)}</p>
${resultMarkup}
<p>${aperture}${escapeHtml(definition.turf)}</p>
<details open><summary>${contents.length} mapped objects</summary><ul>${contents.map(atomMarkup).join('')}</ul></details>
<p>Utility sprites show mapped infrastructure. They do not simulate live connectivity, pressure or power.</p>
<a href="${escapeHtml(repositoryUrl(map.files[0]))}" target="_blank" rel="noreferrer">View map source ↗</a>`;
}

/** Renders the friendly view: readable descriptions of the tile and what it holds. */
function friendlyMarkup(x: number, y: number, z: number, definition: Definition): string {
  const map = state.map!;
  const area = map.areas[definition.area];
  const turf = definition.atoms.find((atom) => atom.path.startsWith('/turf/'));
  const shownTurf =
    isChecked('runtime-terrain') && definition.runtimeTerrain ? definition.runtimeTerrain : turf;
  const here = definition.atoms.filter(
    (atom) =>
      /^\/(obj|mob)\//.test(atom.path) &&
      !atom.path.startsWith('/obj/effect/') &&
      !atom.path.includes('/spawner/'),
  );
  const links = (map.infrastructure?.transitions || []).filter((t) => t.x === x && t.y === y && t.z === z);
  const cables = (map.infrastructure?.nodes || []).filter(
    (n) => n.channel === 'power' && n.x === x && n.y === y && n.z === z,
  );
  const random =
    !!definition.runtimeTerrain ||
    definition.atoms.some((atom) => atom.path.includes('/spawner/') || atom.path.includes('/random'));
  const description = cleanText(shownTurf?.description)
    ? `. ${escapeHtml(cleanText(shownTurf!.description))}`
    : '';
  const candidates = tileCandidates.length
    ? `<p class="friendly-description">One or more of these may be chosen when the round begins.</p><ul class="friendly-list">${nameList(tileCandidates)}</ul>`
    : `<p class="info-empty">${
        random
          ? 'Random objects may appear here. Their exact contents are decided when the round starts.'
          : 'No random item spawns are recorded here.'
      }</p>`;
  const electricity = cables.length
    ? `<h4 class="info-heading">Electricity</h4><p class="friendly-description">${[...new Set(cables.map((n) => `Power network ${n.network}`))].join(', ')}. Matching network colors indicate connected wiring.</p>`
    : '';
  const destinations = links.length
    ? `<h4 class="info-heading">Where this leads</h4>${links
        .map(
          (link) =>
            `<p class="friendly-description">${escapeHtml(link.kind)}: ${
              link.targets.length
                ? link.targets.map((t) => `Deck ${t.z} - ${escapeHtml(t.room)}`).join('; ')
                : 'No destination is mapped in this station.'
            }</p>`,
        )
        .join('')}`
    : '';
  return `<button class="close" aria-label="Close inspector">×</button>
<span class="tiny-label">DECK ${z} · ${x}, ${y}</span>
<h3>${escapeHtml(area.name)}</h3>
<p class="friendly-description">${escapeHtml(cleanText(shownTurf?.name) || 'Station surface')}${description}</p>
${inspectedResult ? `<p class="friendly-description">Selected finding: <strong>${escapeHtml(inspectedResult.name)}</strong></p>` : ''}
<h4 class="info-heading">What’s here</h4>
${here.length ? `<ul class="friendly-list">${nameList(here)}</ul>` : '<p class="info-empty">No objects are placed on this tile.</p>'}
<h4 class="info-heading">What could appear</h4>
${candidates}${electricity}${destinations}`;
}

function accessTexts(access: DoorAccess, jobRoles: string[]): { allowed: string; denied: string } {
  if (access.kind === 'public')
    return { allowed: 'Anyone can normally open this door.', denied: 'No standard crew roles are excluded.' };
  if (access.kind === 'remote')
    return {
      allowed: 'This door is normally opened using a button or remote controls.',
      denied: 'A job ID alone does not open this remotely controlled door.',
    };
  if (access.kind === 'unknown')
    return {
      allowed: 'Access is assigned dynamically and could not be determined from the map.',
      denied: 'Excluded roles could not be determined from the map.',
    };
  const excluded = jobRoles.filter((role) => !access.roles.includes(role));
  return {
    allowed: access.roles.length
      ? `${access.roles.join(', ')}.`
      : 'No standard starting job ID is known to open this door.',
    denied: jobRoles.length
      ? excluded.length
        ? `${excluded.join(', ')}.`
        : 'No standard crew roles are excluded.'
      : 'The complete crew role list is unavailable.',
  };
}

/** Controls (buttons, remotes) that operate a door and are within range of it. */
function controlsFor(door: Atom, x: number, y: number, z: number): DoorControl[] {
  return (state.map!.doorControls || []).filter(
    (control) =>
      (door.controlKeys || []).some((key) => key.kind === control.kind && key.id === control.id) &&
      (!control.range ||
        (control.z === z && Math.max(Math.abs(control.x - x), Math.abs(control.y - y)) <= control.range)),
  );
}

function controlLink(control: DoorControl): HTMLAnchorElement {
  const map = state.map!;
  const link = document.createElement('a');
  link.className = 'door-control-link';
  link.textContent = `${control.name} - Deck ${control.z} · ${control.x}, ${control.y}`;
  link.href = viewFragment({
    ...state,
    infrastructureOrder,
    map,
    z: control.z,
    x: tileCenterX(control.x),
    y: (map.height - control.y + 0.5) * 32,
    zoom: Math.max(state.zoom, 1),
    selected: control,
    selectedArea: null,
    telecomHighlights: new Set(),
    result: null,
    finding: null,
    offsetHighlights: new Set([control.atomIndex]),
  });
  link.onclick = (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    setDeck(control.z);
    state.x = tileCenterX(control.x);
    state.y = tileCenterY(control.y);
    state.zoom = Math.max(state.zoom, 1);
    inspect(control.x, control.y, control.z, null, [control.atomIndex]);
    redraw();
    share();
  };
  return link;
}

function provenanceDetails(access: DoorAccess): HTMLDetailsElement {
  const map = state.map!;
  const declaration = (item: {
    type: string;
    property: string;
    value: string;
    file: string;
    mapped?: boolean;
  }) =>
    `<li><code>${escapeHtml(item.type)}<br>${escapeHtml(item.property)} = ${escapeHtml(item.value)}</code><br>${
      item.mapped ? `Mapped override: ${map.files.map(sourceLink).join('<br>')}` : sourceLink(item.file)
    }</li>`;
  const sources = access.sources;
  const roles = Object.entries(map.jobRoleSources || {});
  const rules = JSON.stringify(
    {
      kind: access.kind,
      all: access.all || [],
      any: access.any || [],
      normalRoles: access.roles,
      expandedRoles: access.expandedRoles,
    },
    null,
    2,
  );
  const provenance = document.createElement('details');
  provenance.className = 'access-provenance';
  provenance.innerHTML = `<summary>Access rules &amp; source data</summary><pre>${escapeHtml(rules)}</pre>
<h4>Door requirements</h4>
${sources?.requirements?.length ? `<ul>${sources.requirements.map(declaration).join('')}</ul>` : '<p>No static requirement declaration was recorded.</p>'}
<h4>Mapped access helpers</h4>
${
  sources?.helpers?.length
    ? `<ul>${sources.helpers
        .map(
          (helper) =>
            `<li><code>${escapeHtml(helper.mappedType)}<br>${escapeHtml(`${helper.type}/${helper.method}`)}<br>${escapeHtml(helper.access.join(', '))}</code><br>${sourceLink(helper.file)}</li>`,
        )
        .join('')}</ul>`
    : '<p>No mapped access helper was recorded.</p>'
}
<details><summary>Job ID access definitions (${roles.length})</summary>${roles
    .map(
      ([role, source]) =>
        `<h4>${escapeHtml(role)}</h4><code>${escapeHtml(source.type)}</code><ul>${source.declarations.map(declaration).join('')}</ul>${
          Object.keys(source.mapChanges || {}).length
            ? `<pre>${escapeHtml(JSON.stringify(source.mapChanges, null, 2))}</pre>${sourceLink(`_maps/${map.id}.json`)}`
            : ''
        }`,
    )
    .join('')}</details>`;
  return provenance;
}

function doorSection(
  door: Atom & { doorAccess: DoorAccess },
  x: number,
  y: number,
  z: number,
  detailed: boolean,
): HTMLElement {
  const map = state.map!;
  const access = door.doorAccess;
  const texts = accessTexts(access, map.jobRoles || []);
  const section = document.createElement('section');
  section.innerHTML = `<h4 class="info-heading">Who can open ${escapeHtml(door.name)}</h4>
<p class="friendly-description">${escapeHtml(texts.allowed)}</p>
<h4 class="info-heading">Who can NOT open ${escapeHtml(door.name)}</h4>
<p class="friendly-description">${escapeHtml(texts.denied)}</p>
${access.expandedRoles?.length ? `<p class="friendly-description">With expanded departmental access, it can also open for: ${escapeHtml(access.expandedRoles.join(', '))}.</p>` : ''}
${access.kind === 'restricted' ? '<p class="helper-text">Both lists use normal starting ID access. Access granted or changed during a round can differ.</p>' : ''}`;
  const controls = controlsFor(door, x, y, z);
  if (controls.length) {
    const heading = document.createElement('h4');
    heading.className = 'info-heading';
    heading.textContent = `Buttons & controls for ${door.name}`;
    section.append(heading);
    for (const control of controls) section.append(controlLink(control));
  } else if (access.kind === 'remote') {
    const note = document.createElement('p');
    note.className = 'helper-text';
    note.textContent = 'No matching button is recorded in this station snapshot.';
    section.append(note);
  }
  if (detailed) section.append(provenanceDetails(access));
  return section;
}

function offsetObjectsSection(definition: Definition): HTMLElement | null {
  const offsetObjects = definition.atoms
    .map((atom, index) => ({ atom, index }))
    .filter(({ atom }) => atom.visual);
  if (!offsetObjects.length) return null;
  const section = document.createElement('section');
  section.className = 'offset-objects';
  section.innerHTML =
    '<h4 class="info-heading">Objects drawn beside this tile</h4><p class="helper-text">Highlight the actual position of each wall-mounted or offset object.</p>';
  for (const { atom, index } of offsetObjects) {
    const label = document.createElement('label');
    label.className = 'toggle-row';
    const text = document.createElement('span');
    text.textContent = atom.name;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.objectIndex = String(index);
    input.setAttribute('aria-label', `Highlight ${atom.name}`);
    input.checked = state.offsetHighlights.has(index);
    input.onchange = () => {
      if (input.checked) state.offsetHighlights.add(index);
      else state.offsetHighlights.delete(index);
      redraw();
      share();
    };
    label.append(text, input);
    section.append(label);
  }
  return section;
}

/** Re-renders the inspector panel for the current selection and view mode. */
export function paintInspector(): void {
  if (!state.selected || !state.map) return;
  if (state.selectedArea) {
    paintAreaInspector(state.selectedArea);
    return;
  }
  const { x, y, z } = state.selected;
  const definition = definitionAt(x, y, z);
  if (!definition) return;
  const detailed = isChecked('detailed-view');
  const inspector = $('inspector');
  inspector.innerHTML = detailed ? detailedHtml : friendlyMarkup(x, y, z, definition);
  inspector.insertAdjacentHTML(
    'beforeend',
    randomPreviewMarkup(definition.atoms, isChecked('random-markers')),
  );
  if (detailed && tileCandidates.length) {
    const candidates = document.createElement('details');
    candidates.open = true;
    candidates.innerHTML = `<summary>Possible contents (${tileCandidates.length})</summary><p>Static loot candidates, including closet contents. No probability is inferred.</p><ul>${tileCandidates.map((item) => `<li>${escapeHtml(item.name)}<br><code>${escapeHtml(item.path)}</code></li>`).join('')}</ul>`;
    inspector.append(candidates);
  }
  const doors = definition.atoms.filter(
    (atom): atom is Atom & { doorAccess: DoorAccess } => !!atom.doorAccess,
  );
  for (const door of detailed ? doors : groupDoorAccess(doors))
    inspector.append(doorSection(door, x, y, z, detailed));
  if (!detailed && definition.runtimeTerrain && isChecked('runtime-terrain')) {
    const note = document.createElement('p');
    note.className = 'helper-text';
    note.textContent =
      'Representative terrain preview. The exact landscape is generated when each round starts.';
    inspector.append(note);
  }
  const offsets = offsetObjectsSection(definition);
  if (offsets) inspector.append(offsets);
  for (const section of telecommsSections()) inspector.append(section);
  inspector.querySelector<HTMLButtonElement>('.close')!.onclick = clearSelection;
}

/**
 * Selects a tile and opens the inspector. `result` is the search finding the
 * selection belongs to; `highlights` names offset objects to call out.
 */
export function inspect(
  x: number,
  y: number,
  z = state.z,
  result: SearchRecord | null = null,
  highlights?: number[],
  telecomHighlights?: number[],
): void {
  const map = state.map;
  if (!map) return;
  const definition = definitionAt(x, y, z);
  if (!definition || x < 1 || x > map.width || y < 1 || y > map.height) return;
  const same = state.selected?.x === x && state.selected?.y === y && state.selected?.z === z;
  if (highlights !== undefined)
    state.offsetHighlights = new Set(
      highlights.filter((index) => Number.isInteger(index) && definition.atoms[index]?.visual),
    );
  else if (!same) state.offsetHighlights = new Set();
  state.selected = { x, y, z };
  state.selectedArea = null;
  state.selectionDraft = null;
  state.telecomHighlights = validTelecomHighlights(
    map,
    state.selected,
    null,
    telecomHighlights ?? (same ? state.telecomHighlights : []),
  );
  if (!result) clearFinding();
  state.selectionPulseStart = performance.now();
  let shownResult: typeof inspectedResult = result;
  if (result?.kinds?.length && result.placedPoints) {
    let placed = false;
    for (let p = 0; p < result.placedPoints.length; p += 3)
      if (
        result.placedPoints[p] === x &&
        result.placedPoints[p + 1] === y &&
        result.placedPoints[p + 2] === z
      )
        placed = true;
    shownResult = { ...result, kind: placed ? 'placed' : 'possible' };
  }
  if (shownResult?.kind === 'possible' && result) {
    const contents = definition.atoms.filter((atom) => !atom.path.startsWith('/turf/'));
    shownResult = {
      ...shownResult,
      spawner:
        contents.find((atom) => result.spawners?.includes(atom.path))?.path ||
        result.spawners?.[0] ||
        'a static loot table',
    };
  }
  detailedHtml = detailedMarkup(x, y, z, definition, shownResult);
  inspectedResult = shownResult;
  tileCandidates = [];
  $<HTMLButtonElement>('inspect-tab').disabled = false;
  setSidebarCollapsed(false);
  showSidebarView('inspect');
  paintInspector();
  requestTileCandidates(x, y, z);
  redraw();
  share();
  recordJump();
}

export function initInspector(): void {
  $('detailed-view').onchange = paintInspector;
}

function paintAreaInspector(area: AreaSelection): void {
  const map = state.map!;
  const detailed = isChecked('detailed-view');
  const groups = selectionDefinitions(area, definitionAt);
  const count = (area.x2 - area.x1 + 1) * (area.y2 - area.y1 + 1);
  const rooms = new Map<number, number>();
  const objects = new Map<string, { atom: Atom; count: number }>();
  for (const group of groups) {
    rooms.set(group.definition.area, (rooms.get(group.definition.area) || 0) + group.tiles.length);
    for (const atom of group.definition.atoms) {
      const key = JSON.stringify(atom);
      if (!objects.has(key)) objects.set(key, { atom, count: 0 });
      objects.get(key)!.count += group.tiles.length;
    }
  }
  const inspector = $('inspector');
  inspector.innerHTML = `<button class="close" aria-label="Close inspector">&times;</button>
    <span class="tiny-label">AREA INSPECTOR / Z${area.z}</span><h3>${count} selected tiles</h3>
    <p>X ${area.x1}-${area.x2} / Y ${area.y1}-${area.y2}</p>
    <h4 class="info-heading">Rooms</h4><ul>${[...rooms].map(([id, count]) => `<li>${escapeHtml(map.areas[id].name)} (${count} tiles)</li>`).join('')}</ul>
    <h4 class="info-heading">Surfaces and mapped objects</h4>
    <ul>${[...objects.values()]
      .sort((a, b) => a.atom.name.localeCompare(b.atom.name))
      .map(
        ({ atom, count }) =>
          `<li>${escapeHtml(atom.name)} &times; ${count}${detailed ? `<details><summary>Type &amp; overrides</summary><code>${escapeHtml(atom.path)}</code><pre>${escapeHtml(JSON.stringify(atom.vars, null, 2))}</pre>${atom.source ? sourceLink(atom.source) : ''}</details>` : atom.description ? `<p>${escapeHtml(cleanText(atom.description))}</p>` : ''}</li>`,
      )
      .join('')}</ul>
    ${randomPreviewMarkup(
      [...objects.values()].map(({ atom }) => atom),
      isChecked('random-markers'),
    )}
    <h4 class="info-heading">Possible contents (${tileCandidates.length})</h4>
    <ul>${tileCandidates.map((item) => `<li>${escapeHtml(item.name)}${detailed ? `<br><code>${escapeHtml(item.path)}</code>` : ''}</li>`).join('')}</ul>
    <p class="helper-text">Possible contents are candidates, not guaranteed inventory.</p>
    <details><summary>All selected tile data</summary>${groups.map(({ definition, tiles }) => `<details><summary>${tiles.length} tiles: ${escapeHtml(definition.turf)}</summary><p>${tiles.map((t) => `${t.x},${t.y}`).join('; ')}</p><pre>${escapeHtml(JSON.stringify(definition, null, 2))}</pre></details>`).join('')}</details>`;
  for (const { definition, tiles } of groups) {
    const tile = tiles[0];
    for (const door of definition.atoms.filter(
      (atom): atom is Atom & { doorAccess: DoorAccess } => !!atom.doorAccess,
    )) {
      const section = doorSection(door, tile.x, tile.y, tile.z, detailed);
      const locations = document.createElement('p');
      locations.textContent = `Locations: ${tiles.map((t) => `${t.x},${t.y}`).join('; ')}`;
      section.prepend(locations);
      inspector.append(section);
    }
  }
  for (const section of telecommsSections()) inspector.append(section);
  const transitions = (map.infrastructure?.transitions || []).filter(
    (t) => t.z === area.z && t.x >= area.x1 && t.x <= area.x2 && t.y >= area.y1 && t.y <= area.y2,
  );
  if (transitions.length)
    inspector.insertAdjacentHTML(
      'beforeend',
      `<h4 class="info-heading">Deck connections</h4><ul>${transitions.map((t) => `<li>${escapeHtml(t.kind)} at ${t.x},${t.y}: ${t.targets.map((target) => `Deck ${target.z} (${escapeHtml(target.room)})`).join('; ')}</li>`).join('')}</ul>`,
    );
  inspector.querySelector<HTMLButtonElement>('.close')!.onclick = clearSelection;
}

export function inspectArea(area: AreaSelection, telecomHighlights?: number[]): void {
  const map = state.map;
  if (
    !map ||
    area.x1 < 1 ||
    area.y1 < 1 ||
    area.x2 > map.width ||
    area.y2 > map.height ||
    area.x1 > area.x2 ||
    area.y1 > area.y2 ||
    !map.levels.includes(area.z)
  )
    return;
  state.selected = { x: area.x1, y: area.y1, z: area.z };
  state.selectedArea = { ...area };
  state.selectionDraft = null;
  state.offsetHighlights.clear();
  state.telecomHighlights = validTelecomHighlights(map, state.selected, area, telecomHighlights || []);
  clearFinding();
  inspectedResult = null;
  tileCandidates = [];
  state.selectionPulseStart = performance.now();
  $<HTMLButtonElement>('inspect-tab').disabled = false;
  setSidebarCollapsed(false);
  showSidebarView('inspect');
  paintInspector();
  requestTileCandidates(area.x1, area.y1, area.z);
  redraw();
  share();
  recordJump();
}
