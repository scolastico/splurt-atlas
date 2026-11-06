// The stacked canvases of the map viewport, bottom to top: the animated space
// background, the station imagery (WebGL with a Canvas 2D fallback), the
// annotation layer (room boundaries, utility symbols, selection) and the
// animated highlight overlay (search findings, door markers, stairs).
import { $ } from '../core/dom.ts';
import { create2dRenderer, createGlRenderer } from './gl-renderer.ts';

export const spaceCanvas = $<HTMLCanvasElement>('space');
export const spaceContext = spaceCanvas.getContext('2d', { alpha: false })!;

export const mapCanvas = $<HTMLCanvasElement>('map');
export const renderer = createGlRenderer(mapCanvas) || create2dRenderer(mapCanvas);

export const annotationCanvas = $<HTMLCanvasElement>('annotations');
export const annotationContext = annotationCanvas.getContext('2d')!;

export const highlightCanvas = $<HTMLCanvasElement>('connection-overlay');
export const highlightContext = highlightCanvas.getContext('2d')!;
