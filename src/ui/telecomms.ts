import { state, definitionAt, infrastructureOrder } from '../core/state.ts';
import { redraw } from '../core/frame.ts';
import type { TelecommsMachine } from '../core/types.ts';
import { selectedTelecomms, frequencyLabel } from '../model/telecomms.ts';
import { viewFragment } from '../model/view-state.ts';
import { tileCenterX, tileCenterY } from '../rendering/projection.ts';
import { inspect, paintInspector } from './inspector.ts';
import { setDeck } from './station.ts';
import { share } from './url-state.ts';
import { recordJump } from './history.ts';

function destinationLink(machine: TelecommsMachine): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = 'telecomms-link';
  link.textContent = `${machine.machineId || machine.name} - Deck ${machine.z} / ${machine.x}, ${machine.y}`;
  link.href = viewFragment({
    ...state,
    map: state.map!,
    infrastructureOrder,
    x: tileCenterX(machine.x),
    y: tileCenterY(machine.y),
    z: machine.z,
    selected: machine,
    selectedArea: null,
    result: null,
    finding: null,
    offsetHighlights: new Set(),
    telecomHighlights: new Set(),
    zoom: Math.max(1, state.zoom),
  });
  link.onclick = (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setDeck(machine.z);
    state.x = tileCenterX(machine.x);
    state.y = tileCenterY(machine.y);
    state.zoom = Math.max(1, state.zoom);
    inspect(machine.x, machine.y, machine.z);
    redraw();
    share();
  };
  return link;
}

export function telecommsSections(): HTMLElement[] {
  const map = state.map;
  if (!map || !state.selected) return [];
  const machines = selectedTelecomms(map, state.selected, state.selectedArea);
  if (!machines.length) {
    const definition = definitionAt(state.selected.x, state.selected.y, state.selected.z);
    if (map.telecomms || !definition?.atoms.some((atom) => atom.path.startsWith('/obj/machinery/telecomms/')))
      return [];
    const note = document.createElement('p');
    note.className = 'helper-text';
    note.textContent = 'Default telecomms configuration was not recorded for this snapshot.';
    return [note];
  }
  return machines.map((machine) => {
    const section = document.createElement('section');
    section.className = 'telecomms-section';
    const heading = document.createElement('h4');
    heading.className = 'info-heading';
    heading.textContent = `Telecomms: ${machine.name}`;
    const list = document.createElement('dl');
    list.className = 'telecomms-settings';
    const row = (label: string, value: string) => {
      const term = document.createElement('dt'),
        description = document.createElement('dd');
      term.textContent = label;
      description.textContent = value;
      list.append(term, description);
    };
    row('Machine ID', machine.machineId || 'Not set');
    row('Network', machine.network || 'Not set');
    row('Enabled by default', machine.enabled ? 'Yes' : 'No');
    row('Long-range links', machine.longRange ? 'Yes' : 'No');
    if (machine.broadcasting !== undefined)
      row('Relay broadcasting', machine.broadcasting ? 'Enabled' : 'Disabled');
    if (machine.receiving !== undefined) row('Relay receiving', machine.receiving ? 'Enabled' : 'Disabled');
    if (machine.compressing !== undefined)
      row('Processor mode', machine.compressing ? 'Compress' : 'Decompress');
    if (machine.changeFrequency !== undefined)
      row(
        'Output frequency rewrite',
        machine.changeFrequency ? frequencyLabel({ value: machine.changeFrequency }) : 'No rewrite',
      );
    row(
      'Default frequencies',
      machine.frequencyMode === 'all'
        ? 'All frequencies (unfiltered)'
        : `${machine.frequencyMode === 'unknown' ? 'Partially resolved: ' : ''}${machine.frequencies.map(frequencyLabel).join(', ') || 'Unknown'}`,
    );
    row('Automatic link tags', machine.autolinkers.map(String).join(', ') || 'None');
    section.append(heading, list);
    if (machine.unresolved.length) {
      const unresolved = document.createElement('p');
      unresolved.className = 'helper-text';
      unresolved.textContent = `Unresolved source settings: ${machine.unresolved.join(', ')}.`;
      section.append(unresolved);
    }
    const targets = machine.links
      .map((id) => map.telecomms!.find((target) => target.id === id))
      .filter((target): target is TelecommsMachine => !!target);
    const linksHeading = document.createElement('h4');
    linksHeading.className = 'info-heading';
    linksHeading.textContent = `Connected equipment (${targets.length})`;
    section.append(linksHeading);
    const local = targets.filter((target) => target.z === state.z);
    if (local.length) {
      const label = document.createElement('label');
      label.className = 'toggle-row';
      const text = document.createElement('span');
      text.textContent = 'Highlight linked equipment on this deck';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = local.every((target) => state.telecomHighlights.has(target.id));
      checkbox.indeterminate =
        !checkbox.checked && local.some((target) => state.telecomHighlights.has(target.id));
      checkbox.onchange = () => {
        for (const target of local) {
          if (checkbox.checked) state.telecomHighlights.add(target.id);
          else state.telecomHighlights.delete(target.id);
        }
        paintInspector();
        redraw();
        recordJump();
        share();
      };
      label.append(text, checkbox);
      section.append(label);
    }
    if (!targets.length) {
      const empty = document.createElement('p');
      empty.className = 'info-empty';
      empty.textContent = 'No automatic links are recorded in this mapped station.';
      section.append(empty);
    }
    for (const target of targets) {
      const entry = document.createElement('div');
      entry.className = 'telecomms-target';
      entry.append(destinationLink(target));
      if (target.z === state.z) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.telecomHighlights.has(target.id);
        checkbox.setAttribute('aria-label', `Highlight ${target.machineId || target.name}`);
        checkbox.onchange = () => {
          if (checkbox.checked) state.telecomHighlights.add(target.id);
          else state.telecomHighlights.delete(target.id);
          paintInspector();
          redraw();
          recordJump();
          share();
        };
        entry.append(checkbox);
      }
      section.append(entry);
    }
    return section;
  });
}
