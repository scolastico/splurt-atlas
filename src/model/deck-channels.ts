import { UTILITIES } from '../../scripts/lib/map-format.mjs';
import type { Network } from '../core/types.ts';

/** Terrain first, underfloor reveals, furniture/walls, then overhead transit tubes. */
export function channelsForDeck(
  viewed: boolean,
  networks: ReadonlySet<Network>,
  simple: boolean,
  helpers: boolean,
): string[] {
  const channels = ['base'];
  if (viewed)
    for (const channel of UTILITIES) {
      if (channel === 'transit' || (simple && ['power', 'pipes'].includes(channel))) continue;
      channels.push(`${channel}-surface`);
      if (networks.has(channel as Network)) channels.push(channel);
    }
  channels.push('foreground');
  if (viewed && networks.has('transit')) channels.push('transit');
  if (viewed && helpers) channels.push('helpers');
  return channels;
}
