/** Something on a minimap, in world meters. */
export interface MinimapDot {
  x: number;
  y: number;
  color: string;
  /** Radius in pixels on a 180-pixel map. Default 2.5. */
  size?: number;
}

/** What a minimap is drawn over: a picture of the world, and where it lies. */
export interface MinimapBase {
  image: CanvasImageSource;
  /** The world rectangle the image covers, meters. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Fill outside the image. */
  background: string;
  /** Smooth the image when scaled (terrain), or keep it crisp (a tile map). */
  smooth: boolean;
}

/**
 * A round, heading-up map of the world around (cx, cy), `viewRadius` meters to the edge, with dots clamped to its
 * rim and an arrow for you in the middle. Draws onto any 2D canvas, so the page's minimap and a headset's watch
 * share it.
 */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  size: number,
  base: MinimapBase,
  cx: number,
  cy: number,
  heading: number,
  dots: readonly MinimapDot[],
  viewRadius: number,
): void {
  const scale = size / (viewRadius * 2);
  const half = size / 2;
  ctx.save();
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = base.background;
  ctx.fillRect(0, 0, size, size);
  ctx.translate(half, half);
  ctx.rotate(-(heading + Math.PI / 2));
  ctx.imageSmoothingEnabled = base.smooth;
  ctx.drawImage(base.image, (base.x - cx) * scale, (base.y - cy) * scale, base.w * scale, base.h * scale);
  const max = half - 6;
  for (const d of dots) {
    let x = (d.x - cx) * scale;
    let y = (d.y - cy) * scale;
    const r = Math.hypot(x, y);
    if (r > max) {
      x = (x / r) * max;
      y = (y / r) * max;
    }
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.arc(x, y, (d.size ?? 2.5) * (size / 180), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  const k = size / 180;
  ctx.save();
  ctx.translate(half, half);
  ctx.scale(k, k);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(5, 5);
  ctx.lineTo(0, 2);
  ctx.lineTo(-5, 5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
