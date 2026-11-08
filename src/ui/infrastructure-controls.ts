import { $, isChecked, readSetting, writeSetting } from '../core/dom.ts';
import { redraw } from '../core/frame.ts';
import { enabledNetworks, infrastructureOrder, networkNames, state } from '../core/state.ts';
import type { Network } from '../core/types.ts';
import {
  normalizeInfrastructureOrder,
  networkSummary,
  DEFAULT_INFRASTRUCTURE_ORDER,
  infrastructureOrderParam,
  type Infrastructure,
} from '../model/infrastructure-order.ts';
import { invalidateUtilityPaths } from '../rendering/infrastructure-overlay.ts';
import { share } from './url-state.ts';

const ORDER_SETTING = 'atlas-infrastructure-order';

export function restoreInfrastructureOrder(order: readonly Infrastructure[]): void {
  infrastructureOrder.splice(0, infrastructureOrder.length, ...normalizeInfrastructureOrder(order));
  const list = $('network-controls');
  for (const key of infrastructureOrder) {
    const row = list.querySelector<HTMLElement>(`[data-network="${key}"]`);
    if (row) list.append(row);
  }
  writeSetting(ORDER_SETTING, JSON.stringify(infrastructureOrder));
  $<HTMLButtonElement>('reset-infrastructure-order').disabled =
    !infrastructureOrderParam(infrastructureOrder);
  $('reset-infrastructure-order').hidden = !infrastructureOrderParam(infrastructureOrder);
  invalidateUtilityPaths();
  redraw();
}

export function updateNetworkSummary(): void {
  $('network-summary').textContent = state.map?.infrastructure
    ? networkSummary(state.map.infrastructure.powerNetworks)
    : '';
  $('power-network-color-hint').hidden = !isChecked('power-networks');
}

/** Dedicated handles support mouse, pen and touch without dragging checkboxes. */
export function initNetworkControls(): void {
  try {
    infrastructureOrder.splice(
      0,
      infrastructureOrder.length,
      ...normalizeInfrastructureOrder(JSON.parse(readSetting(ORDER_SETTING) || 'null')),
    );
  } catch {
    infrastructureOrder.splice(0, infrastructureOrder.length, ...normalizeInfrastructureOrder(null));
  }
  const list = $('network-controls');
  const rows = () => [...list.querySelectorAll<HTMLElement>('[data-network]')];
  const save = () => {
    infrastructureOrder.splice(
      0,
      infrastructureOrder.length,
      ...rows().map((row) => row.dataset.network as Infrastructure),
    );
    writeSetting(ORDER_SETTING, JSON.stringify(infrastructureOrder));
    $<HTMLButtonElement>('reset-infrastructure-order').disabled =
      !infrastructureOrderParam(infrastructureOrder);
    $('reset-infrastructure-order').hidden = !infrastructureOrderParam(infrastructureOrder);
    invalidateUtilityPaths();
    redraw();
    share();
  };
  const announce = (row: HTMLElement) => {
    $('network-order-status').textContent =
      `${networkNames[row.dataset.network as Network]}: position ${rows().indexOf(row) + 1} of ${rows().length}, top layer first.`;
  };
  let stopDrag: ((cancel: boolean) => void) | undefined;
  for (const key of infrastructureOrder) {
    const row = document.createElement('div');
    row.className = 'network-row';
    row.dataset.network = key;
    row.innerHTML = `<button type="button" class="network-drag-handle" aria-label="Reorder ${networkNames[key]}. Use Up and Down arrow keys." title="Drag to reorder"><svg viewBox="0 0 16 24" width="16" height="24" aria-hidden="true"><path d="M4 5h1m6 0h1M4 12h1m6 0h1M4 19h1m6 0h1" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></button><label class="toggle-row"><span>${networkNames[key]}</span><input type="checkbox" id="${key}" aria-label="${networkNames[key]}"></label>`;
    const handle = row.querySelector<HTMLButtonElement>('button')!;
    const input = row.querySelector<HTMLInputElement>('input')!;
    input.checked = enabledNetworks.has(key);
    input.onchange = () => {
      if (input.checked) enabledNetworks.add(key);
      else enabledNetworks.delete(key);
      invalidateUtilityPaths();
      redraw();
    };
    handle.onkeydown = (event) => {
      if (event.key === 'Escape') {
        stopDrag?.(true);
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = rows();
      const index = current.indexOf(row);
      const target =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? current.length - 1
            : Math.max(0, Math.min(current.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
      if (target === index) return;
      list.insertBefore(row, target < index ? current[target] : current[target].nextSibling);
      save();
      announce(row);
      handle.focus();
    };
    handle.onpointerdown = (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      stopDrag?.(true);
      const original = rows();
      const startX = event.clientX,
        startY = event.clientY;
      let lastY = event.clientY;
      let active = false,
        frame = 0;
      handle.setPointerCapture(event.pointerId);
      const scroll = list.closest<HTMLElement>('.sidebar-scroll');
      const moveRow = () => {
        const before = rows()
          .filter((other) => other !== row)
          .find((other) => {
            const rect = other.getBoundingClientRect();
            return lastY < rect.top + rect.height / 2;
          });
        if (row.nextElementSibling !== (before || null)) {
          list.insertBefore(row, before || null);
          handle.setPointerCapture(event.pointerId);
          save();
        }
      };
      const tick = () => {
        if (scroll) {
          const rect = scroll.getBoundingClientRect();
          const amount = lastY < rect.top + 32 ? -8 : lastY > rect.bottom - 32 ? 8 : 0;
          if (amount) {
            scroll.scrollTop += amount;
            moveRow();
          }
        }
        frame = requestAnimationFrame(tick);
      };
      const start = () => {
        active = true;
        row.classList.add('is-dragging');
        list.classList.add('is-reordering');
        handle.setAttribute('aria-pressed', 'true');
        frame = requestAnimationFrame(tick);
        $('network-order-status').textContent = `Dragging ${networkNames[key]}.`;
      };
      const finish = (cancel: boolean) => {
        cancelAnimationFrame(frame);
        if (cancel && active) {
          list.append(...original);
          save();
        }
        row.classList.remove('is-dragging');
        list.classList.remove('is-reordering');
        handle.removeAttribute('aria-pressed');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', cancelDrag);
        handle.removeEventListener('lostpointercapture', lostCapture);
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        if (active) {
          announce(row);
          handle.focus({ preventScroll: true });
        }
        stopDrag = undefined;
      };
      const move = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        lastY = next.clientY;
        const distance = Math.hypot(next.clientX - startX, next.clientY - startY);
        if (!active) {
          if (distance < 4) return;
          start();
        }
        next.preventDefault();
        moveRow();
      };
      const up = (next: PointerEvent) => {
        if (next.pointerId === event.pointerId) finish(false);
      };
      const cancelDrag = (next: PointerEvent) => {
        if (next.pointerId === event.pointerId) finish(true);
      };
      const lostCapture = () => {
        if (!handle.hasPointerCapture(event.pointerId)) finish(true);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', cancelDrag);
      handle.addEventListener('lostpointercapture', lostCapture);
      stopDrag = finish;
    };
    list.append(row);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') stopDrag?.(true);
  });
  const reset = $<HTMLButtonElement>('reset-infrastructure-order');
  reset.disabled = !infrastructureOrderParam(infrastructureOrder);
  reset.hidden = reset.disabled;
  reset.onclick = () => {
    stopDrag?.(true);
    restoreInfrastructureOrder(DEFAULT_INFRASTRUCTURE_ORDER);
    $('network-order-status').textContent = 'Infrastructure order reset to game order.';
    share();
  };
  $('transit').onchange = () => {
    if (isChecked('transit')) enabledNetworks.add('transit');
    else enabledNetworks.delete('transit');
    redraw();
  };
  for (const key of ['power-networks', 'simple-utilities', 'connections', 'connection-labels'])
    $(key).onchange = () => {
      if (key === 'power-networks' && isChecked('power-networks')) {
        enabledNetworks.add('power');
        $<HTMLInputElement>('power').checked = true;
      }
      updateNetworkSummary();
      invalidateUtilityPaths();
      redraw();
    };
}
