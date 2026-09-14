import Phaser from 'phaser';
import { ROOF_BASE, ROOF_COLORS, TILE, TILESET_COLS, TILESET_ROWS, Tile } from './city';
import { CarKind } from './defs';

/** All art is generated at boot: no asset files to load or ship. */

export const TILE_MARGIN = 1;
export const TILE_SPACING = 2;

export const CAR_COLORS = ['#c0392b', '#2e86de', '#27ae60', '#8e44ad', '#ecf0f1', '#34495e', '#e67e22', '#16a085'];
export const SHIRTS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#ecf0f1', '#1abc9c', '#e67e22', '#34495e', '#ff6b81'];
const SKIN_TONES = ['#f5d0a9', '#e0ac69', '#c68642', '#8d5524', '#5c3a1e'];
const HAIR = ['#2c1b0e', '#6b4423', '#d4a017', '#1a1a1a', '#a52a2a', '#bbbbbb'];
const ROOF_TINTS = ['#6d6f7a', '#8a5a44', '#4f6d7a', '#7a7152', '#5d4a66', '#3f5f4a'];
export const PED_SKINS = 30;
export const COP_SKINS = 6;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `rgb(${r},${g},${b})`;
}

function speckle(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, count: number, rnd: () => number) {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) ctx.fillRect(x + Math.floor(rnd() * w), y + Math.floor(rnd() * h), 1, 1);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTile(ctx: CanvasRenderingContext2D, index: number, rnd: () => number) {
  const s = TILE;
  const asphalt = () => {
    ctx.fillStyle = '#3a3a3f';
    ctx.fillRect(0, 0, s, s);
    speckle(ctx, 0, 0, s, s, '#44444a', 40, rnd);
    speckle(ctx, 0, 0, s, s, '#303034', 30, rnd);
  };
  switch (index) {
    case Tile.Grass:
    case Tile.Tree:
      ctx.fillStyle = '#4a8c3f';
      ctx.fillRect(0, 0, s, s);
      speckle(ctx, 0, 0, s, s, '#58a04a', 50, rnd);
      speckle(ctx, 0, 0, s, s, '#3f7a36', 40, rnd);
      if (index === Tile.Tree) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath();
        ctx.arc(19, 19, 13, 0, Math.PI * 2);
        ctx.fill();
        const g = ctx.createRadialGradient(13, 12, 2, 16, 16, 15);
        g.addColorStop(0, '#6fc25a');
        g.addColorStop(1, '#2d6b2a');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(16, 16, 14, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case Tile.Road:
    case Tile.Junction:
      asphalt();
      break;
    case Tile.LineH:
      asphalt();
      ctx.fillStyle = '#e8c547';
      for (let x = 2; x < s; x += 16) ctx.fillRect(x, s - 2, 9, 3);
      break;
    case Tile.LineV:
      asphalt();
      ctx.fillStyle = '#e8c547';
      for (let y = 2; y < s; y += 16) ctx.fillRect(s - 2, y, 3, 9);
      break;
    case Tile.CrossH:
      asphalt();
      ctx.fillStyle = '#d8d8d8';
      for (let x = 3; x < s; x += 8) ctx.fillRect(x, 4, 4, s - 8);
      break;
    case Tile.CrossV:
      asphalt();
      ctx.fillStyle = '#d8d8d8';
      for (let y = 3; y < s; y += 8) ctx.fillRect(4, y, s - 8, 4);
      break;
    case Tile.Sidewalk:
      ctx.fillStyle = '#9c9a94';
      ctx.fillRect(0, 0, s, s);
      speckle(ctx, 0, 0, s, s, '#a8a6a0', 30, rnd);
      ctx.fillStyle = '#8a8882';
      ctx.fillRect(0, 0, s, 1);
      ctx.fillRect(0, 0, 1, s);
      ctx.fillRect(0, 16, s, 1);
      ctx.fillRect(16, 0, 1, s);
      break;
    case Tile.Concrete:
      ctx.fillStyle = '#7d7b76';
      ctx.fillRect(0, 0, s, s);
      speckle(ctx, 0, 0, s, s, '#86847e', 40, rnd);
      speckle(ctx, 0, 0, s, s, '#6f6d68', 30, rnd);
      break;
    case Tile.Parking:
      ctx.fillStyle = '#56565a';
      ctx.fillRect(0, 0, s, s);
      speckle(ctx, 0, 0, s, s, '#606064', 30, rnd);
      ctx.fillStyle = '#e0e0e0';
      ctx.fillRect(0, 0, 2, s);
      break;
    case Tile.Water: {
      ctx.fillStyle = '#1f5f9a';
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      for (let i = 0; i < 3; i++) {
        const y = 6 + i * 10 + rnd() * 3;
        ctx.beginPath();
        ctx.moveTo(2 + rnd() * 6, y);
        ctx.quadraticCurveTo(16, y - 3, 28, y);
        ctx.stroke();
      }
      break;
    }
    case Tile.Sand:
      ctx.fillStyle = '#c9b27a';
      ctx.fillRect(0, 0, s, s);
      speckle(ctx, 0, 0, s, s, '#d8c290', 50, rnd);
      break;
    case Tile.Path:
      ctx.fillStyle = '#b39b72';
      ctx.fillRect(0, 0, s, s);
      speckle(ctx, 0, 0, s, s, '#a38b62', 50, rnd);
      break;
    case Tile.Shadow:
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(0, 0, s, s);
      break;
    default: {
      if (index < ROOF_BASE || index >= ROOF_BASE + ROOF_COLORS * 9) break;
      const k = index - ROOF_BASE;
      const color = ROOF_TINTS[Math.floor(k / 9)];
      const row = Math.floor((k % 9) / 3);
      const col = (k % 9) % 3;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, s, s);
      speckle(ctx, 0, 0, s, s, shade(color, 0.05), 40, rnd);
      speckle(ctx, 0, 0, s, s, shade(color, -0.05), 40, rnd);
      const edge = 5;
      if (row === 0) {
        ctx.fillStyle = shade(color, 0.18);
        ctx.fillRect(0, 0, s, edge);
      }
      if (col === 0) {
        ctx.fillStyle = shade(color, 0.12);
        ctx.fillRect(0, 0, edge, s);
      }
      if (row === 2) {
        ctx.fillStyle = shade(color, -0.2);
        ctx.fillRect(0, s - edge, s, edge);
      }
      if (col === 2) {
        ctx.fillStyle = shade(color, -0.14);
        ctx.fillRect(s - edge, 0, edge, s);
      }
      if (row === 1 && col === 1 && rnd() < 0.2) {
        // rooftop AC unit
        ctx.fillStyle = shade(color, -0.25);
        ctx.fillRect(9, 9, 14, 12);
        ctx.fillStyle = shade(color, 0.25);
        ctx.fillRect(10, 10, 12, 9);
      }
    }
  }
}

function buildTileset(scene: Phaser.Scene) {
  const cell = TILE + TILE_SPACING;
  const [c, ctx] = canvas(TILESET_COLS * cell, TILESET_ROWS * cell);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const [tc, tctx] = canvas(TILE, TILE);
  for (let i = 0; i < TILESET_COLS * TILESET_ROWS; i++) {
    tctx.clearRect(0, 0, TILE, TILE);
    drawTile(tctx, i, rnd);
    const x = TILE_MARGIN + (i % TILESET_COLS) * cell;
    const y = TILE_MARGIN + Math.floor(i / TILESET_COLS) * cell;
    // extrude edges by 1px so filtering never samples a neighbour
    ctx.drawImage(tc, 0, 0, TILE, 1, x, y - 1, TILE, 1);
    ctx.drawImage(tc, 0, TILE - 1, TILE, 1, x, y + TILE, TILE, 1);
    ctx.drawImage(tc, 0, 0, 1, TILE, x - 1, y, 1, TILE);
    ctx.drawImage(tc, TILE - 1, 0, 1, TILE, x + TILE, y, 1, TILE);
    ctx.drawImage(tc, x, y);
  }
  scene.textures.addCanvas('tiles', c);
}

export function carTextureKey(kind: number, color: number): string {
  return kind === CarKind.Taxi || kind === CarKind.Police ? `car${kind}` : `car${kind}_${color % CAR_COLORS.length}`;
}

export function carSize(kind: number): { w: number; h: number } {
  return kind === CarKind.Van ? { w: 60, h: 28 } : kind === CarKind.Sport ? { w: 50, h: 24 } : { w: 52, h: 26 };
}

function buildCar(scene: Phaser.Scene, kind: number, colorIdx: number) {
  const { w, h } = carSize(kind);
  const pad = 2;
  const [c, ctx] = canvas(w + pad * 2, h + pad * 2);
  ctx.translate(pad, pad);
  const body = kind === CarKind.Taxi ? '#f4c20d' : kind === CarKind.Police ? '#f4f4f4' : CAR_COLORS[colorIdx];

  // body
  ctx.fillStyle = shade(body, -0.35);
  roundRect(ctx, 0, 0, w, h, 7);
  ctx.fill();
  ctx.fillStyle = body;
  roundRect(ctx, 1.5, 1.5, w - 3, h - 3, 6);
  ctx.fill();
  if (kind === CarKind.Police) {
    ctx.fillStyle = '#1b1b1f';
    ctx.fillRect(w * 0.3, 1.5, w * 0.4, h - 3);
  }
  if (kind === CarKind.Sport) {
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(2, h / 2 - 3, w - 4, 2);
    ctx.fillRect(2, h / 2 + 1, w - 4, 2);
  }

  const glass = '#1c2733';
  if (kind === CarKind.Van) {
    ctx.fillStyle = glass;
    roundRect(ctx, w - 16, 3, 8, h - 6, 2);
    ctx.fill();
    ctx.fillStyle = shade(body, 0.12);
    ctx.fillRect(4, 4, w - 22, h - 8);
  } else {
    // windshield (front = +x), rear window, roof
    ctx.fillStyle = glass;
    roundRect(ctx, w * 0.56, 3, w * 0.16, h - 6, 3);
    ctx.fill();
    roundRect(ctx, w * 0.18, 4, w * 0.12, h - 8, 3);
    ctx.fill();
    ctx.fillStyle = shade(body, 0.1);
    roundRect(ctx, w * 0.3, 3.5, w * 0.26, h - 7, 3);
    ctx.fill();
  }
  if (kind === CarKind.Taxi) {
    ctx.fillStyle = '#222';
    ctx.fillRect(w * 0.38, h / 2 - 3, 8, 6);
    ctx.fillStyle = '#fff';
    ctx.fillRect(w * 0.38 + 1, h / 2 - 2, 6, 4);
  }
  if (kind === CarKind.Police) {
    ctx.fillStyle = '#e53935';
    ctx.fillRect(w * 0.42, 3, 5, h / 2 - 3);
    ctx.fillStyle = '#1e5bd8';
    ctx.fillRect(w * 0.42, h / 2, 5, h / 2 - 3);
  }
  // lights
  ctx.fillStyle = '#fff6c2';
  ctx.fillRect(w - 3, 3, 3, 5);
  ctx.fillRect(w - 3, h - 8, 3, 5);
  ctx.fillStyle = '#d32f2f';
  ctx.fillRect(0, 3, 2, 5);
  ctx.fillRect(0, h - 8, 2, 5);
  scene.textures.addCanvas(carTextureKey(kind, colorIdx), c);
}

export function pedLook(skin: number) {
  return {
    shirt: SHIRTS[skin % SHIRTS.length],
    tone: SKIN_TONES[Math.floor(skin / 3) % SKIN_TONES.length],
    hair: HAIR[Math.floor(skin / 7) % HAIR.length],
  };
}

function buildPed(scene: Phaser.Scene, skin: number, key: string, cop = false) {
  const [c, ctx] = canvas(24, 24);
  const look = pedLook(skin);
  const shirt = cop ? '#1d3b8b' : look.shirt;
  // shoulders (facing +x)
  ctx.fillStyle = shade(shirt, -0.3);
  ctx.beginPath();
  ctx.ellipse(11, 12, 6.5, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shirt;
  ctx.beginPath();
  ctx.ellipse(11, 12, 5.5, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  // hands
  ctx.fillStyle = look.tone;
  ctx.beginPath();
  ctx.arc(16, 4.5, 2.2, 0, Math.PI * 2);
  ctx.arc(16, 19.5, 2.2, 0, Math.PI * 2);
  ctx.fill();
  // head
  ctx.fillStyle = look.tone;
  ctx.beginPath();
  ctx.arc(12.5, 12, 4.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = cop ? '#0f1f4a' : look.hair;
  ctx.beginPath();
  ctx.arc(11.2, 12, 4.4, Math.PI * 0.55, Math.PI * 1.45);
  ctx.fill();
  if (cop) {
    // cap peak, badge, and a pistol held out front
    ctx.fillStyle = '#0f1f4a';
    ctx.fillRect(15.5, 9.5, 2.5, 5);
    ctx.fillStyle = '#ffd54a';
    ctx.fillRect(8, 6.5, 2, 2);
    ctx.fillStyle = '#222';
    ctx.fillRect(16, 3.5, 7, 2.2);
  }
  scene.textures.addCanvas(key, c);
}

function radial(scene: Phaser.Scene, key: string, size: number, stops: [number, string][]) {
  const [c, ctx] = canvas(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  scene.textures.addCanvas(key, c);
}

export function buildTextures(scene: Phaser.Scene): void {
  buildTileset(scene);
  for (const kind of [CarKind.Sedan, CarKind.Sport, CarKind.Van]) {
    for (let col = 0; col < CAR_COLORS.length; col++) buildCar(scene, kind, col);
  }
  buildCar(scene, CarKind.Taxi, 0);
  buildCar(scene, CarKind.Police, 0);
  for (let s = 0; s < PED_SKINS; s++) buildPed(scene, s, `ped${s}`);
  for (let s = 0; s < COP_SKINS; s++) buildPed(scene, s * 3, `cop${s}`, true);

  radial(scene, 'soft', 64, [
    [0, 'rgba(255,255,255,1)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  radial(scene, 'shadow', 48, [
    [0, 'rgba(0,0,0,0.45)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  radial(scene, 'glow', 128, [
    [0, 'rgba(255,240,200,0.9)'],
    [0.4, 'rgba(255,200,120,0.35)'],
    [1, 'rgba(255,160,60,0)'],
  ]);

  {
    const [c, ctx] = canvas(40, 40);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    ctx.fillStyle = 'rgba(120,0,0,0.85)';
    ctx.beginPath();
    ctx.arc(20, 20, 9, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2;
      const d = 8 + rnd() * 10;
      ctx.beginPath();
      ctx.arc(20 + Math.cos(a) * d, 20 + Math.sin(a) * d, 1.5 + rnd() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    scene.textures.addCanvas('blood', c);
  }
  {
    const [c, ctx] = canvas(22, 14);
    ctx.fillStyle = '#1e7d32';
    roundRect(ctx, 0, 0, 22, 14, 2);
    ctx.fill();
    ctx.fillStyle = '#7ddc86';
    roundRect(ctx, 2, 2, 18, 10, 2);
    ctx.fill();
    ctx.fillStyle = '#1e7d32';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', 11, 7.5);
    scene.textures.addCanvas('cash', c);
  }
  {
    const [c, ctx] = canvas(18, 18);
    ctx.fillStyle = '#fafafa';
    roundRect(ctx, 0, 0, 18, 18, 3);
    ctx.fill();
    ctx.fillStyle = '#e53935';
    ctx.fillRect(7, 3, 4, 12);
    ctx.fillRect(3, 7, 12, 4);
    scene.textures.addCanvas('health', c);
  }
  {
    const [c, ctx] = canvas(40, 40);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(20, 20, 16, 0, Math.PI * 2);
    ctx.stroke();
    scene.textures.addCanvas('ring', c);
  }
  {
    const [c, ctx] = canvas(8, 8);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 8, 8);
    scene.textures.addCanvas('px', c);
  }
}
