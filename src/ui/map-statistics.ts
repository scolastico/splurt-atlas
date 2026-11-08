import { $ } from '../core/dom.ts';
import { state } from '../core/state.ts';
import { mapStatistics } from '../model/map-statistics.ts';

export function paintMapStatistics(): void {
  $('map-statistics').hidden = !state.map;
  if (!state.map) return;
  const list = $('map-statistics-list');
  list.replaceChildren();
  for (const statistic of mapStatistics(state.map, state.levels.values())) {
    const row = document.createElement('div');
    const label = document.createElement('dt');
    const value = document.createElement('dd');
    label.textContent = statistic.label;
    value.textContent = statistic.value;
    if (statistic.id) value.id = statistic.id;
    row.append(label, value);
    list.append(row);
  }
}
