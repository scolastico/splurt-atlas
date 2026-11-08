// Utility symbols share the sprite layer stack, including user-defined order.
import { isChecked } from '../core/dom.ts';
import { redraw } from '../core/frame.ts';
import { state, TILE } from '../core/state.ts';
import type { InfrastructureNode } from '../core/types.ts';
import { renderer } from './canvases.ts';
import type { TextureHandle } from './gl-renderer.ts';
import { utilitySymbolOffset } from '../model/infrastructure-order.ts';

const PORTS = [
  [1, 0, -1],
  [2, 0, 1],
  [4, 1, 0],
  [8, -1, 0],
];
const textures = new Map<string, { handle?: TextureHandle }>();
let textureGeneration = 0;
let cachedNodes: InfrastructureNode[] | undefined;
let cachedKey = '';
let groups = new Map<string, InfrastructureNode[]>();

export function invalidateUtilityPaths(): void {
  cachedKey = '';
}

function texture(color: string, ports: number): TextureHandle | undefined {
  const key = `${color}:${ports}`;
  const cached = textures.get(key);
  if (cached) return cached.handle;
  const entry: { handle?: TextureHandle } = {};
  textures.set(key, entry);
  const generation = textureGeneration;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const context = canvas.getContext('2d')!;
  context.lineCap = 'round';
  context.beginPath();
  for (const [bit, dx, dy] of PORTS)
    if (ports & bit) {
      context.moveTo(16, 16);
      context.lineTo(16 + dx * 16, 16 + dy * 16);
    }
  if (!ports) {
    context.moveTo(13, 16);
    context.lineTo(19, 16);
  }
  context.strokeStyle = '#0c1729';
  context.lineWidth = 5;
  context.stroke();
  context.strokeStyle = color;
  context.lineWidth = 2.5;
  context.stroke();
  void createImageBitmap(canvas)
    .then((bitmap) => renderer.prepare(bitmap, 1))
    .then((handle) => {
      if (generation !== textureGeneration) {
        renderer.release(handle);
        return;
      }
      entry.handle = handle;
      redraw();
    })
    .catch(() => {});
  return undefined;
}

export function drawUtilitySymbols(channel: string, scale: number, centerX: number, centerY: number): void {
  const nodes = state.map?.infrastructure?.nodes;
  if (!nodes) return;
  if (nodes !== cachedNodes) {
    for (const entry of textures.values()) if (entry.handle) renderer.release(entry.handle);
    textures.clear();
    textureGeneration++;
    cachedNodes = nodes;
    cachedKey = '';
  }
  const simple = isChecked('simple-utilities'),
    colored = isChecked('power-networks');
  const key = `${state.z}:${simple}:${colored}`;
  if (cachedKey !== key) {
    groups = new Map();
    for (const node of nodes) {
      if (node.z !== state.z || !['power', 'pipes'].includes(node.channel)) continue;
      const coloredPower = colored && node.channel === 'power';
      if ((!simple && !coloredPower) || (simple && node.simpleEligible === false && !coloredPower)) continue;
      const group = `${node.channel}-symbols${node.exposed ? '-surface' : ''}`;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(node);
    }
    for (const group of groups.values()) group.sort((a, b) => a.layer - b.layer);
    cachedKey = key;
  }
  for (const node of groups.get(channel) || []) {
    const offset = utilitySymbolOffset(node.channel, node.layer);
    const x = ((node.x - 1) * TILE + offset - state.x) * scale + centerX;
    const y = ((state.map!.height - node.y) * TILE - offset - state.y) * scale + centerY;
    const size = TILE * scale;
    if (x + size < 0 || y + size < 0 || x > state.w || y > state.h) continue;
    const color =
      colored && node.channel === 'power' ? `hsl(${(node.network * 137.508) % 360} 85% 70%)` : node.color;
    const handle = texture(color, simple ? 15 : node.links);
    if (handle)
      renderer.draw(
        handle,
        0,
        0,
        0,
        TILE,
        TILE,
        x * state.dpr,
        y * state.dpr,
        size * state.dpr,
        size * state.dpr,
      );
  }
}
