// Image resolution depends solely on zoom, never visible content or tile count.
export function detailForZoom(zoom) {
  return zoom < .125 ? 'overview' : zoom < .25 ? 2 : zoom < .5 ? 1 : 0;
}
export function deckScale(zoom, depth, motion) {
  return zoom / (motion ? 1 + depth * .12 : 1);
}
export function selectedTile(params, map) {
  const raw = params.get('t');
  if (!raw || !/^\d+,\d+,\d+$/.test(raw)) return null;
  const [x, y, z] = raw.split(',').map(Number);
  return x >= 1 && x <= map.width && y >= 1 && y <= map.height && map.levels.includes(z) ? { x, y, z } : null;
}
export const optionBits={pipes:0,power:1,disposal:2,transit:3,regions:4,cutaway:5,motion:6,'power-networks':7,'simple-utilities':8,connections:9,'connection-labels':10,'detailed-view':11,placed:12,possible:13,'runtime-terrain':14};
export function encodeOptions(options){let value=0;for(const [key,bit]of Object.entries(optionBits))if(options[key])value|=1<<bit;return value;}
export function decodeOptions(value){if(!/^\d+$/.test(String(value)))return null;const mask=Number(value);if(!Number.isSafeInteger(mask)||mask>0x7fffffff)return null;return Object.fromEntries(Object.entries(optionBits).map(([key,bit])=>[key,!!(mask&(1<<bit))]));}
export function viewFragment(state) {
  const params = new URLSearchParams({ m: state.map.id, z: state.z, x: Math.round(state.x), y: Math.round(state.y), s: String(Number(state.zoom.toFixed(3))) });
  if (state.selected) params.set('t', `${state.selected.x},${state.selected.y},${state.selected.z}`);
  if (state.query) params.set('q', state.query);
  if (state.result) { params.set('r', state.result); params.set('f', String((state.finding || 0) + 1)); }
  if(state.optionMask!==undefined)params.set('o',String(state.optionMask));
  return `#${params}`;
}
