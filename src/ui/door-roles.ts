// The "Door access" sidebar section: choosing job roles and the door markers
// derived from them.
import {
  doorMarkersForRoles,
  indexDoorTiles,
  roleSuggestions,
  type DoorMarker,
  type DoorTile,
} from '../model/door-highlights.ts';
import { $ } from '../core/dom.ts';
import { redraw } from '../core/frame.ts';
import { state } from '../core/state.ts';
import type { MapMeta } from '../core/types.ts';
import { share } from './url-state.ts';

let doorTiles: DoorTile[] = [];
let doorMarkers: DoorMarker[] = [];
let suggestedRoles: string[] = [];
let suggestedRoleIndex = 0;

export function getDoorMarkers(): DoorMarker[] {
  return doorMarkers;
}

/** Indexes the doors of a freshly loaded station and restores the requested roles. */
export function loadDoorRoles(map: MapMeta, requestedRoles: string[]): void {
  doorTiles = indexDoorTiles(map, state.levels);
  state.doorRoles = [...new Set(requestedRoles.filter((role) => (map.jobRoles || []).includes(role)))];
  const input = $<HTMLInputElement>('door-role-input');
  input.disabled = !map.jobRoles?.length;
  input.value = '';
  $('door-role-suggestions').hidden = true;
  renderRoleTags();
  doorMarkers = doorMarkersForRoles(doorTiles, state.doorRoles);
}

function renderRoleTags(): void {
  const list = $('door-role-tags');
  list.replaceChildren();
  for (const role of state.doorRoles) {
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'role-tag';
    tag.textContent = `${role} ×`;
    tag.setAttribute('aria-label', `Remove ${role}`);
    tag.onclick = () => setDoorRoles(state.doorRoles.filter((item) => item !== role));
    list.append(tag);
  }
  $('clear-door-roles').hidden = !state.doorRoles.length;
}

function hideSuggestions(): void {
  const input = $('door-role-input');
  $('door-role-suggestions').hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function setDoorRoles(roles: string[]): void {
  state.doorRoles = roles;
  doorMarkers = doorMarkersForRoles(doorTiles, roles);
  renderRoleTags();
  const input = $<HTMLInputElement>('door-role-input');
  input.value = '';
  input.focus();
  hideSuggestions();
  suggestedRoles = [];
  suggestedRoleIndex = 0;
  redraw();
  share();
}

function showSuggestions(): void {
  const input = $<HTMLInputElement>('door-role-input');
  const list = $('door-role-suggestions');
  suggestedRoles = roleSuggestions(state.map?.jobRoles || [], input.value, state.doorRoles);
  suggestedRoleIndex = 0;
  list.replaceChildren();
  for (const [index, role] of suggestedRoles.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `role-suggestion-${index}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === 0));
    button.textContent = role;
    // Keep focus in the input so the blur handler does not hide the list first.
    button.onpointerdown = (event) => event.preventDefault();
    button.onclick = () => setDoorRoles([...state.doorRoles, role]);
    list.append(button);
  }
  list.hidden = !suggestedRoles.length;
  input.setAttribute('aria-expanded', String(!list.hidden));
  if (suggestedRoles.length) input.setAttribute('aria-activedescendant', 'role-suggestion-0');
  else input.removeAttribute('aria-activedescendant');
}

function onSuggestionKey(event: KeyboardEvent): void {
  const input = $<HTMLInputElement>('door-role-input');
  if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      input.blur();
      return;
    }
    if (event.key === 'Enter') {
      const role = suggestedRoles[suggestedRoleIndex];
      if (!$('door-role-suggestions').hidden && role) setDoorRoles([...state.doorRoles, role]);
      return;
    }
    if (!suggestedRoles.length) return;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    suggestedRoleIndex = (suggestedRoleIndex + step + suggestedRoles.length) % suggestedRoles.length;
    for (const [index, button] of [...$('door-role-suggestions').children].entries())
      button.setAttribute('aria-selected', String(index === suggestedRoleIndex));
    input.setAttribute('aria-activedescendant', `role-suggestion-${suggestedRoleIndex}`);
  } else if (event.key === 'Backspace' && !input.value && state.doorRoles.length) {
    event.preventDefault();
    setDoorRoles(state.doorRoles.slice(0, -1));
  }
}

export function initDoorRoles(): void {
  const input = $<HTMLInputElement>('door-role-input');
  input.oninput = showSuggestions;
  input.onfocus = showSuggestions;
  input.onclick = showSuggestions;
  input.onblur = hideSuggestions;
  input.onkeydown = onSuggestionKey;
  $('clear-door-roles').onclick = () => setDoorRoles([]);
}
