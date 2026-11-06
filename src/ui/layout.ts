// Sidebar layout: collapsing, the three sidebar views, the drag handle that
// resizes the sidebar (or the bottom sheet on portrait phones), and the
// insets the map must leave for it.
import { $, readSetting, writeSetting } from '../core/dom.ts';
import { redraw } from '../core/frame.ts';
import { reducedMotion } from '../core/state.ts';

export type SidebarView = 'explore' | 'search' | 'inspect';

const NARROW_LAYOUT = '(max-width:650px)';
const DEFAULT_SIDEBAR_WIDTH = 320;
const DEFAULT_SHEET_FRACTION = 0.48;
/** The sidebar's CSS transition, during which the map keeps repainting. */
const PANEL_TRANSITION_MS = 260;

let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
let sheetHeight = innerHeight * DEFAULT_SHEET_FRACTION;
let panelTransitionUntil = 0;

export function isNarrowLayout(): boolean {
  return innerWidth <= 650;
}

/** Portrait phones show the sidebar as a bottom sheet. */
export function isPortraitPanel(): boolean {
  return matchMedia('(max-width:650px) and (orientation:portrait)').matches;
}

/** Width of the map covered by the sidebar on the left. */
export function sidebarInset(): number {
  if (isNarrowLayout()) return 0;
  const rect = $('sidebar').getBoundingClientRect();
  return Math.max(0, Math.min(rect.width, rect.right));
}

/** Height of the map covered by the bottom sheet. */
export function bottomSidebarInset(): number {
  if (!isPortraitPanel()) return 0;
  const rect = $('sidebar').getBoundingClientRect();
  return Math.max(0, Math.min(rect.height, innerHeight - rect.top));
}

/** True while the sidebar is sliding, so frames keep up with its changing inset. */
export function isSidebarAnimating(): boolean {
  return performance.now() < panelTransitionUntil;
}

export function isSidebarCollapsed(): boolean {
  return document.body.classList.contains('sidebar-collapsed');
}

export function setSidebarCollapsed(collapsed: boolean, persist = true): void {
  const changed = isSidebarCollapsed() !== collapsed;
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  $('sidebar').inert = collapsed;
  const toggle = $('sidebar-toggle');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  toggle.textContent = isPortraitPanel() ? (collapsed ? '↑' : '↓') : collapsed ? '›' : '‹';
  if (persist) {
    if (changed && !reducedMotion.matches) panelTransitionUntil = performance.now() + PANEL_TRANSITION_MS;
    redraw();
    writeSetting('atlas-sidebar-collapsed', String(collapsed));
  }
}

export function showSidebarView(view: SidebarView): void {
  for (const name of ['explore', 'search', 'inspect'] as const) {
    $(name === 'inspect' ? 'selection-panel' : `${name}-panel`).hidden = name !== view;
    $(`${name}-tab`).setAttribute('aria-pressed', String(name === view));
  }
  document.querySelector('.sidebar-scroll')!.scrollTop = 0;
}

function applySidebarWidth(value: number, persist = false): void {
  const width = Math.round(Math.max(260, Math.min(value, 720, innerWidth - 40)));
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  $('sidebar-resize').setAttribute('aria-valuenow', String(width));
  if (persist) {
    redraw();
    sidebarWidth = width;
    writeSetting('atlas-sidebar-width', String(width));
  }
}

function applySheetHeight(value: number, persist = false): void {
  const height = Math.round(Math.max(220, Math.min(value, innerHeight - 100)));
  document.documentElement.style.setProperty('--sheet-height', `${height}px`);
  if (isPortraitPanel()) $('sidebar-resize').setAttribute('aria-valuenow', String(height));
  if (persist) {
    sheetHeight = height;
    writeSetting('atlas-sheet-height', String(height));
    redraw();
  }
}

function sizeSidebar(): void {
  applySidebarWidth(sidebarWidth);
  applySheetHeight(sheetHeight);
  const handle = $('sidebar-resize');
  handle.setAttribute('aria-orientation', isPortraitPanel() ? 'horizontal' : 'vertical');
  handle.setAttribute('aria-label', isPortraitPanel() ? 'Resize bottom panel' : 'Resize sidebar');
  setSidebarCollapsed(isSidebarCollapsed(), false);
  redraw();
}

function initResizeHandle(): void {
  const handle = $('sidebar-resize');
  handle.onpointerdown = (event) => {
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
  };
  handle.onpointermove = (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    if (isPortraitPanel()) applySheetHeight(innerHeight - event.clientY, true);
    else applySidebarWidth(event.clientX, true);
  };
  handle.onpointerup = (event) => {
    handle.releasePointerCapture(event.pointerId);
    document.body.classList.remove('resizing');
  };
  handle.onpointercancel = () => document.body.classList.remove('resizing');
  handle.onkeydown = (event) => {
    const keys = isPortraitPanel() ? ['ArrowDown', 'ArrowUp'] : ['ArrowLeft', 'ArrowRight'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (isPortraitPanel()) applySheetHeight(sheetHeight + (event.key === 'ArrowUp' ? 20 : -20), true);
    else applySidebarWidth(sidebarWidth + (event.key === 'ArrowRight' ? 20 : -20), true);
  };
  handle.ondblclick = () => {
    if (isPortraitPanel()) applySheetHeight(innerHeight * DEFAULT_SHEET_FRACTION, true);
    else applySidebarWidth(DEFAULT_SIDEBAR_WIDTH, true);
  };
}

/** Restores the saved layout and binds the sidebar controls. */
export function initLayout(onInspectTab: () => void): void {
  const savedCollapsed = readSetting('atlas-sidebar-collapsed');
  setSidebarCollapsed(
    savedCollapsed === null ? matchMedia(NARROW_LAYOUT).matches : savedCollapsed === 'true',
    false,
  );
  sidebarWidth = Number(readSetting('atlas-sidebar-width')) || DEFAULT_SIDEBAR_WIDTH;
  sheetHeight = Number(readSetting('atlas-sheet-height')) || sheetHeight;
  $('sidebar-toggle').onclick = () => setSidebarCollapsed(!isSidebarCollapsed());
  $('explore-tab').onclick = () => showSidebarView('explore');
  $('search-tab').onclick = () => showSidebarView('search');
  $('inspect-tab').onclick = onInspectTab;
  initResizeHandle();
  sizeSidebar();
  window.addEventListener('resize', sizeSidebar);
}
