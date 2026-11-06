// Frame scheduling. Any module may request a repaint; the render module
// registers the function that actually paints. Keeping this separate avoids
// import cycles between the renderer and everything that triggers it.

let pendingFrame = 0;
let paint: () => void = () => {};

export function setFramePainter(painter: () => void): void {
  paint = painter;
}

/** Paints on the next animation frame unless one is already scheduled. */
export function redraw(): void {
  if (!pendingFrame)
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      paint();
    });
}

/** Paints immediately, dropping any scheduled frame. */
export function paintNow(): void {
  if (pendingFrame) cancelAnimationFrame(pendingFrame);
  pendingFrame = 0;
  paint();
}
