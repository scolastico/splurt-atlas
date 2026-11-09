// Which strip images a deck needs at the current zoom, and drawing them.
// Every tile is one strip image containing all of its channels, so a deck view
// costs one request per tile and its channels always arrive together.
import { renderer as mainRenderer } from './canvases.ts';
import { assetCache } from '../data/source.ts';
import { isChecked } from '../core/dom.ts';
import type { TextureHandle, Renderer } from './gl-renderer.ts';
import { primaryImages, type createImageCache } from './images.ts';
import { setLoading } from '../ui/loading.ts';
import { createProjection } from './projection.ts';
import {
  enabledNetworks,
  infrastructureOrder,
  state as mainState,
  type DeckLevel,
  type ViewerState,
} from '../core/state.ts';
import { createUtilityPainter } from './infrastructure-overlay.ts';
import { deckScale, detailForZoom, type Detail } from '../model/view-state.ts';
import { slotIndex, stripName } from '../../scripts/lib/map-format.mjs';
import { channelsForDeck } from '../model/deck-channels.ts';

export interface DeckTile {
  path: string;
  mask: number;
  lod: number | 'overview';
  tx?: number;
  ty?: number;
  /** Placement in world pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Size of one slot of the strip in image pixels. */
  sw: number;
  sh: number;
  image?: TextureHandle | null;
}

export interface DeckTileSet {
  detail: Detail;
  lod: number | 'overview';
  items: DeckTile[];
}

interface TileSource {
  handle: TextureHandle;
  mask: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

interface Margin {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function createDeckPainter(
  state: ViewerState,
  renderer: Renderer,
  images: ReturnType<typeof createImageCache>,
  projection = createProjection(state),
) {
  const { ensureImage, frameImages, getImage, imageForFrame, prefetchImages, setWarmImages } = images;
  const { screenCenterX, screenCenterY } = projection;
  const { drawUtilitySymbols } = createUtilityPainter(state, renderer);
  /** Direction the camera moved since the last frame, as -1, 0 or 1 per axis. */
  const panDirection = { x: 0, y: 0 };
  const lastCamera = { x: NaN, y: NaN, zoom: NaN };

  /** Records the camera motion between frames; it steers the prefetch, and zooming resets it. */
  function trackCameraMotion(): void {
    const samePlane = state.zoom === lastCamera.zoom;
    panDirection.x = samePlane ? Math.sign(state.x - lastCamera.x) : 0;
    panDirection.y = samePlane ? Math.sign(state.y - lastCamera.y) : 0;
    lastCamera.x = state.x;
    lastCamera.y = state.y;
    lastCamera.zoom = state.zoom;
  }

  function overviewTiles(z: number, data: DeckLevel, path: string): DeckTile[] {
    const map = state.map!;
    const tilePixels = state.manifest!.tilePixels;
    const items: DeckTile[] = [];
    // Lower decks only need the terrain strip; utilities show on the viewed deck.
    const strips: [string, number][] = [
      ['overview', data.overview],
      ['overview-utilities', z === state.z ? data.overviewUtilities : 0],
    ];
    for (const [file, mask] of strips)
      if (mask)
        items.push({
          path: `${path}/${file}.webp`,
          mask,
          lod: 'overview',
          x: 0,
          y: 0,
          w: map.width * tilePixels,
          h: map.height * tilePixels,
          sw: map.width * 4,
          sh: map.height * 4,
        });
    return items;
  }

  /** The strips a deck needs for a zoom, optionally extended by a margin in world pixels. */
  function deckTiles(
    z: number,
    zoom = state.zoom,
    viewZoom = zoom,
    margin: Margin | null = null,
  ): DeckTileSet | null {
    const data = state.levels.get(z);
    if (!data) return null;
    const tilePixels = state.manifest!.tilePixels;
    const chunkSize = tilePixels * state.manifest!.chunkTiles;
    const detail = detailForZoom(zoom);
    const path = `${state.map!.id}/${z}`;
    if (detail === 'overview') return { detail, lod: 'overview', items: overviewTiles(z, data, path) };
    const scale = deckScale(viewZoom, state.z - z, state.motion);
    const left = state.x - screenCenterX() / scale - tilePixels - (margin?.left || 0);
    const top = state.y - screenCenterY() / scale - tilePixels - (margin?.top || 0);
    const right = state.x + (state.w - screenCenterX()) / scale + tilePixels + (margin?.right || 0);
    const bottom = state.y + (state.h - screenCenterY()) / scale + tilePixels + (margin?.bottom || 0);
    // Coarser levels pack 2x2 finer tiles per strip, so the image count per
    // frame stays similar at every zoom.
    const lod = Math.min(detail, data.pyramid.length - 1);
    const span = chunkSize << lod;
    const items: DeckTile[] = [];
    for (const [tx, ty, mask] of data.pyramid[lod]) {
      const outside =
        (tx + 1) * span < left || tx * span > right || (ty + 1) * span < top || ty * span > bottom;
      if (outside) continue;
      items.push({
        path: `${path}/${stripName(tx, ty, lod)}`,
        mask,
        lod,
        tx,
        ty,
        x: tx * span,
        y: ty * span,
        w: span,
        h: span,
        sw: chunkSize,
        sh: chunkSize,
      });
    }
    return { detail, lod, items };
  }

  /**
   * A tile that is not decoded yet borrows the matching part of its nearest
   * decoded coarser level (or the overview), so only that tile looks soft while
   * it loads instead of the whole deck dropping a resolution.
   */
  function tileSources(z: number, item: DeckTile): TileSource[] {
    if (item.image) return [{ handle: item.image, mask: item.mask, sx: 0, sy: 0, sw: item.sw, sh: item.sh }];
    if (item.lod === 'overview') return [];
    const data = state.levels.get(z)!;
    const tilePixels = state.manifest!.tilePixels;
    const chunkSize = tilePixels * state.manifest!.chunkTiles;
    for (let lod = item.lod + 1; lod < data.pyramid.length; lod++) {
      const levels = lod - item.lod;
      const tx = item.tx! >> levels;
      const ty = item.ty! >> levels;
      const mask = data.tileMasks[lod].get(`${tx},${ty}`);
      if (mask === undefined) continue;
      const path = `${state.map!.id}/${z}/${stripName(tx, ty, lod)}`;
      const entry = getImage(path);
      if (!entry?.ready || !entry.image) continue;
      frameImages.add(path);
      const size = chunkSize >> levels;
      const within = (1 << levels) - 1;
      return [
        {
          handle: entry.image,
          mask,
          sx: (item.tx! & within) * size,
          sy: (item.ty! & within) * size,
          sw: size,
          sh: size,
        },
      ];
    }
    const sources: TileSource[] = [];
    const factor = 4 / tilePixels;
    const strips: [string, number][] = [
      ['overview', data.overview],
      ['overview-utilities', z === state.z ? data.overviewUtilities : 0],
    ];
    for (const [file, mask] of strips) {
      if (!mask) continue;
      const path = `${state.map!.id}/${z}/${file}.webp`;
      const entry = getImage(path);
      if (!entry?.ready || !entry.image) continue;
      frameImages.add(path);
      sources.push({
        handle: entry.image,
        mask,
        sx: item.x * factor,
        sy: item.y * factor,
        sw: item.w * factor,
        sh: item.h * factor,
      });
    }
    return sources;
  }

  /** Channels to draw for a deck, in order: base, utilities on the viewed deck, foreground. */
  function deckChannels(z: number): string[] {
    return channelsForDeck(
      z === state.z,
      enabledNetworks,
      isChecked('simple-utilities') && !!state.map!.infrastructure?.nodes?.length,
      isChecked('mapping-helpers'),
      infrastructureOrder,
      isChecked('power-networks'),
      isChecked('random-markers'),
    );
  }

  /** Prefetches one tile beyond the edges the camera is moving toward, at low priority. */
  function prefetchAhead(z: number, set: DeckTileSet): void {
    if (set.lod === 'overview' || (!panDirection.x && !panDirection.y)) return;
    const span = (state.manifest!.tilePixels * state.manifest!.chunkTiles) << set.lod;
    const margin: Margin = {
      left: panDirection.x < 0 ? span : 0,
      right: panDirection.x > 0 ? span : 0,
      top: panDirection.y < 0 ? span : 0,
      bottom: panDirection.y > 0 ? span : 0,
    };
    for (const item of deckTiles(z, state.zoom, state.zoom, margin)?.items || []) {
      prefetchImages.add(item.path);
      const entry = getImage(item.path);
      if (entry) entry.used = performance.now();
      else ensureImage(item.path, false, item.mask);
    }
  }

  function drawDeck(z: number, shade: number): void {
    const set = deckTiles(z);
    if (!set) return;
    const scale = deckScale(state.zoom, state.z - z, state.motion);
    const centerX = screenCenterX();
    const centerY = screenCenterY();
    const { dpr } = state;
    const naturalTerrain = isChecked('runtime-terrain');
    for (const item of set.items) {
      item.image = imageForFrame(item.path, item.mask);
      assetCache.priorityPaths?.add(item.path);
    }
    prefetchAhead(z, set);
    const sources = set.items.map((item) => tileSources(z, item));
    renderer.beginDeck(shade);
    for (const channel of deckChannels(z)) {
      if (channel.includes('-symbols')) {
        drawUtilitySymbols(channel, scale, centerX, centerY);
        continue;
      }
      for (const [index, item] of set.items.entries())
        for (const source of sources[index]) {
          const slot = slotIndex(source.mask, channel);
          if (slot < 0) continue;
          const dx = ((item.x - state.x) * scale + centerX) * dpr;
          const dy = ((item.y - state.y) * scale + centerY) * dpr;
          const dw = item.w * scale * dpr;
          const dh = item.h * scale * dpr;
          renderer.draw(source.handle, slot, source.sx, source.sy, source.sw, source.sh, dx, dy, dw, dh);
          // Generated terrain is layered over the base rather than replacing it: a coarser
          // strip carries terrain only in the quadrants whose chunks had placeholder turfs,
          // and the rest of that slot is transparent.
          if (channel === 'base' && naturalTerrain) {
            const terrain = slotIndex(source.mask, 'natural');
            if (terrain >= 0)
              renderer.draw(
                source.handle,
                terrain,
                source.sx,
                source.sy,
                source.sw,
                source.sh,
                dx,
                dy,
                dw,
                dh,
              );
          }
          break;
        }
    }
    renderer.endDeck();
  }

  /**
   * Loads what the first frame of a station draws, reporting progress, and
   * queues the zoom neighbors afterwards so the first zoom step needs no new
   * requests without delaying the station.
   */
  async function prepareView(generation: number): Promise<void> {
    const map = state.map!;
    const first = new Map<string, number>();
    const warm = new Map<string, number>();
    const visibleLevels = map.levels.filter((z) => z <= state.z && (state.cutaway || z === state.z));
    for (const z of map.levels) {
      const data = state.levels.get(z);
      if (data?.overview) (z <= state.z ? first : warm).set(`${map.id}/${z}/overview.webp`, data.overview);
    }
    for (const z of visibleLevels) {
      for (const item of deckTiles(z)!.items) first.set(item.path, item.mask);
      for (const zoom of [state.zoom / 1.5, state.zoom / 2, state.zoom * 1.5])
        for (const item of deckTiles(z, zoom)?.items || [])
          if (!first.has(item.path)) warm.set(item.path, item.mask);
    }
    setWarmImages([...first.keys(), ...warm.keys()]);
    assetCache.priorityPaths = new Set([
      `${map.id}/map.json`,
      `${map.id}/search.json`,
      `${map.id}/${state.z}.json`,
      ...first.keys(),
      ...warm.keys(),
    ]);
    for (const [path, mask] of first) ensureImage(path, true, mask);
    for (const [path, mask] of warm) ensureImage(path, false, mask);
    let count = 0;
    await Promise.all(
      [...first.keys()].map(async (path) => {
        await getImage(path)?.promise;
        if (generation === state.generation)
          setLoading(
            `Decoding the current view · ${++count} / ${first.size} images`,
            true,
            count / first.size,
          );
      }),
    );
  }

  return { deckTiles, drawDeck, trackCameraMotion, prepareView, panDirection };
}
export const { deckTiles, drawDeck, trackCameraMotion, prepareView, panDirection } = createDeckPainter(
  mainState,
  mainRenderer,
  primaryImages,
);
