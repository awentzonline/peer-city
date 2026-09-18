import { mulberry32 } from '@engine/index';
import { ShipSystem, Station } from './defs';
import { PLANET_COUNT } from './sector';

/** Grid cell size, m. */
export const CELL = 0.5;
/** The whole deck plan's size, m: the ship on the left, the away sites in a row to its right. */
export const DECK_W = 900;
export const DECK_H = 50;
export const WALL_HEIGHT = 3;

/** The ship's interior, m. Its bow points +x. */
export const SHIP = { x0: 0, y0: 0, x1: 36, y1: 14 };

/** Away sites: one per planet, `SITE_SIZE` square, starting at `SITE_X0` and `SITE_STEP` apart. */
export const SITE_X0 = 150;
export const SITE_STEP = 150;
export const SITE_SIZE = 48;

export const enum Tile {
  /** Outside the ship, or solid rock. */
  Solid = 0,
  Floor = 1,
  /** A console, a rack, a rock: solid, but low enough to see over. */
  Object = 2,
}

export interface Room {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  system: ShipSystem | null;
}

export interface Spot {
  x: number;
  y: number;
}

export interface ConsoleSpot extends Spot {
  station: Station;
  /** Which way someone seated there faces. */
  heading: number;
}

export const ROOMS: Room[] = [
  { name: 'Bridge', x0: 26, y0: 1.5, x1: 36, y1: 12.5, system: null },
  { name: 'Corridor', x0: 9, y0: 6, x1: 26, y1: 8, system: null },
  { name: 'Transporter Room', x0: 18, y0: 8, x1: 25, y1: 13.5, system: null },
  { name: 'Torpedo Room', x0: 18, y0: 0.5, x1: 25, y1: 6, system: ShipSystem.Weapons },
  { name: 'Shield Generator', x0: 10, y0: 8, x1: 17, y1: 13.5, system: ShipSystem.Shields },
  { name: 'Sensor Bay', x0: 10, y0: 0.5, x1: 17, y1: 6, system: ShipSystem.Sensors },
  { name: 'Engine Room', x0: 0.5, y0: 1, x1: 9, y1: 13, system: ShipSystem.Engines },
];

/** Doorways, as floor rects cut through walls. */
const DOORS = [
  { x0: 25.5, y0: 6, x1: 26.5, y1: 8 },
  { x0: 20.5, y0: 5.5, x1: 22.5, y1: 8.5 },
  { x0: 12.5, y0: 5.5, x1: 14.5, y1: 8.5 },
  { x0: 8.5, y0: 6, x1: 9.5, y1: 8 },
];

/** The viewscreen on the bridge's front wall. */
export const VIEWSCREEN = { x: 35.95, y: 7, width: 8, z: 2.1, height: 3.4 };

export const CONSOLES: ConsoleSpot[] = [
  { station: Station.Helm, x: 32.5, y: 5.6, heading: 0 },
  { station: Station.Tactical, x: 32.5, y: 8.4, heading: 0 },
  { station: Station.Science, x: 29, y: 2.6, heading: -Math.PI / 2 },
  { station: Station.Engineering, x: 29, y: 11.4, heading: Math.PI / 2 },
];

/** Half the side of the solid block a console occupies, m: enough to stop you walking through it from any side. */
const CONSOLE_HALF = 0.45;

export const PAD = { x: 21.5, y: 11.2, radius: 1.5 };
export const RACK = { x: 19, y: 1.6 };
export const TUBES: Spot[] = [
  { x: 24.4, y: 2.2 },
  { x: 24.4, y: 4.4 },
];
/** Where each system's machine stands in its room. */
export const MACHINES: Record<ShipSystem, Spot> = {
  [ShipSystem.Engines]: { x: 4.5, y: 7 },
  [ShipSystem.Weapons]: { x: 21.5, y: 3.4 },
  [ShipSystem.Shields]: { x: 13.5, y: 11 },
  [ShipSystem.Sensors]: { x: 13.5, y: 3 },
};

/** Where crew come aboard: the back of the bridge. */
export const SPAWN: Spot = { x: 27.6, y: 7 };

/** How near counts as at a console, the rack, a tube or the relic, m. */
export const REACH = 1.6;

export interface Site {
  /** The planet it's on. */
  planet: number;
  x0: number;
  y0: number;
  /** Where a transporter puts people down. */
  arrive: Spot;
  /** The relic's plinth. */
  plinth: Spot;
  rocks: { x: number; y: number; r: number }[];
  pillars: Spot[];
}

/**
 * The plan of every deck in the game, on one grid: the ship's interior, and an away site on each planet. Crew walk it,
 * sentinels hunt on it, and faults appear in its rooms. Built the same from the same seed on every peer.
 */
export class Deck {
  readonly cols = Math.round(DECK_W / CELL);
  readonly rows = Math.round(DECK_H / CELL);
  readonly tiles: Uint8Array;
  readonly sites: Site[] = [];
  /** Spots in each system's room where a fault can appear, clear of the machinery. */
  readonly faultSpots: Record<ShipSystem, Spot[]>;

  constructor(seed: number) {
    this.tiles = new Uint8Array(this.cols * this.rows);
    for (const r of ROOMS) this.fill(r.x0, r.y0, r.x1, r.y1, Tile.Floor);
    for (const d of DOORS) this.fill(d.x0, d.y0, d.x1, d.y1, Tile.Floor);
    for (const c of CONSOLES) this.fill(c.x - CONSOLE_HALF, c.y - CONSOLE_HALF, c.x + CONSOLE_HALF, c.y + CONSOLE_HALF, Tile.Object);
    this.fill(RACK.x - 1, RACK.y - 0.5, RACK.x + 1, RACK.y + 0.5, Tile.Object);
    for (const tb of TUBES) this.fill(tb.x, tb.y - 0.45, tb.x + 0.6, tb.y + 0.45, Tile.Object);
    for (const m of Object.values(MACHINES)) this.fill(m.x - 0.9, m.y - 0.9, m.x + 0.9, m.y + 0.9, Tile.Object);

    this.faultSpots = {
      [ShipSystem.Engines]: [
        { x: 2, y: 3 },
        { x: 7, y: 3 },
        { x: 2, y: 11 },
        { x: 7, y: 11 },
        { x: 7.5, y: 7 },
      ],
      [ShipSystem.Weapons]: [
        { x: 19, y: 4.8 },
        { x: 23, y: 1.2 },
        { x: 19.2, y: 3.2 },
      ],
      [ShipSystem.Shields]: [
        { x: 11, y: 9.5 },
        { x: 16, y: 12.5 },
        { x: 11, y: 12.5 },
        { x: 16, y: 9.2 },
      ],
      [ShipSystem.Sensors]: [
        { x: 11, y: 1.5 },
        { x: 16, y: 4.8 },
        { x: 11, y: 4.8 },
        { x: 16, y: 1.5 },
      ],
    };

    const rand = mulberry32(seed);
    for (let i = 0; i < PLANET_COUNT; i++) this.sites.push(this.buildSite(i, rand));
  }

  private buildSite(planet: number, rand: () => number): Site {
    const x0 = SITE_X0 + planet * SITE_STEP;
    const y0 = 1;
    this.fill(x0 + 0.5, y0 + 0.5, x0 + SITE_SIZE - 0.5, y0 + SITE_SIZE - 0.5, Tile.Floor);
    const arrive = { x: x0 + SITE_SIZE / 2, y: y0 + 7 };
    const plinth = { x: x0 + SITE_SIZE / 2 + (rand() - 0.5) * 16, y: y0 + 36 + rand() * 6 };
    const site: Site = { planet, x0, y0, arrive, plinth, rocks: [], pillars: [] };
    // a ring of broken pillars round the plinth
    const pillars = 7;
    for (let k = 0; k < pillars; k++) {
      if (rand() < 0.3) continue;
      const a = (k / pillars) * Math.PI * 2 + rand() * 0.3;
      const p = { x: plinth.x + Math.cos(a) * 6, y: plinth.y + Math.sin(a) * 6 };
      site.pillars.push(p);
      this.fill(p.x - 0.5, p.y - 0.5, p.x + 0.5, p.y + 0.5, Tile.Solid);
    }
    // rocks, anywhere but the arrival and the plinth
    for (let tries = 0; site.rocks.length < 26 && tries < 200; tries++) {
      const r = 0.8 + rand() * 2.2;
      const x = x0 + 3 + rand() * (SITE_SIZE - 6);
      const y = y0 + 3 + rand() * (SITE_SIZE - 6);
      if (Math.hypot(x - arrive.x, y - arrive.y) < 6 + r || Math.hypot(x - plinth.x, y - plinth.y) < 8 + r) continue;
      if (site.rocks.some((o) => Math.hypot(o.x - x, o.y - y) < o.r + r + 1.2)) continue;
      site.rocks.push({ x, y, r });
      this.fillCircle(x, y, r * 0.8, Tile.Object);
    }
    return site;
  }

  private fill(x0: number, y0: number, x1: number, y1: number, tile: Tile): void {
    for (let cy = Math.floor(y0 / CELL); cy < Math.ceil(y1 / CELL); cy++) {
      for (let cx = Math.floor(x0 / CELL); cx < Math.ceil(x1 / CELL); cx++) {
        if (cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows) this.tiles[cy * this.cols + cx] = tile;
      }
    }
  }

  private fillCircle(x: number, y: number, r: number, tile: Tile): void {
    for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
      for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
        if (Math.hypot((cx + 0.5) * CELL - x, (cy + 0.5) * CELL - y) <= r && cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows) this.tiles[cy * this.cols + cx] = tile;
      }
    }
  }

  tile(x: number, y: number): Tile {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return Tile.Solid;
    return this.tiles[cy * this.cols + cx];
  }

  walkable(x: number, y: number): boolean {
    return this.tile(x, y) === Tile.Floor;
  }

  /** Move a circle by (dx, dy), sliding along whatever blocks it. */
  move(p: { x: number; y: number }, dx: number, dy: number, r: number): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (CELL * 0.4)));
    for (let i = 0; i < steps; i++) {
      p.x += dx / steps;
      this.pushOut(p, r);
      p.y += dy / steps;
      this.pushOut(p, r);
    }
  }

  /** Push a circle out of any blocked cell it overlaps. */
  pushOut(p: { x: number; y: number }, r: number): void {
    const c0 = Math.floor((p.x - r) / CELL);
    const c1 = Math.floor((p.x + r) / CELL);
    const r0 = Math.floor((p.y - r) / CELL);
    const r1 = Math.floor((p.y + r) / CELL);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const solid = cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows || this.tiles[cy * this.cols + cx] !== Tile.Floor;
        if (!solid) continue;
        const nx = Math.max(cx * CELL, Math.min(p.x, (cx + 1) * CELL));
        const ny = Math.max(cy * CELL, Math.min(p.y, (cy + 1) * CELL));
        const ddx = p.x - nx;
        const ddy = p.y - ny;
        const d = Math.hypot(ddx, ddy);
        if (d >= r) continue;
        if (d > 1e-6) {
          p.x = nx + (ddx / d) * r;
          p.y = ny + (ddy / d) * r;
        } else {
          // the centre's inside the cell: out the nearest side
          const left = p.x - cx * CELL;
          const right = (cx + 1) * CELL - p.x;
          const top = p.y - cy * CELL;
          const bottom = (cy + 1) * CELL - p.y;
          const m = Math.min(left, right, top, bottom);
          if (m === left) p.x = cx * CELL - r;
          else if (m === right) p.x = (cx + 1) * CELL + r;
          else if (m === top) p.y = cy * CELL - r;
          else p.y = (cy + 1) * CELL + r;
        }
      }
    }
  }

  /** Whether nothing solid stands between two points at eye height (objects are low enough to see over). */
  clear(x0: number, y0: number, x1: number, y1: number): boolean {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.ceil(d / (CELL * 0.5));
    for (let i = 1; i < n; i++) {
      const f = i / n;
      if (this.tile(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f) === Tile.Solid) return false;
    }
    return true;
  }

  /** The away site a point's on (its planet index), or -1 for the ship. */
  siteAt(x: number): number {
    if (x < SITE_X0) return -1;
    return Math.max(0, Math.min(PLANET_COUNT - 1, Math.floor((x - SITE_X0) / SITE_STEP)));
  }

  onShip(x: number): boolean {
    return x < SITE_X0;
  }

  roomAt(x: number, y: number): Room | null {
    for (const r of ROOMS) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return r;
    return null;
  }

  /** Where someone's standing, for a HUD. */
  placeName(x: number, y: number, planetName: (i: number) => string): string {
    if (!this.onShip(x)) return `Away: ${planetName(this.siteAt(x))}`;
    return this.roomAt(x, y)?.name ?? 'Corridor';
  }

  /** A clear spot near (x, y), for putting people down. */
  clearNear(x: number, y: number, r = 0.4): Spot {
    for (let ring = 0; ring < 12; ring++) {
      const n = ring === 0 ? 1 : ring * 6;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const px = x + Math.cos(a) * ring * 0.6;
        const py = y + Math.sin(a) * ring * 0.6;
        if (this.walkable(px - r, py - r) && this.walkable(px + r, py + r) && this.walkable(px - r, py + r) && this.walkable(px + r, py - r)) return { x: px, y: py };
      }
    }
    return { x, y };
  }
}
