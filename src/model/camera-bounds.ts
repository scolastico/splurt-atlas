/** Keep the camera within the map, plus a small screen-space margin.
 * Every tile can still be centered, while some map remains visible at the limits.
 */
export function boundedCamera(
  x: number,
  y: number,
  zoom: number,
  mapWidth: number,
  mapHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  if (!(zoom > 0 && mapWidth > 0 && mapHeight > 0 && viewportWidth > 0 && viewportHeight > 0))
    return { x, y };
  const paddingX = Math.min(64, viewportWidth / 4) / zoom;
  const paddingY = Math.min(64, viewportHeight / 4) / zoom;
  return {
    x: Math.max(-paddingX, Math.min(mapWidth * 32 + paddingX, x)),
    y: Math.max(-paddingY, Math.min(mapHeight * 32 + paddingY, y)),
  };
}
