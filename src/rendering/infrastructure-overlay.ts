// The utility network toggles and the "simple utility symbols" overlay that
// replaces cable and pipe sprites with lightweight crosses.
import { $, isChecked } from '../core/dom.ts';
import { redraw } from '../core/frame.ts';
import { applyWorldTransform, tileCenterX, tileCenterY } from './projection.ts';
import { enabledNetworks, networkNames, palette, state } from '../core/state.ts';
import type { Network } from '../core/types.ts';

/** NORTH, SOUTH, EAST, WEST port bits with their unit direction. */
const PORTS: [number, number, number][] = [
  [1, 0, -1],
  [2, 0, 1],
  [4, 1, 0],
  [8, -1, 0],
];
const ALL_PORTS = 15;

/** Stroke paths per color, cached per deck and toggle combination. */
const utilityPaths = new Map<string, Map<string, Path2D>>();

/** Drops the cached paths after a toggle or deck change. */
export function invalidateUtilityPaths(): void {
  utilityPaths.clear();
}

/** The color that distinguishes separate power networks. */
function networkColor(network: number): string {
  return `hsl(${(network * 137.508) % 360} 85% 70%)`;
}

function buildUtilityPaths(simple: boolean, colored: boolean): Map<string, Path2D> {
  const map = state.map!;
  const paths = new Map<string, Path2D>();
  for (const node of map.infrastructure!.nodes) {
    if (!['power', 'pipes'].includes(node.channel) || node.z !== state.z) continue;
    if (!enabledNetworks.has(node.channel) && !node.exposed) continue;
    const coloredPower = colored && node.channel === 'power';
    if (simple && node.simpleEligible === false && !coloredPower) continue;
    if (!simple && !coloredPower) continue;
    const color = coloredPower ? networkColor(node.network) : node.color;
    let path = paths.get(color);
    if (!path) paths.set(color, (path = new Path2D()));
    const x = tileCenterX(node.x);
    const y = tileCenterY(node.y);
    const ports = simple ? ALL_PORTS : node.links;
    for (const [bit, dx, dy] of PORTS)
      if (ports & bit) {
        path.moveTo(x, y);
        path.lineTo(x + dx * 16, y + dy * 16);
      }
    if (!ports) {
      path.moveTo(x - 3, y);
      path.lineTo(x + 3, y);
    }
  }
  return paths;
}

export function drawInfrastructure(context: CanvasRenderingContext2D): void {
  if (!state.map?.infrastructure) return;
  const simple = isChecked('simple-utilities');
  const colored = isChecked('power-networks');
  if (!simple && !colored) return;
  applyWorldTransform(context);
  const key = `${state.z}:${simple}:${colored}:${[...enabledNetworks].sort()}`;
  let paths = utilityPaths.get(key);
  if (!paths) utilityPaths.set(key, (paths = buildUtilityPaths(simple, colored)));
  context.lineCap = 'round';
  for (const [color, path] of paths) {
    context.strokeStyle = '#0c1729';
    context.lineWidth = 5;
    context.stroke(path);
    context.strokeStyle = color;
    context.lineWidth = 2.5;
    context.stroke(path);
  }
  context.lineCap = 'butt';
}

/** Creates one checkbox per utility network in the sidebar. */
export function initNetworkControls(): void {
  for (const key of Object.keys(palette) as Network[]) {
    const label = document.createElement('label');
    label.className = 'toggle-row';
    label.innerHTML = `<span>${networkNames[key]}</span><input type="checkbox" aria-label="${networkNames[key]}">`;
    const input = label.querySelector('input')!;
    input.onchange = () => {
      if (input.checked) enabledNetworks.add(key);
      else enabledNetworks.delete(key);
      redraw();
    };
    input.checked = enabledNetworks.has(key);
    input.id = key;
    $('network-controls').append(label);
  }
  for (const key of ['power-networks', 'simple-utilities', 'connections', 'connection-labels'])
    $(key).onchange = () => {
      // Coloring power networks implies showing the power layer.
      if (key === 'power-networks' && isChecked('power-networks')) {
        enabledNetworks.add('power');
        document.querySelector<HTMLInputElement>(
          '#network-controls input[aria-label="Power cables"]',
        )!.checked = true;
      }
      invalidateUtilityPaths();
      redraw();
    };
}
