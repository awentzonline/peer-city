import type { NetWorld } from '@engine/index';
import type { PalEntity } from './context';
import { Pal } from './defs';

/** One line of the leaderboard. */
export interface Standing {
  id: number;
  name: string;
  score: number;
  best: number;
}

/** Everyone here, best score first. */
export function standings(world: NetWorld): Standing[] {
  const out: Standing[] = [];
  for (const e of world.all(Pal) as ReadonlySet<PalEntity>) out.push({ id: e.id, name: e.render.name || 'Someone', score: e.render.score, best: e.render.best });
  return out.sort((a, b) => b.score - a.score || a.id - b.id);
}

/** A key that changes whenever the board would look different. */
export function boardKey(rows: readonly Standing[]): string {
  return rows.map((r) => `${r.id}:${r.name}:${r.score}:${r.best}`).join('|');
}

/**
 * Draw the leaderboard on a canvas, for the jumbotron over the field and the whiteboard in the locker room:
 * `title` across the top, then the top rows, `me` picked out.
 */
export function drawBoard(ctx: CanvasRenderingContext2D, w: number, h: number, rows: readonly Standing[], me: number, title: string, bg: string, ink: string): void {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const pad = w * 0.05;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffd23f';
  ctx.font = `900 ${Math.round(h * 0.11)}px Trebuchet MS, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(title, w / 2, h * 0.1, w - pad * 2);
  const lines = Math.min(8, Math.max(1, rows.length));
  const top = h * 0.22;
  const step = Math.min(h * 0.15, (h - top - pad) / lines);
  ctx.font = `bold ${Math.round(step * 0.62)}px Trebuchet MS, sans-serif`;
  if (!rows.length) {
    ctx.fillStyle = ink;
    ctx.fillText('No fives yet. Go on then.', w / 2, top + step, w - pad * 2);
    return;
  }
  rows.slice(0, 8).forEach((r, i) => {
    const y = top + step * (i + 0.5);
    if (r.id === me) {
      ctx.fillStyle = 'rgba(255, 210, 63, 0.22)';
      ctx.fillRect(pad * 0.5, y - step * 0.45, w - pad, step * 0.9);
    }
    ctx.fillStyle = i === 0 && r.score > 0 ? '#ffd23f' : ink;
    ctx.textAlign = 'left';
    ctx.fillText(`${i + 1}. ${r.name}`, pad, y, w * 0.55);
    ctx.textAlign = 'right';
    ctx.fillText(`${r.score}`, w - pad - w * 0.16, y, w * 0.2);
    ctx.fillStyle = 'rgba(160, 200, 255, 0.9)';
    ctx.fillText(r.best > 1 ? `×${r.best}` : '', w - pad, y, w * 0.14);
  });
}
