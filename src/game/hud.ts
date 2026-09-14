import type { City } from './city';
import { TILE } from './city';

export interface MinimapDot {
  x: number;
  y: number;
  color: string;
  size?: number;
}

/** DOM heads-up display: money, wanted level, health, minimap, messages. */
export class Hud {
  private root = document.getElementById('hud')!;
  private cash = document.getElementById('cash')!;
  private wanted = document.getElementById('wanted')!;
  private healthFill = document.getElementById('health-fill')!;
  private feed = document.getElementById('feed')!;
  private banner = document.getElementById('banner')!;
  private hint = document.getElementById('hint')!;
  private minimap = document.getElementById('minimap') as HTMLCanvasElement;
  private mctx = this.minimap.getContext('2d')!;
  private overview: HTMLCanvasElement;
  private bannerTimer = 0;
  private shownCash = -1;
  private shownWanted = -1;
  private shownHp = -1;
  private shownHint = '';

  constructor(city: City) {
    this.overview = document.createElement('canvas');
    this.overview.width = city.w;
    this.overview.height = city.h;
    const octx = this.overview.getContext('2d')!;
    octx.putImageData(new ImageData(city.overviewPixels() as unknown as Uint8ClampedArray<ArrayBuffer>, city.w, city.h), 0, 0);
  }

  show(): void {
    this.root.hidden = false;
  }

  setStatus(cash: number, wanted: number, hp: number): void {
    if (cash !== this.shownCash) {
      this.shownCash = cash;
      this.cash.textContent = `$${cash.toLocaleString()}`;
    }
    if (wanted !== this.shownWanted) {
      this.shownWanted = wanted;
      this.wanted.innerHTML = Array.from({ length: 5 }, (_, i) => (i < wanted ? '★' : '<span class="off">★</span>')).join('');
      this.wanted.classList.toggle('flash', wanted > 0);
    }
    if (hp !== this.shownHp) {
      this.shownHp = hp;
      this.healthFill.style.width = `${Math.max(0, hp)}%`;
    }
  }

  setHint(text: string): void {
    if (text === this.shownHint) return;
    this.shownHint = text;
    this.hint.textContent = text;
  }

  message(text: string): void {
    const div = document.createElement('div');
    div.textContent = text;
    this.feed.appendChild(div);
    while (this.feed.children.length > 6) this.feed.firstChild!.remove();
    setTimeout(() => div.remove(), 6200);
  }

  showBanner(text: string, color: string, ms = 2500): void {
    this.banner.textContent = text;
    this.banner.style.color = color;
    this.banner.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.remove('show'), ms);
  }

  drawMinimap(cx: number, cy: number, angle: number, dots: MinimapDot[], viewRadius = 1400): void {
    const ctx = this.mctx;
    const size = this.minimap.width;
    const scale = size / (viewRadius * 2);
    ctx.save();
    ctx.fillStyle = '#123';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    const tilesAcross = (viewRadius * 2) / TILE;
    ctx.drawImage(this.overview, cx / TILE - tilesAcross / 2, cy / TILE - tilesAcross / 2, tilesAcross, tilesAcross, 0, 0, size, size);

    for (const d of dots) {
      let x = (d.x - cx) * scale + size / 2;
      let y = (d.y - cy) * scale + size / 2;
      const dx = x - size / 2;
      const dy = y - size / 2;
      const r = Math.hypot(dx, dy);
      const max = size / 2 - 6;
      if (r > max) {
        x = size / 2 + (dx / r) * max;
        y = size / 2 + (dy / r) * max;
      }
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(x, y, d.size ?? 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // self arrow
    ctx.translate(size / 2, size / 2);
    ctx.rotate(angle);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-5, -5);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
