// The shareable URL fragment: the view, selection and sidebar options are
// written back to the address bar so any state can be linked.
import { $, checkbox } from '../core/dom.ts';
import { invalidateUtilityPaths } from '../rendering/infrastructure-overlay.ts';
import { updateSpaceAnimation } from '../rendering/space-background.ts';
import { constrainCamera } from '../rendering/projection.ts';
import type { Network } from '../core/types.ts';
import { updateNetworkSummary, restoreInfrastructureOrder } from './infrastructure-controls.ts';
import { infrastructureOrder, enabledNetworks, palette, state } from '../core/state.ts';
import {
  DEFAULT_INFRASTRUCTURE_ORDER,
  infrastructureOrderParam,
  normalizeInfrastructureOrder,
} from '../model/infrastructure-order.ts';
import {
  decodeOptions,
  encodeOptions,
  optionBits,
  viewFragment,
  type OptionKey,
} from '../model/view-state.ts';

/** Updates to the fragment are coalesced so dragging does not rewrite history every frame. */
const SHARE_DELAY_MS = 150;
let shareTimer: ReturnType<typeof setTimeout> | undefined;

function optionsFragment(): string {
  const params = new URLSearchParams({ o: String(currentOptionMask()) });
  const order = infrastructureOrderParam(infrastructureOrder);
  if (order) params.set('u', order);
  return `#${params}`;
}

export function currentOptionMask(): number {
  const options = {} as Record<OptionKey, boolean>;
  for (const key of Object.keys(optionBits) as OptionKey[]) options[key] = checkbox(key).checked;
  return encodeOptions(options);
}

/** Writes the current state into the URL fragment, immediately or after a short delay. */
export function share(immediate = false): void {
  clearTimeout(shareTimer);
  const apply = () => {
    constrainCamera();
    state.optionMask = currentOptionMask();
    if (!state.map) {
      history.replaceState(null, '', optionsFragment());
      return;
    }
    history.replaceState(null, '', viewFragment({ ...state, map: state.map, infrastructureOrder }));
  };
  if (immediate) apply();
  else shareTimer = setTimeout(apply, SHARE_DELAY_MS);
}

/** Applies the `o=` option bits of a link to the sidebar toggles. */
export function restoreOptions(params: URLSearchParams): boolean {
  if (params.has('u')) restoreInfrastructureOrder(normalizeInfrastructureOrder(params.get('u')!.split(',')));
  else if (params.has('m') || params.has('o')) restoreInfrastructureOrder(DEFAULT_INFRASTRUCTURE_ORDER);
  const raw = params.get('o');
  if (raw === null) return false;
  const options = decodeOptions(raw);
  if (!options) return false;
  for (const [key, value] of Object.entries(options) as [OptionKey, boolean][]) checkbox(key).checked = value;
  for (const key of Object.keys(palette) as Network[]) {
    if (options[key]) enabledNetworks.add(key);
    else enabledNetworks.delete(key);
  }
  state.regions = options.regions;
  state.cutaway = options.cutaway;
  state.motion = options.motion;
  updateSpaceAnimation();
  invalidateUtilityPaths();
  updateNetworkSummary();
  return true;
}

export function currentHashParams(): URLSearchParams {
  return new URLSearchParams(location.hash.slice(1));
}

/** Replaces the fragment with the options alone, as shown on the station picker. */
export function shareOptionsOnly(): void {
  const fragment =
    currentHashParams().has('o') || infrastructureOrderParam(infrastructureOrder) ? optionsFragment() : '';
  history.replaceState(null, '', location.pathname + location.search + fragment);
}

/** Every option toggle updates the link when it changes. */
export function initOptionSharing(): void {
  for (const key of Object.keys(optionBits)) $(key).addEventListener('change', () => share());
}
