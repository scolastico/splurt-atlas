// The animated space backdrop behind the station: a nebula gradient and three
// star planes that drift with the camera at different rates. It paints on its
// own canvas so station frames never repaint it.
import { spaceCanvas, spaceContext } from './canvases.ts';
import { state } from '../core/state.ts';

const PLANE_SIZE = 1024;
const BACKGROUND_FPS = 30;

/** Three tiling star textures, generated once from a fixed seed. */
const starPlanes = [0, 1, 2].map((plane) => {
  const tile = document.createElement('canvas');
  tile.width = tile.height = PLANE_SIZE;
  const context = tile.getContext('2d')!;
  let seed = 4129 + plane * 923;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 180 - plane * 40; i++) {
    const x = random() * PLANE_SIZE;
    const y = random() * PLANE_SIZE;
    const radius = random() > 0.96 ? 1.6 : 0.4 + random() * 0.5;
    context.fillStyle = `rgba(${plane === 2 ? '222,189,140' : '150,189,212'},${0.15 + random() * 0.6})`;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
  return tile;
});

let animationFrame = 0;
/** Elapsed animation time in seconds; frozen while motion is off. */
let spaceTime = 0;
let lastFrameTime: number | null = null;
let lastPaintTime = 0;

export function drawBackground(): void {
  const context = spaceContext;
  context.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  context.fillStyle = '#081522';
  context.fillRect(0, 0, state.w, state.h);
  const parallax = state.motion ? 1 : 0;
  const nebulaX = state.w * (0.6 + Math.sin(spaceTime / 95) * 0.15) - state.x * 0.018 * parallax;
  const nebulaY = state.h * (0.45 + Math.cos(spaceTime / 120) * 0.15) - state.y * 0.018 * parallax;
  const nebula = context.createRadialGradient(
    nebulaX,
    nebulaY,
    0,
    nebulaX,
    nebulaY,
    Math.max(state.w, state.h),
  );
  nebula.addColorStop(0, '#163340');
  nebula.addColorStop(0.4, '#102434');
  nebula.addColorStop(1, '#09101e');
  context.fillStyle = nebula;
  context.fillRect(0, 0, state.w, state.h);
  for (let plane = 0; plane < starPlanes.length; plane++) {
    const speed = 0.025 + plane * 0.03;
    const offsetX =
      (((-state.x * speed * parallax + spaceTime * (3 + plane * 4)) % PLANE_SIZE) + PLANE_SIZE) % PLANE_SIZE;
    const offsetY =
      (((-state.y * speed * parallax + spaceTime * (1 + plane * 1.4)) % PLANE_SIZE) + PLANE_SIZE) %
      PLANE_SIZE;
    for (let x = offsetX - PLANE_SIZE; x < state.w; x += PLANE_SIZE)
      for (let y = offsetY - PLANE_SIZE; y < state.h; y += PLANE_SIZE)
        context.drawImage(starPlanes[plane], x, y);
  }
}

function animate(timestamp: number): void {
  animationFrame = 0;
  if (!state.motion || document.hidden) {
    lastFrameTime = null;
    return;
  }
  if (lastFrameTime !== null) spaceTime += Math.min(0.1, (timestamp - lastFrameTime) / 1000);
  lastFrameTime = timestamp;
  if (timestamp - lastPaintTime >= 1000 / BACKGROUND_FPS) {
    drawBackground();
    lastPaintTime = timestamp;
  }
  animationFrame = requestAnimationFrame(animate);
}

/** Repaints the backdrop and starts or stops its animation to match the motion setting. */
export function updateSpaceAnimation(): void {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  lastFrameTime = null;
  drawBackground();
  if (state.motion && !document.hidden) animationFrame = requestAnimationFrame(animate);
}

export function resizeBackground(width: number, height: number): void {
  spaceCanvas.width = width;
  spaceCanvas.height = height;
}
