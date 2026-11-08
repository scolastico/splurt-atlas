import type { Network } from '../core/types.ts';
import { DEFAULT_INFRASTRUCTURE_ORDER, type Infrastructure } from './infrastructure-order.ts';

/** Exposed utilities stay in-world; enabled networks reveal above foreground obstructions. */
export function channelsForDeck(
  viewed: boolean,
  networks: ReadonlySet<Network>,
  simple: boolean,
  helpers: boolean,
  order: readonly Infrastructure[] = DEFAULT_INFRASTRUCTURE_ORDER,
  coloredPower = false,
  randomMarkers = false,
): string[] {
  const channels = ['base'];
  const addNetwork = (channel: Infrastructure, reveal: boolean) => {
    const symbols = simple && ['power', 'pipes'].includes(channel);
    channels.push(`${channel}${symbols ? '-symbols' : ''}-surface`);
    if (!symbols && coloredPower && channel === 'power') channels.push('power-symbols-surface');
    if (reveal) {
      channels.push(`${channel}${symbols ? '-symbols' : ''}`);
      if (!symbols && coloredPower && channel === 'power') channels.push('power-symbols');
      if (channel === 'pipes') channels.push('pipes-equipment');
    }
  };
  if (viewed)
    for (const channel of [...order].reverse()) if (!networks.has(channel)) addNetwork(channel, false);
  channels.push('pipes-floor-equipment');
  if (!viewed || !networks.has('pipes')) channels.push('pipes-equipment');
  channels.push(randomMarkers ? 'foreground-mapper' : 'foreground');
  if (viewed)
    for (const channel of [...order].reverse()) if (networks.has(channel)) addNetwork(channel, true);
  if (viewed && networks.has('transit')) channels.push('transit');
  if (randomMarkers) channels.push('random-markers');
  if (viewed && helpers) channels.push('helpers');
  return channels;
}
