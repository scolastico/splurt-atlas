import type { Network } from '../core/types.ts';

export type Infrastructure = Exclude<Network, 'transit'>;

// Top to bottom for exposed infrastructure: LOW_OBJ_LAYER (beacons),
// PLUMBING_PIPE_VISIBILE_LAYER, GAS_PIPE_VISIBLE_LAYER, then FLOOR_PLANE's
// WIRE_LAYER and DISPOSAL_PIPE_LAYER. Individual piping layers stay intact.
export const DEFAULT_INFRASTRUCTURE_ORDER: readonly Infrastructure[] = [
  'navigation',
  'fluid',
  'pipes',
  'power',
  'disposal',
];

export function normalizeInfrastructureOrder(value: unknown): Infrastructure[] {
  const entries = Array.isArray(value) ? value : [];
  return [...new Set([...entries, ...DEFAULT_INFRASTRUCTURE_ORDER])].filter((key): key is Infrastructure =>
    DEFAULT_INFRASTRUCTURE_ORDER.includes(key),
  );
}

export function networkSummary(count: number): string {
  return `${count} separate mapped power networks.`;
}

/** Only custom orders need a URL field; absent fields represent game order. */
export function infrastructureOrderParam(order: readonly Infrastructure[]): string | null {
  return order.join(',') === DEFAULT_INFRASTRUCTURE_ORDER.join(',') ? null : order.join(',');
}

/** Native PIPING_LAYER_SHIFT: five atmospheric layers, five pixels per step. */
export function utilitySymbolOffset(channel: Network, layer: number): number {
  return channel === 'pipes' && layer >= 1 && layer <= 5 ? (layer - 3) * 5 : 0;
}
