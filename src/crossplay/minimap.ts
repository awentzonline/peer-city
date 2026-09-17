/** Something on a minimap, in world meters. */
export interface MinimapDot {
  x: number;
  y: number;
  color: string;
  /** Radius in pixels on a 180-pixel map. Default 2.5. */
  size?: number;
  /** An outline round the dot, to pick it out from the ground. */
  ring?: string;
  /** A word or number beside the dot, kept upright however the map turns. */
  label?: string;
}

/** A route on a minimap, in world meters: a road, a trail, a hole from tee to green. */
export interface MinimapLine {
  points: readonly { x: number; y: number }[];
  color: string;
  /** Pixels on a 180-pixel map. Default 3. */
  width?: number;
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
 * rim and an arrow for you in the middle. `lines` are drawn under the dots and clipped by the rim. Draws onto any 2D canvas, so the page's minimap and a headset's watch
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
  lines: readonly MinimapLine[] = [],
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
  const k = size / 180;
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const l of lines) {
    if (l.points.length < 2) continue;
    ctx.strokeStyle = l.color;
    ctx.lineWidth = (l.width ?? 3) * k;
    ctx.beginPath();
    l.points.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, (p.x - cx) * scale, (p.y - cy) * scale));
    ctx.stroke();
  }
  const max = half - 6;
  const labels: { x: number; y: number; r: number; text: string; color: string }[] = [];
  for (const d of dots) {
    let x = (d.x - cx) * scale;
    let y = (d.y - cy) * scale;
    const r = Math.hypot(x, y);
    if (r > max) {
      x = (x / r) * max;
      y = (y / r) * max;
    }
    const radius = (d.size ?? 2.5) * k;
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (d.ring) {
      ctx.strokeStyle = d.ring;
      ctx.lineWidth = 1.5 * k;
      ctx.stroke();
    }
    if (d.label) labels.push({ x, y, r: radius, text: d.label, color: d.color });
  }
  ctx.restore();

  // labels go on after, unrotated, so they read upright
  const turn = -(heading + Math.PI / 2);
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  ctx.save();
  ctx.font = `bold ${Math.round(11 * k)}px Trebuchet MS, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3 * k;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  for (const l of labels) {
    const sx = half + l.x * cos - l.y * sin;
    const sy = half + l.x * sin + l.y * cos;
    // on the inside of a dot pinned to the rim, so it stays on the map
    const left = sx > half;
    ctx.textAlign = left ? 'right' : 'left';
    const tx = sx + (left ? -1 : 1) * (l.r + 3 * k);
    ctx.strokeText(l.text, tx, sy);
    ctx.fillStyle = '#fff';
    ctx.fillText(l.text, tx, sy);
  }
  ctx.restore();

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
