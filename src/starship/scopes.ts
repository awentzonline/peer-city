import { type CrewEntity, type FaultEntity, type RaiderEntity, type ShipState, type StarshipContext } from './context';
import { ROOMS, SHIP } from './deck';
import { Act, Crew, CrewMode, Fault, FaultKind, Phase, Raider, RaiderKind, Result, ShipSystem, Station, Warp } from './defs';
import { act, type ConsoleAct } from './intent';
import { SECTOR, bitCount } from './sector';
import { PHASER_ARC, PHASER_RANGE, SYSTEM_NAMES, health, sensorRange } from './ship';

/** What science has picked out of the sector: a planet, a raider, or nothing. */
export type Picked = { planet: number } | { raider: number } | null;

/**
 * The display half of a station: what its scope draws, and what a tap on it means. A console is this plus controls, so
 * the phone's panel (`StationPanel`) and a headset's console (`VrConsole`) can show the same map, radar or deck plan
 * without either owning it.
 */
export interface Scope {
  draw(g: CanvasRenderingContext2D, w: number, h: number): void;
  /** Tapped at canvas pixels: the order that gives, or null when it only changed what the scope shows. */
  tap(x: number, y: number): ConsoleAct | null;
  /** Scopes with a local and a sector map: switch, and what the button that switches should say. */
  zoom?(): void;
  zoomLabel?(): string;
  /** Science's selection, which its controls read. */
  readonly picked?: Picked;
}

/** The scope a station shows. Helm's map draws the course its steering is turning towards, if anything is. */
export function scopeFor(ctx: StarshipContext, station: Station, steer: { course: number | null } = { course: null }): Scope {
  switch (station) {
    case Station.Helm:
      return helmScope(ctx, { course: () => steer.course });
    case Station.Tactical:
      return tacticalScope(ctx);
    case Station.Science:
      return scienceScope(ctx);
    default:
      return engineeringScope(ctx);
  }
}

/** What science knows of a planet. */
export function planetStatus(ctx: StarshipContext, ship: ShipState, planet: number): string {
  if (ship.relics & (1 << planet)) return 'relic aboard';
  if (!(ship.surveyed & (1 << planet))) return 'not yet scanned';
  return ctx.sector.hasRelic(ship.voyage, planet) ? 'RELIC on the surface' : 'nothing of interest';
}

/** The line under the tabs: where the voyage stands. */
export function phaseLine(ctx: StarshipContext, ship: ShipState): string {
  const relics = `RELICS ${bitCount(ship.relics)}/3`;
  switch (ship.phase) {
    case Phase.Briefing:
      return `DOCKED AT THE STARBASE · VOYAGE ${ship.voyage} · CASTS OFF IN ${clock(ship.timer)}`;
    case Phase.Underway:
      return `${relics} · ${ship.docked ? 'DOCKED' : ship.orbit ? `ORBITING ${ctx.sector.planets[ship.orbit - 1].name.toUpperCase()}` : ship.warp === Warp.Warping ? 'AT WARP' : `${Math.round(ship.speed)} u/s`}${ctx.world.all(Raider).size ? ` · ${ctx.world.all(Raider).size} RAIDERS` : ''}`;
    case Phase.Over:
      return `${ship.result === Result.Victory ? 'VOYAGE COMPLETE' : 'SHIP LOST'} · NEXT VOYAGE IN ${Math.ceil(ship.timer)}`;
  }
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function triangle(g: CanvasRenderingContext2D, x: number, y: number, heading: number, size: number, color: string): void {
  g.save();
  g.translate(x, y);
  g.rotate(heading);
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(size, 0);
  g.lineTo(-size * 0.7, size * 0.6);
  g.lineTo(-size * 0.4, 0);
  g.lineTo(-size * 0.7, -size * 0.6);
  g.closePath();
  g.fill();
  g.restore();
}

/** The line along the bottom of a scope saying what tapping it does. */
function hint(g: CanvasRenderingContext2D, h: number, text: string): void {
  g.fillStyle = 'rgba(200,220,255,0.6)';
  g.font = '11px system-ui, sans-serif';
  g.fillText(text, 8, h - 8);
}

// ---------------------------------------------------------------------------
// The four scopes
// ---------------------------------------------------------------------------

/** Helm: the sector map, north up, with the waypoint a tap sets and the course being steered. */
export function helmScope(ctx: StarshipContext, steering: { course(): number | null }): Scope {
  const map = new MapScope(ctx);
  let zoom: 'local' | 'sector' = 'local';
  return {
    draw(g, w, h) {
      const ship = ctx.ship()?.render;
      if (!ship) return;
      map.frame(ship, w, h, zoom === 'local' ? 3200 : SECTOR * 1.05);
      map.drawSector(g, ship, { waypoint: true, raiders: sensorRange(ship), course: steering.course() ?? ship.course });
      hint(g, h, 'Tap the map to set a waypoint');
    },
    tap(x, y) {
      const p = map.toWorld(x, y);
      return act(Act.Waypoint, p.x, p.y);
    },
    zoom() {
      zoom = zoom === 'local' ? 'sector' : 'local';
    },
    zoomLabel: () => (zoom === 'local' ? 'SECTOR MAP' : 'LOCAL MAP'),
  };
}

/** Tactical: a heading-up radar of everything within weapons reach, where a tap picks a target. */
export function tacticalScope(ctx: StarshipContext): Scope {
  const RANGE = 1600;
  let scale = 1;
  let cx = 0;
  let cy = 0;
  return {
    draw(g, w, h) {
      const ship = ctx.ship()?.render;
      if (!ship) return;
      cx = w / 2;
      cy = h / 2;
      scale = (Math.min(w, h) / 2 - 10) / RANGE;
      g.save();
      g.translate(cx, cy);
      // heading up: world rotates so the ship points to the top
      g.rotate(-ship.heading - Math.PI / 2);
      // phaser arc
      g.fillStyle = 'rgba(255,150,50,0.16)';
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, PHASER_RANGE * scale, ship.heading - PHASER_ARC, ship.heading + PHASER_ARC);
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(120,160,220,0.25)';
      g.lineWidth = 1;
      for (const r of [500, 1000, 1500]) {
        g.beginPath();
        g.arc(0, 0, r * scale, 0, Math.PI * 2);
        g.stroke();
      }
      // planets and the starbase in range
      for (const p of ctx.sector.planets) {
        const dx = (p.x - ship.x) * scale;
        const dy = (p.y - ship.y) * scale;
        if (Math.hypot(dx, dy) - p.radius * scale > RANGE * scale) continue;
        g.fillStyle = 'rgba(120,140,170,0.25)';
        g.beginPath();
        g.arc(dx, dy, p.radius * scale, 0, Math.PI * 2);
        g.fill();
      }
      const sbx = (ctx.sector.starbase.x - ship.x) * scale;
      const sby = (ctx.sector.starbase.y - ship.y) * scale;
      g.strokeStyle = 'rgba(106,208,255,0.7)';
      g.strokeRect(sbx - 5, sby - 5, 10, 10);
      // torpedoes
      for (const f of ctx.torpedoes.flights) {
        g.fillStyle = f.hostile ? '#6aff5a' : '#ff8a4a';
        g.beginPath();
        g.arc((f.x - ship.x) * scale, (f.y - ship.y) * scale, 2.5, 0, Math.PI * 2);
        g.fill();
      }
      // raiders
      for (const r of ctx.world.all(Raider) as ReadonlySet<RaiderEntity>) {
        const x = (r.x - ship.x) * scale;
        const y = (r.y - ship.y) * scale;
        if (Math.hypot(x, y) > RANGE * scale + 10) continue;
        const target = r.id === ship.target;
        triangle(g, x, y, r.render.heading, r.render.kind === RaiderKind.Cruiser ? 11 : 8, r.render.scanned ? '#ffd35a' : '#ff5a4a');
        if (target) {
          g.strokeStyle = '#fff';
          g.lineWidth = 2;
          g.strokeRect(x - 13, y - 13, 26, 26);
        }
      }
      g.restore();
      // the ship, always pointing up
      triangle(g, cx, cy, -Math.PI / 2, 10, '#6ad0ff');
      hint(g, h, 'Tap a raider to target it');
    },
    tap(x, y) {
      const ship = ctx.ship()?.render;
      if (!ship) return null;
      // screen back to world: undo the heading-up rotation
      const a = ship.heading + Math.PI / 2;
      const dx = (x - cx) / scale;
      const dy = (y - cy) / scale;
      const wx = ship.x + dx * Math.cos(a) - dy * Math.sin(a);
      const wy = ship.y + dx * Math.sin(a) + dy * Math.cos(a);
      let best: RaiderEntity | null = null;
      let bd = 40 / scale;
      for (const r of ctx.world.all(Raider) as ReadonlySet<RaiderEntity>) {
        const d = Math.hypot(r.x - wx, r.y - wy);
        if (d < bd) {
          bd = d;
          best = r;
        }
      }
      return best ? act(Act.Target, 0, 0, best.id) : null;
    },
  };
}

/** Science: the long-range sensors, where a tap picks the planet or raider to scan. */
export function scienceScope(ctx: StarshipContext): Scope {
  const map = new MapScope(ctx);
  let zoom: 'local' | 'sector' = 'sector';
  let picked: Picked = null;
  return {
    get picked() {
      // a raider that's been destroyed isn't anything to scan any more
      if (picked && 'raider' in picked && !ctx.world.getAs(Raider, picked.raider)) picked = null;
      return picked;
    },
    draw(g, w, h) {
      const ship = ctx.ship()?.render;
      if (!ship) return;
      map.frame(ship, w, h, zoom === 'local' ? 3600 : SECTOR * 1.05);
      map.drawSector(g, ship, { sensors: true, raiders: sensorRange(ship), labels: true, picked });
    },
    tap(x, y) {
      const ship = ctx.ship()?.render;
      if (!ship) return null;
      const p = map.toWorld(x, y);
      const reach = 30 / map.scale;
      let best: Picked = null;
      let bd = reach;
      for (const r of ctx.world.all(Raider)) {
        const d = Math.hypot(r.x - p.x, r.y - p.y);
        if (d < bd && Math.hypot(r.x - ship.x, r.y - ship.y) < sensorRange(ship)) {
          bd = d;
          best = { raider: r.id };
        }
      }
      for (const pl of ctx.sector.planets) {
        const d = Math.hypot(pl.x - p.x, pl.y - p.y) - pl.radius;
        if (d < bd) {
          bd = d;
          best = { planet: pl.index };
        }
      }
      picked = best;
      return null;
    },
    zoom() {
      zoom = zoom === 'local' ? 'sector' : 'local';
    },
    zoomLabel: () => (zoom === 'local' ? 'SECTOR MAP' : 'LOCAL MAP'),
  };
}

/** Engineering: the ship's decks, room by room, where a tap sends the damage control team. */
export function engineeringScope(ctx: StarshipContext): Scope {
  let hitRooms: { x0: number; y0: number; x1: number; y1: number; system: ShipSystem | null }[] = [];
  return {
    draw(g, w, h) {
      const ship = ctx.ship()?.render;
      if (!ship) return;
      // the ship's decks, bow to the right, rooms coloured by their system's health
      const pad = 12;
      const s = Math.min((w - pad * 2) / SHIP.x1, (h - pad * 2 - 18) / SHIP.y1);
      const ox = (w - SHIP.x1 * s) / 2;
      const oy = (h - SHIP.y1 * s) / 2;
      hitRooms = [];
      g.strokeStyle = 'rgba(160,190,230,0.5)';
      g.lineWidth = 1;
      for (const r of ROOMS) {
        const x = ox + r.x0 * s;
        const y = oy + r.y0 * s;
        const rw = (r.x1 - r.x0) * s;
        const rh = (r.y1 - r.y0) * s;
        let fill = 'rgba(60,70,90,0.5)';
        if (r.system !== null) {
          const hl = health(ship, r.system);
          fill = hl > 0.8 ? 'rgba(80,160,110,0.45)' : hl > 0.5 ? 'rgba(200,160,60,0.5)' : 'rgba(210,70,60,0.6)';
          if (ship.team === r.system) fill = 'rgba(106,208,255,0.45)';
        }
        g.fillStyle = fill;
        g.fillRect(x, y, rw, rh);
        g.strokeRect(x, y, rw, rh);
        if (r.system !== null) {
          g.fillStyle = '#e8ecf4';
          g.font = `${Math.max(9, Math.min(12, s * 0.9))}px system-ui, sans-serif`;
          g.fillText(SYSTEM_NAMES[r.system].toUpperCase(), x + 4, y + 13);
          hitRooms.push({ x0: x, y0: y, x1: x + rw, y1: y + rh, system: r.system });
        }
      }
      for (const f of ctx.world.all(Fault) as ReadonlySet<FaultEntity>) {
        g.font = `${Math.max(12, s * 1.2)}px system-ui, sans-serif`;
        g.fillText(f.render.kind === FaultKind.Fire ? '🔥' : '⚡', ox + f.x * s - 7, oy + f.y * s + 6);
      }
      for (const c of ctx.world.all(Crew) as ReadonlySet<CrewEntity>) {
        if (!ctx.deck.onShip(c.x)) continue;
        g.fillStyle = c.render.mode === CrewMode.Up ? '#ffffff' : '#ff5a4a';
        g.beginPath();
        g.arc(ox + c.x * s, oy + c.y * s, 3.5, 0, Math.PI * 2);
        g.fill();
      }
      hint(g, h, 'Tap a room to send the damage control team there');
    },
    tap(x, y) {
      const room = hitRooms.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
      return room && room.system !== null ? act(Act.DamageControl, room.system) : null;
    },
  };
}

interface MapOptions {
  waypoint?: boolean;
  /** Show raiders within this range. */
  raiders?: number;
  sensors?: boolean;
  labels?: boolean;
  course?: number;
  picked?: Picked;
}

/** A top-down map of the sector for a canvas: north up, centred on the ship (or the whole sector). */
export class MapScope {
  scale = 1;
  private ox = 0;
  private oy = 0;

  constructor(private readonly ctx: StarshipContext) {}

  /** Fit `span` u across the canvas, centred on the ship, or on the sector's middle when that shows it all. */
  frame(ship: ShipState, w: number, h: number, span: number): void {
    this.scale = Math.min(w, h) / span;
    const whole = span >= SECTOR;
    const cx = whole ? SECTOR / 2 : ship.x;
    const cy = whole ? SECTOR / 2 : ship.y;
    this.ox = w / 2 - cx * this.scale;
    this.oy = h / 2 - cy * this.scale;
  }

  toScreen(x: number, y: number): [number, number] {
    return [this.ox + x * this.scale, this.oy + y * this.scale];
  }

  toWorld(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.ox) / this.scale, y: (y - this.oy) / this.scale };
  }

  drawSector(g: CanvasRenderingContext2D, ship: ShipState, o: MapOptions): void {
    const { ctx } = this;
    const k = this.scale;
    // grid
    g.strokeStyle = 'rgba(90,120,170,0.18)';
    g.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const [x0, y0] = this.toScreen(i * 1000, 0);
      const [x1, y1] = this.toScreen(i * 1000, SECTOR);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      const [a0, b0] = this.toScreen(0, i * 1000);
      const [a1, b1] = this.toScreen(SECTOR, i * 1000);
      g.beginPath();
      g.moveTo(a0, b0);
      g.lineTo(a1, b1);
      g.stroke();
    }
    if (o.sensors) {
      const [sx, sy] = this.toScreen(ship.x, ship.y);
      g.fillStyle = 'rgba(180,138,255,0.08)';
      g.strokeStyle = 'rgba(180,138,255,0.4)';
      g.beginPath();
      g.arc(sx, sy, sensorRange(ship) * k, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    // planets
    for (const p of ctx.sector.planets) {
      const [x, y] = this.toScreen(p.x, p.y);
      const status = planetStatus(ctx, ship, p.index);
      g.fillStyle = status === 'RELIC on the surface' ? 'rgba(255,211,90,0.7)' : status === 'relic aboard' ? 'rgba(122,224,138,0.6)' : 'rgba(140,160,190,0.55)';
      g.beginPath();
      g.arc(x, y, Math.max(4, p.radius * k), 0, Math.PI * 2);
      g.fill();
      if (ship.orbit === p.index + 1 || (o.picked && 'planet' in o.picked && o.picked.planet === p.index)) {
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, Math.max(8, p.radius * k + 5), 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = 'rgba(220,230,250,0.85)';
      g.font = '11px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(o.labels ? `${p.name} · ${status}` : p.name, x, y + Math.max(4, p.radius * k) + 13);
      g.textAlign = 'left';
    }
    // the starbase
    const [bx, by] = this.toScreen(ctx.sector.starbase.x, ctx.sector.starbase.y);
    g.strokeStyle = '#6ad0ff';
    g.lineWidth = 2;
    g.strokeRect(bx - 6, by - 6, 12, 12);
    g.fillStyle = 'rgba(106,208,255,0.9)';
    g.font = '11px system-ui, sans-serif';
    g.fillText('STARBASE', bx + 9, by + 4);
    // raiders in range
    if (o.raiders) {
      for (const r of ctx.world.all(Raider) as ReadonlySet<RaiderEntity>) {
        if (Math.hypot(r.x - ship.x, r.y - ship.y) > o.raiders) continue;
        const [x, y] = this.toScreen(r.x, r.y);
        triangle(g, x, y, r.render.heading, 6, r.render.scanned ? '#ffd35a' : '#ff5a4a');
        if (o.picked && 'raider' in o.picked && o.picked.raider === r.id) {
          g.strokeStyle = '#fff';
          g.strokeRect(x - 9, y - 9, 18, 18);
        }
      }
    }
    // the waypoint, and the way there
    const [sx, sy] = this.toScreen(ship.x, ship.y);
    if (o.waypoint && ship.waypoint) {
      const [wx, wy] = this.toScreen(ship.wx, ship.wy);
      g.setLineDash([6, 6]);
      g.strokeStyle = 'rgba(255,211,90,0.8)';
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(wx, wy);
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.arc(wx, wy, 7, 0, Math.PI * 2);
      g.stroke();
    }
    if (o.course !== undefined && !ship.autopilot) {
      g.strokeStyle = 'rgba(255,211,90,0.35)';
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(o.course) * 40, sy + Math.sin(o.course) * 40);
      g.stroke();
    }
    triangle(g, sx, sy, ship.heading, 9, '#6ad0ff');
    if (ship.warp === Warp.Warping) {
      g.strokeStyle = 'rgba(200,230,255,0.6)';
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx - Math.cos(ship.heading) * 30, sy - Math.sin(ship.heading) * 30);
      g.stroke();
    }
  }
}
