import * as THREE from 'three';
import { mulberry32 } from '@engine/index';

/** All of the city's art is generated at boot: no asset files to load or ship. */

const S = 128;

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function speckle(ctx: CanvasRenderingContext2D, colors: string[], count: number, rnd: () => number, dot = 2): void {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(Math.floor(rnd() * S), Math.floor(rnd() * S), dot, dot);
  }
}

/** Ground textures are sampled with world-space UVs (one repeat per tile), so canvas x/y map to world x/y. */
function tileTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.flipY = false;
  t.anisotropy = 8;
  return t;
}

export type GroundKind = 'asphalt' | 'lineH' | 'lineV' | 'crossH' | 'crossV' | 'sidewalk' | 'concrete' | 'parking' | 'grass' | 'path' | 'sand';

export function groundTexture(kind: GroundKind): THREE.CanvasTexture {
  const rnd = mulberry32(kind.length * 7919 + kind.charCodeAt(0) * 31 + kind.charCodeAt(kind.length - 1));
  const [c, ctx] = makeCanvas(S, S);
  const asphalt = () => {
    ctx.fillStyle = '#3c3c41';
    ctx.fillRect(0, 0, S, S);
    speckle(ctx, ['#48484e', '#323236', '#2a2a2e', '#515157'], 1100, rnd);
  };
  const concrete = (base: string) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, S, S);
    speckle(ctx, ['rgba(0,0,0,0.08)', 'rgba(255,255,255,0.08)'], 900, rnd);
  };
  switch (kind) {
    case 'asphalt':
      asphalt();
      break;
    case 'lineH': // road centre is this tile's bottom edge
      asphalt();
      ctx.fillStyle = '#e2bf45';
      ctx.fillRect(0, S - 15, S, 5);
      ctx.fillRect(0, S - 6, S, 5);
      break;
    case 'lineV': // road centre is this tile's right edge
      asphalt();
      ctx.fillStyle = '#e2bf45';
      ctx.fillRect(S - 15, 0, 5, S);
      ctx.fillRect(S - 6, 0, 5, S);
      break;
    case 'crossH': // zebra across a north-south road
      asphalt();
      ctx.fillStyle = '#e6e6e6';
      for (let i = 0; i < 4; i++) ctx.fillRect(6 + i * 32, 12, 18, S - 24);
      break;
    case 'crossV':
      asphalt();
      ctx.fillStyle = '#e6e6e6';
      for (let i = 0; i < 4; i++) ctx.fillRect(12, 6 + i * 32, S - 24, 18);
      break;
    case 'sidewalk':
      concrete('#a3a39d');
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(0, 0, S, 2);
      ctx.fillRect(0, S / 2, S, 2);
      ctx.fillRect(0, 0, 2, S);
      ctx.fillRect(S / 2, 0, 2, S);
      break;
    case 'concrete':
      concrete('#8e8e89');
      break;
    case 'parking':
      concrete('#7f7f7b');
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(0, 0, 5, S);
      break;
    case 'grass':
      ctx.fillStyle = '#4c8a3c';
      ctx.fillRect(0, 0, S, S);
      speckle(ctx, ['#579a45', '#417a33', '#5fa24c', '#3b6f2f'], 1600, rnd);
      break;
    case 'path':
      ctx.fillStyle = '#b39a6c';
      ctx.fillRect(0, 0, S, S);
      speckle(ctx, ['#a08a5e', '#c2aa7c'], 900, rnd);
      break;
    case 'sand':
      ctx.fillStyle = '#d6c28c';
      ctx.fillRect(0, 0, S, S);
      speckle(ctx, ['#c9b47e', '#e2d19e'], 900, rnd);
      break;
  }
  return tileTexture(c);
}

/**
 * Two floors × two windows of facade, tinted per building through vertex
 * colors. The top-left corner is plain wall, which roofs sample.
 */
export function facadeTexture(): THREE.CanvasTexture {
  const size = 256;
  const cell = size / 2;
  const [c, ctx] = makeCanvas(size, size);
  const rnd = mulberry32(99);
  ctx.fillStyle = '#ececec';
  ctx.fillRect(0, 0, size, size);
  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      const x0 = cx * cell;
      const y0 = cy * cell;
      ctx.fillStyle = '#c9c9c9';
      ctx.fillRect(x0 + 18, y0 + 26, 92, 80);
      const lit = rnd() < 0.25;
      const g = ctx.createLinearGradient(x0, y0 + 30, x0 + cell, y0 + 104);
      g.addColorStop(0, lit ? '#efe2a8' : '#4a6480');
      g.addColorStop(1, lit ? '#b9a979' : '#1d2a38');
      ctx.fillStyle = g;
      ctx.fillRect(x0 + 22, y0 + 30, 84, 72);
      ctx.fillStyle = '#c9c9c9';
      ctx.fillRect(x0 + 62, y0 + 30, 4, 72);
      ctx.fillStyle = '#d6d6d6';
      ctx.fillRect(x0 + 12, y0 + 104, 104, 6);
    }
  }
  return tileTexture(c);
}
