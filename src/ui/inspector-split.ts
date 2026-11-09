// Each revision keeps its own scroll position and shares the available sidebar
// height with the other. The divider preference stays local to this browser.
import { $, readSetting, writeSetting } from '../core/dom.ts';

const setting = 'atlas-inspector-split';
const saved = Number(readSetting(setting));
let fraction = saved >= 0.2 && saved <= 0.8 ? saved : 0.5;
let selection = '';
let scroll = { current: 0, previous: 0 };

export function prepareInspectorLayout(key: string): void {
  const inspector = $('inspector');
  scroll =
    key === selection
      ? {
          current: inspector.querySelector('.current-tile')?.scrollTop || 0,
          previous: inspector.querySelector('.previous-tile')?.scrollTop || 0,
        }
      : { current: 0, previous: 0 };
  selection = key;
  inspector.classList.remove('split-inspector');
  document.querySelector('.sidebar-scroll')!.classList.remove('inspector-split-active');
}

export function splitInspector(previous: HTMLElement): void {
  const inspector = $('inspector');
  const current = document.createElement('section');
  current.className = 'current-tile inspector-revision';
  current.setAttribute('aria-label', 'Current tile');
  current.append(...[...inspector.childNodes].filter((node) => node !== previous));
  previous.classList.add('inspector-revision');
  previous.setAttribute('aria-label', 'Previous tile');
  const divider = document.createElement('div');
  divider.id = 'inspector-resize';
  divider.tabIndex = 0;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', 'Resize current and previous tile sections');
  divider.setAttribute('aria-orientation', 'horizontal');
  divider.setAttribute('aria-valuemin', '20');
  divider.setAttribute('aria-valuemax', '80');
  divider.title = 'Drag to resize sections. Double-click to reset.';

  const resize = (value: number, persist = false) => {
    fraction = Math.max(0.2, Math.min(0.8, value));
    inspector.style.setProperty('--inspector-current-share', `${fraction}fr`);
    inspector.style.setProperty('--inspector-previous-share', `${1 - fraction}fr`);
    divider.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    divider.setAttribute(
      'aria-valuetext',
      `Current ${Math.round(fraction * 100)}%, previous ${Math.round((1 - fraction) * 100)}%`,
    );
    if (persist) writeSetting(setting, String(fraction));
  };
  divider.onpointerdown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
  };
  divider.onpointermove = (event) => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    const rect = inspector.getBoundingClientRect();
    resize((event.clientY - rect.top - divider.offsetHeight / 2) / (rect.height - divider.offsetHeight));
  };
  divider.onpointerup = (event) => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    divider.releasePointerCapture(event.pointerId);
    resize(fraction, true);
  };
  divider.onkeydown = (event) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    resize(
      event.key === 'Home'
        ? 0.2
        : event.key === 'End'
          ? 0.8
          : fraction + (event.key === 'ArrowUp' ? -0.05 : 0.05),
      true,
    );
  };
  divider.ondblclick = () => resize(0.5, true);
  inspector.replaceChildren(current, divider, previous);
  inspector.classList.add('split-inspector');
  document
    .querySelector('.sidebar-scroll')!
    .classList.toggle('inspector-split-active', !$('selection-panel').hidden);
  resize(fraction);
  current.scrollTop = scroll.current;
  previous.scrollTop = scroll.previous;
}
