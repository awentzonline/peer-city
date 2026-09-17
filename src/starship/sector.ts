import { mulberry32 } from '@engine/index';

/** The sector's size in u, square, from 0. */
export const SECTOR = 10000;

export const enum Biome {
  /** Red rock and dust. */
  Desert = 0,
  /** Blue-white ice. */
  Ice = 1,
  /** Green jungle under a haze. */
  Jungle = 2,
  /** Black glass and lava glow. */
  Volcanic = 3,
  /** Grey, cratered, airless. */
  Barren = 4,
}

export interface Planet {
  index: number;
  name: string;
  x: number;
  y: number;
  radius: number;
  biome: Biome;
  /** Distance from the centre a standard orbit keeps. */
  orbit: number;
}

export const PLANET_COUNT = 5;
/** Planets with a relic on them, each voyage. */
export const RELIC_COUNT = 3;

const NAMES = ['Kessa', 'Obrin', 'Talvar', 'Myrrh', 'Idun', 'Carrow', 'Vessal', 'Anhur', 'Pell', 'Soraya', 'Thule', 'Merope'];

/**
 * The sector every peer builds for itself from a seed: a starbase near the middle, a sun off in a corner, and planets
 * spread round it. Which planets hold relics changes each voyage (`relicPlanets`), but science only learns which by
 * scanning them.
 */
export class Sector {
  readonly starbase = { x: SECTOR / 2, y: SECTOR / 2 };
  /** Where the ship waits, docked. */
  readonly dock = { x: SECTOR / 2 - 260, y: SECTOR / 2, heading: 0 };
  readonly sun = { x: SECTOR * 1.6, y: SECTOR * -0.4 };
  readonly planets: Planet[] = [];

  constructor(readonly seed: number) {
    const rand = mulberry32(seed);
    const names = [...NAMES];
    const start = rand() * Math.PI * 2;
    for (let i = 0; i < PLANET_COUNT; i++) {
      const a = start + (i / PLANET_COUNT) * Math.PI * 2 + (rand() - 0.5) * 0.7;
      const d = 2400 + rand() * 1900;
      const radius = 180 + rand() * 160;
      const name = names.splice(Math.floor(rand() * names.length), 1)[0];
      this.planets.push({
        index: i,
        name: `${name} ${['II', 'III', 'IV', 'V', 'VI'][Math.floor(rand() * 5)]}`,
        x: this.starbase.x + Math.cos(a) * d,
        y: this.starbase.y + Math.sin(a) * d,
        radius,
        biome: i % 5 as Biome,
        orbit: radius + 170,
      });
    }
  }

  /** The planets holding relics on a voyage, by index. */
  relicPlanets(voyage: number): number[] {
    const rand = mulberry32(this.seed * 31 + voyage * 7919);
    const all = this.planets.map((p) => p.index);
    const out: number[] = [];
    while (out.length < RELIC_COUNT) out.push(all.splice(Math.floor(rand() * all.length), 1)[0]);
    return out.sort((a, b) => a - b);
  }

  hasRelic(voyage: number, planet: number): boolean {
    return this.relicPlanets(voyage).includes(planet);
  }

  /** The planet nearest a point, and how far its surface is. */
  nearestPlanet(x: number, y: number): { planet: Planet; surface: number } {
    let best = this.planets[0];
    let bd = Infinity;
    for (const p of this.planets) {
      const d = Math.hypot(p.x - x, p.y - y) - p.radius;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return { planet: best, surface: bd };
  }
}

/** Every relic, as the bits a voyage would have when they're all home. */
export function allRelics(sector: Sector, voyage: number): number {
  return sector.relicPlanets(voyage).reduce((bits, i) => bits | (1 << i), 0);
}

export function bitCount(bits: number): number {
  let n = 0;
  for (let b = bits; b; b &= b - 1) n++;
  return n;
}
