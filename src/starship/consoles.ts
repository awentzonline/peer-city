import * as THREE from 'three';
import { SOLID, box, merge, paint } from '../crossplay/models';
import { disposePanel, panel, type Panel } from '../crossplay/panel';
import { HandPointer, type Surface } from '../crossplay/pointer';
import { Btn, type Rig, type XRHand } from '../crossplay/rig';
import { angleDiff, type CrewEntity, type RaiderEntity, type ShipState, type StarshipContext } from './context';
import type { ConsoleSpot } from './deck';
import { PAD } from './deck';
import { Act, Beam, Crew, CrewMode, Phase, Raider, Relic, SCREENS, ShipSystem, Station, SYSTEMS, Warp } from './defs';
import { act, type ConsoleAct } from './intent';
import { GLOW, STATION_COLORS, css } from './models';
import { RAIDERS } from './raiders';
import { phaseLine, planetStatus, scopeFor, type Scope } from './scopes';
import {
  DOCK_REACH,
  MAX_PIPS,
  ORBIT_REACH,
  POWER_POOL,
  SHIELD_MAX,
  SYSTEM_NAMES,
  WARP_MIN,
  efficiency,
  health,
  phaserBlocked,
  pips,
  powerUsed,
  sensorRange,
  transporterBlocked,
} from './ship';
import { STATION_NAMES, bearing, drawDial } from './stations';

// A console's shape, in metres, side on: `u` forward from its centre (away from whoever works it), `v` up. The desk
// slopes up away from you under your hands, at a standing height, and the screen stands on the shelf behind it.
const DESK_SLOPE = 0.61;
const LIP = { u: -0.42, v: 0.96 };
const SLOPE_TOP = { u: -0.02, v: 1.24 };
const WIDTH = 1;
const SCREEN_FOOT = { u: 0.06, v: 1.27 };
const SCREEN_TILT = 0.2;

// The two faces, in metres and in the logical pixels they're drawn in (600 to the metre, drawn at twice that).
const DESK_W = 0.86;
const DESK_H = 0.44;
const DESK_PX = 516;
const DESK_PY = 264;
const SCREEN_W = 0.74;
const SCREEN_H = 0.44;
const SCREEN_PX = 444;
const SCREEN_PY = 264;

/** How often a console that's in use redraws, and one on standby. */
const REDRAW_MS = 100;
const STANDBY_MS = 1000;
/** How long a console stays lit after a headset last pointed at it. */
const LIT_MS = 4000;
/** How often a held control sends the same order again. */
const REPEAT_MS = 100;

/** Where a hand's pointing on a console: which face, in its logical pixels. */
interface Hit {
  face: 'desk' | 'screen';
  x: number;
  y: number;
}

/** A rectangle of a face's canvas, in logical pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One control on the desk. `press` is called when a hand pulls the trigger on it, and again every frame it's held
 * when `hold` is set; either may return an order for the ship, or nothing.
 */
export interface Key {
  kind: 'key';
  label(): string;
  press(dt: number): ConsoleAct | null | void;
  /** Lit: the thing it does is on. */
  on?(): boolean;
  /** Greyed: it can't be pressed now. */
  off?(): boolean;
  /** A charge behind the label, 0–1. */
  fill?(): number;
  /** Keeps acting while it's held down. */
  hold?: boolean;
  /** Let go of, for a key that was held. */
  release?(): ConsoleAct | null;
  color?: string;
  /** How many of the row's columns it takes (1 by default). */
  span?: number;
  small?: boolean;
}

/** A bar to run a pointer along: the helm's throttle. */
export interface Slider {
  kind: 'slider';
  label(): string;
  /** Where the knob sits, 0–1 along the bar. */
  at(): number;
  /** Dragged to `f` (0–1 along the bar). */
  set(f: number): ConsoleAct | null;
  /** Let go of. */
  release(): ConsoleAct | null;
  span?: number;
}

export type Cell = Key | Slider;

/** A station's controls for a headset: rows of keys under a couple of lines saying how it's going. */
export interface Controls {
  rows: Cell[][];
  status(): string[];
}

/** A key a frontend can put in the desk's corner, like a headset officer's CHANGE STATION. */
export interface Corner {
  label: string;
  press(): void;
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

/**
 * A bridge console, as everyone sees it: a desk of keys sloping up under your hands and a screen with the station's
 * scope standing behind it, both always showing the ship as it is. On standby (nobody at it) they're dimmed and seldom
 * redrawn; once someone mans the station, from a console, a phone or a headset, they light up. A headset works them by
 * pointing (see `ConsoleHands`), and the orders go to the ship's owner exactly as a phone's would.
 */
export class BridgeConsole {
  readonly station: Station;
  /** The desk and the screen, for pointing at. */
  readonly surfaces: Surface[];
  /** The key in the desk's corner, if the frontend here wants one. */
  corner: Corner | null = null;
  private readonly desk: Panel;
  private readonly screen: Panel;
  private readonly body: THREE.Mesh;
  private readonly scope: Scope;
  private readonly controls: Controls;
  private readonly color: string;
  private readonly boxes: { box: Box; cell: Cell }[];
  private hovered: Cell | null = null;
  private hoverCorner = false;
  private held: { cell: Cell; hand: XRHand } | null = null;
  private lit = false;
  private pointedAt = -Infinity;
  private nextDraw = 0;
  /** Helm's steering shares the course it's turning towards with its map. */
  private readonly courseRef: { course: number | null } = { course: null };

  constructor(
    private readonly ctx: StarshipContext,
    spot: ConsoleSpot,
    parent: THREE.Object3D,
  ) {
    const station = (this.station = spot.station);
    this.color = css(STATION_COLORS[station]);
    // a quarter turn, so the console's own -z points away from whoever works it and +x is their right
    const mount = new THREE.Group();
    mount.position.set(spot.x, 0, spot.y);
    mount.rotation.y = -spot.heading - Math.PI / 2;
    parent.add(mount);
    this.body = new THREE.Mesh(consoleBody(STATION_COLORS[station]), SOLID);
    const lip = new THREE.Mesh(consoleLip(STATION_COLORS[station]), GLOW);
    mount.add(this.body, lip);

    this.desk = panel(DESK_W, DESK_H, DESK_PX * 2, DESK_PY * 2, false);
    this.desk.mesh.rotation.x = -(Math.PI / 2 - DESK_SLOPE);
    // just proud of the slope, so it doesn't fight with it
    const out = 0.004;
    this.desk.mesh.position.set(0, (LIP.v + SLOPE_TOP.v) / 2 + out * Math.cos(DESK_SLOPE), -(LIP.u + SLOPE_TOP.u) / 2 + out * Math.sin(DESK_SLOPE));
    this.screen = panel(SCREEN_W, SCREEN_H, SCREEN_PX * 2, SCREEN_PY * 2, false);
    this.screen.mesh.rotation.x = -SCREEN_TILT;
    const [su, sv] = screenCentre();
    this.screen.mesh.position.set(0, sv + out * Math.sin(SCREEN_TILT), -su + out * Math.cos(SCREEN_TILT));
    for (const p of [this.desk, this.screen]) {
      p.mesh.visible = true;
      p.mesh.renderOrder = 0;
      p.mesh.material.transparent = false;
      p.mesh.material.depthWrite = true;
      mount.add(p.mesh);
    }
    this.surfaces = [
      { mesh: this.desk.mesh, width: DESK_W, height: DESK_H, px: DESK_PX, py: DESK_PY },
      { mesh: this.screen.mesh, width: SCREEN_W, height: SCREEN_H, px: SCREEN_PX, py: SCREEN_PY },
    ];

    this.scope = scopeFor(ctx, station, this.courseRef);
    this.controls = stationControls(ctx, station, this.scope, this.courseRef);
    this.boxes = deskLayout(this.controls);
    this.setLit(false);
  }

  dispose(): void {
    disposePanel(this.desk);
    disposePanel(this.screen);
    this.body.geometry.dispose();
    this.body.parent?.removeFromParent();
  }

  /** Redraw as often as it's being used: `manned` when someone has this station, anywhere. */
  update(now: number, manned: boolean): void {
    const lit = manned || now - this.pointedAt < LIT_MS;
    if (lit !== this.lit) this.setLit(lit);
    if (now < this.nextDraw) return;
    this.nextDraw = now + (lit ? REDRAW_MS : STANDBY_MS);
    this.drawDesk();
    this.drawScreen();
  }

  /**
   * The hands on this console this frame: for each hand, where it's pointing on this console, or null (pointing
   * elsewhere, or at nothing). Orders given go into `acts`.
   */
  touch(now: number, hands: readonly XRHand[], hits: readonly (Hit | null)[], dt: number, acts: ConsoleAct[]): void {
    let hovered: Cell | null = null;
    let hoverCorner = false;
    for (let i = 0; i < hands.length; i++) {
      const hand = hands[i];
      const hit = hits[i];
      if (!hit) {
        if (this.held?.hand === hand) this.letGo(acts);
        continue;
      }
      this.pointedAt = now;
      const cell = this.cellAt(hit);
      if (cell) hovered = cell;
      const onCorner = hit.face === 'desk' && !cell && !!this.corner && within(LEAVE_BOX, hit);
      if (onCorner) hoverCorner = true;
      if (this.held?.hand === hand) {
        if (hand.down(Btn.Trigger)) {
          this.act(this.held.cell, hit, dt, acts);
          continue;
        }
        this.letGo(acts);
      }
      if (!hand.pressed(Btn.Trigger)) continue;
      hand.pulse(0.6, 30);
      this.nextDraw = 0;
      if (hit.face === 'screen') {
        const order = this.scope.tap(hit.x - SCOPE_BOX.x, hit.y - SCOPE_BOX.y);
        this.ctx.sfx.play('tap');
        if (order) acts.push(order);
        continue;
      }
      if (onCorner) {
        this.ctx.sfx.play('tap');
        this.corner!.press();
        continue;
      }
      if (!cell) continue;
      this.held = { cell, hand };
      this.act(cell, hit, dt, acts);
    }
    if (hovered !== this.hovered || hoverCorner !== this.hoverCorner) {
      this.hovered = hovered;
      this.hoverCorner = hoverCorner;
      this.nextDraw = 0;
    }
  }

  /** Nobody's hands are on it any more: let go of anything held. */
  idle(acts: ConsoleAct[]): void {
    if (this.held) this.letGo(acts);
    if (this.hovered || this.hoverCorner) {
      this.hovered = null;
      this.hoverCorner = false;
      this.nextDraw = 0;
    }
  }

  private setLit(lit: boolean): void {
    this.lit = lit;
    this.nextDraw = 0;
    // a console on standby still shows the ship, only dimly: the bridge looks alive, and you can see who's where
    for (const p of [this.desk, this.screen]) p.mesh.material.color.setScalar(lit ? 1 : 0.38);
  }

  // -------------------------------------------------------------------------
  // Hands
  // -------------------------------------------------------------------------

  private cellAt(hit: Hit): Cell | null {
    if (hit.face !== 'desk') return null;
    return this.boxes.find((b) => within(b.box, hit))?.cell ?? null;
  }

  /** Act on a key or slider a hand is on, this frame. */
  private act(cell: Cell, hit: Hit, dt: number, acts: ConsoleAct[]): void {
    if (cell.kind === 'slider') {
      const box = this.boxes.find((b) => b.cell === cell)!.box;
      const order = cell.set(clamp01((hit.x - box.x) / box.w));
      if (order) acts.push(order);
      this.nextDraw = 0;
      return;
    }
    if (cell.off?.()) return;
    const order = cell.press(dt);
    if (order) {
      acts.push(order);
      this.ctx.sfx.play('tap');
    }
    if (!cell.hold) this.held = null;
  }

  private letGo(acts: ConsoleAct[]): void {
    const cell = this.held?.cell;
    this.held = null;
    const order = cell?.release?.() ?? null;
    if (order) acts.push(order);
    this.nextDraw = 0;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private drawDesk(): void {
    const { ctx: g } = this.desk;
    g.setTransform(2, 0, 0, 2, 0, 0);
    face(g, DESK_PX, DESK_PY, this.color);

    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = this.color;
    g.font = 'bold 20px Trebuchet MS, sans-serif';
    g.fillText(STATION_NAMES[this.station].toUpperCase(), 16, 28);
    if (this.corner) this.key(g, LEAVE_BOX, this.corner.label, { on: false, off: false, hot: this.hoverCorner, color: '#ff9a7a', small: true });

    for (const { box, cell } of this.boxes) {
      if (cell.kind === 'slider') this.slider(g, box, cell);
      else this.key(g, box, cell.label(), { on: !!cell.on?.(), off: !!cell.off?.(), hot: this.hovered === cell, fill: cell.fill?.() ?? 0, color: cell.color ?? this.color, small: cell.small });
    }

    g.fillStyle = '#9fb0c8';
    g.font = '14px Trebuchet MS, sans-serif';
    this.controls.status().slice(0, 2).forEach((line, i) => g.fillText(line, 16, DESK_PY - 26 + i * 17, DESK_PX - 32));
    this.desk.tex.needsUpdate = true;
  }

  private key(g: CanvasRenderingContext2D, box: Box, label: string, o: { on: boolean; off: boolean; hot: boolean; fill?: number; color: string; small?: boolean }): void {
    g.save();
    g.globalAlpha = o.off ? 0.35 : 1;
    g.fillStyle = o.on ? o.color : o.hot ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)';
    g.beginPath();
    g.roundRect(box.x, box.y, box.w, box.h, 8);
    g.fill();
    if (o.fill) {
      g.save();
      g.beginPath();
      g.roundRect(box.x, box.y, box.w * clamp01(o.fill), box.h, 8);
      g.clip();
      g.fillStyle = o.color;
      g.globalAlpha = 0.4;
      g.fillRect(box.x, box.y, box.w, box.h);
      g.restore();
    }
    g.strokeStyle = o.hot ? '#fff' : o.color;
    g.globalAlpha = o.off ? 0.25 : o.hot ? 1 : 0.6;
    g.lineWidth = o.hot ? 3 : 2;
    g.beginPath();
    g.roundRect(box.x, box.y, box.w, box.h, 8);
    g.stroke();
    g.globalAlpha = o.off ? 0.45 : 1;
    g.fillStyle = o.on ? '#0b1018' : '#eef3fb';
    g.font = `bold ${o.small ? 13 : 16}px Trebuchet MS, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, box.x + box.w / 2, box.y + box.h / 2, box.w - 10);
    g.restore();
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
  }

  private slider(g: CanvasRenderingContext2D, box: Box, s: Slider): void {
    g.save();
    g.fillStyle = this.hovered === s ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)';
    g.beginPath();
    g.roundRect(box.x, box.y, box.w, box.h, 8);
    g.fill();
    const f = clamp01(s.at());
    g.fillStyle = this.color;
    g.globalAlpha = 0.35;
    g.fillRect(box.x + 3, box.y + 3, (box.w - 6) * f, box.h - 6);
    g.globalAlpha = 1;
    g.fillStyle = '#fff';
    g.fillRect(box.x + 3 + (box.w - 6) * f - 3, box.y + 2, 6, box.h - 4);
    g.strokeStyle = this.hovered === s ? '#fff' : this.color;
    g.globalAlpha = this.hovered === s ? 1 : 0.6;
    g.lineWidth = this.hovered === s ? 3 : 2;
    g.beginPath();
    g.roundRect(box.x, box.y, box.w, box.h, 8);
    g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = '#eef3fb';
    g.font = 'bold 15px Trebuchet MS, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(s.label(), box.x + 10, box.y + box.h / 2);
    g.restore();
    g.textBaseline = 'alphabetic';
  }

  private drawScreen(): void {
    const { ctx: g } = this.screen;
    const ship = this.ctx.ship()?.render;
    g.setTransform(2, 0, 0, 2, 0, 0);
    face(g, SCREEN_PX, SCREEN_PY, this.color);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    // the station's name, so the console says what it is from across the bridge
    g.fillStyle = this.color;
    g.font = 'bold 17px Trebuchet MS, sans-serif';
    g.fillText(STATION_NAMES[this.station].toUpperCase(), 14, 26);
    if (!ship) {
      g.fillStyle = '#9fb0c8';
      g.font = 'bold 14px Trebuchet MS, sans-serif';
      g.fillText('LOOKING FOR THE SHIP…', 14, 54);
      this.screen.tex.needsUpdate = true;
      return;
    }
    // hull and shields, then the voyage's line
    const bx = 150;
    bar(g, bx, 12, 110, 10, ship.hull / 100, ship.hull < 30 ? '#ff5a4a' : ship.hull < 60 ? '#ffb84a' : '#7ae08a');
    bar(g, bx + 120, 12, 110, 10, ship.shields / SHIELD_MAX, ship.shieldsUp ? '#6ab8ff' : '#4a5a70');
    g.fillStyle = '#9fb0c8';
    g.font = '11px system-ui, sans-serif';
    g.fillText(`HULL ${Math.round(ship.hull)}%`, bx, 35);
    g.fillText(`SHIELDS ${Math.round(ship.shields)}`, bx + 120, 35);
    if (ship.alert) {
      g.fillStyle = '#ff5a4a';
      g.font = 'bold 12px Trebuchet MS, sans-serif';
      g.textAlign = 'right';
      g.fillText('RED ALERT', SCREEN_PX - 14, 22);
      g.textAlign = 'left';
    }
    g.fillStyle = '#cfe0f6';
    g.font = '11px system-ui, sans-serif';
    g.fillText(phaseLine(this.ctx, ship), 14, 54, SCREEN_PX - 28);
    // the scope itself, drawn in its own corner of the canvas
    g.save();
    g.beginPath();
    g.rect(SCOPE_BOX.x, SCOPE_BOX.y, SCOPE_BOX.w, SCOPE_BOX.h);
    g.clip();
    g.translate(SCOPE_BOX.x, SCOPE_BOX.y);
    this.scope.draw(g, SCOPE_BOX.w, SCOPE_BOX.h);
    g.restore();
    if (this.station === Station.Helm) {
      // a compass in the corner of the map, since the helm steers by it
      const size = 92;
      g.save();
      g.translate(SCOPE_BOX.x + SCOPE_BOX.w - size - 6, SCOPE_BOX.y + SCOPE_BOX.h - size - 6);
      g.fillStyle = 'rgba(8,12,22,0.8)';
      g.beginPath();
      g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      g.fill();
      drawDial(g, size, ship.heading, this.courseRef.course ?? ship.course, ship.autopilot || ship.warp !== Warp.Idle || !!ship.orbit);
      g.restore();
    }
    const feed = this.ctx.hud.feed.at(-1);
    if (feed) {
      g.fillStyle = '#ffd35a';
      g.font = '12px system-ui, sans-serif';
      g.fillText(feed.text, 14, SCREEN_PY - 8, SCREEN_PX - 28);
    }
    this.screen.tex.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Working the consoles in a headset
// ---------------------------------------------------------------------------

/**
 * A headset's hands on the bridge consoles: point a hand at any console's desk or screen (or touch it) and pull the
 * trigger, and its orders go into the frame's acts. No sitting down, no taking your hands off anything else: a hand
 * that's holding a tool is still holding a tool, and walking off is just walking off.
 */
export class ConsoleHands {
  private readonly pointer: HandPointer;
  private readonly surfaces: Surface[];
  private readonly hits: (Hit | null)[] = [];
  private live = false;

  constructor(
    rig: Rig,
    private readonly consoles: readonly BridgeConsole[],
  ) {
    this.pointer = new HandPointer(rig);
    this.surfaces = consoles.flatMap((c) => c.surfaces);
  }

  /** Point `hands` at the consoles this frame. Returns the console a hand's on, if any. */
  update(now: number, dt: number, hands: readonly XRHand[], acts: ConsoleAct[]): Station | null {
    this.live = true;
    const points = this.pointer.update(this.surfaces, hands);
    let on: Station | null = null;
    this.consoles.forEach((c, ci) => {
      this.hits.length = 0;
      for (const p of points) {
        const mine = !!p && Math.floor(p.surface / 2) === ci;
        this.hits.push(mine ? { face: p.surface % 2 ? 'screen' : 'desk', x: p.x, y: p.y } : null);
        if (mine) on = c.station;
      }
      c.touch(now, hands, this.hits, dt, acts);
    });
    return on;
  }

  /** Hands off every console, e.g. while the settings menu is up. */
  rest(acts: ConsoleAct[]): void {
    if (!this.live) return;
    this.live = false;
    this.pointer.hide();
    for (const c of this.consoles) c.idle(acts);
  }

  dispose(): void {
    this.pointer.dispose();
    for (const c of this.consoles) c.idle([]);
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The screen's centre, (u, v), leaning back from its foot on the shelf. */
function screenCentre(): [number, number] {
  return [SCREEN_FOOT.u + (SCREEN_H / 2) * Math.sin(SCREEN_TILT), SCREEN_FOOT.v + (SCREEN_H / 2) * Math.cos(SCREEN_TILT)];
}

/** Side on, extruded across: a pedestal with a toe recess, the sloping desk, the shelf behind; and the screen's case. */
function consoleBody(color: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.3, 0);
  s.lineTo(0.4, 0);
  s.lineTo(0.4, SLOPE_TOP.v);
  s.lineTo(SLOPE_TOP.u, SLOPE_TOP.v);
  s.lineTo(LIP.u, LIP.v);
  s.lineTo(LIP.u, LIP.v - 0.08);
  s.lineTo(-0.3, 0.8);
  s.closePath();
  // shape x is forward (the console's -z), and it's extruded across (+x)
  const shell = paint(new THREE.ExtrudeGeometry(s, { depth: WIDTH, bevelEnabled: false }).rotateY(Math.PI / 2).translate(-WIDTH / 2, 0, 0), 0x4a5262);
  const [su, sv] = screenCentre();
  const bezel = paint(
    new THREE.BoxGeometry(SCREEN_W + 0.05, SCREEN_H + 0.05, 0.05)
      .translate(0, 0, -0.026)
      .rotateX(-SCREEN_TILT)
      .translate(0, sv, -su),
    0x22262e,
  );
  const stand = box(0.3, 0.1, 0.14, 0, SLOPE_TOP.v + 0.04, -(SCREEN_FOOT.u + 0.1), 0x2a2e38);
  const band = box(WIDTH + 0.01, 0.04, 0.72, 0, 0.12, -0.05, color);
  return merge([shell, bezel, stand, band]);
}

/** A strip of the station's colour glowing along the desk's front edge. */
function consoleLip(color: number): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(WIDTH + 0.004, 0.018, 0.018).translate(0, LIP.v - 0.02, -LIP.u + 0.004), color);
}

/** A face's backing: a dark panel edged in the station's colour, on a bezel so nothing shows through its corners. */
function face(g: CanvasRenderingContext2D, w: number, h: number, color: string): void {
  g.fillStyle = '#12161e';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#0a1019';
  g.beginPath();
  g.roundRect(2, 2, w - 4, h - 4, 12);
  g.fill();
  g.strokeStyle = color;
  g.globalAlpha = 0.5;
  g.lineWidth = 2;
  g.stroke();
  g.globalAlpha = 1;
}

/** The corner key's place on the desk, and the screen's window onto the scope. */
export const LEAVE_BOX: Box = { x: DESK_PX - 106, y: 10, w: 90, h: 24 };
export const SCOPE_BOX: Box = { x: 12, y: 62, w: SCREEN_PX - 24, h: SCREEN_PY - 62 - 18 };

/** The keys a station puts under your hands in a headset. */
export function stationControls(ctx: StarshipContext, station: Station, scope: Scope, steer: { course: number | null } = { course: null }): Controls {
  switch (station) {
    case Station.Helm:
      return helmKeys(ctx, scope, () => steer);
    case Station.Tactical:
      return tacticalKeys(ctx);
    case Station.Science:
      return scienceKeys(ctx, scope);
    default:
      return engineeringKeys(ctx);
  }
}

/** Where each key lands on the desk: a strip per row, under the station's name and over two lines of status. */
export function deskLayout(controls: Controls): { box: Box; cell: Cell }[] {
  const top = 40;
  const bottom = DESK_PY - 34;
  const gap = 7;
  const rowH = (bottom - top - gap * (controls.rows.length - 1)) / controls.rows.length;
  const out: { box: Box; cell: Cell }[] = [];
  controls.rows.forEach((row, r) => {
    const spans = row.reduce((n, c) => n + (c.span ?? 1), 0);
    const unit = (DESK_PX - 32 - gap * (row.length - 1)) / spans;
    let x = 16;
    for (const cell of row) {
      const w = unit * (cell.span ?? 1);
      out.push({ cell, box: { x, y: top + r * (rowH + gap), w, h: rowH } });
      x += w + gap;
    }
  });
  return out;
}

/** The desk and the screen, in logical pixels, for laying out and for testing what lands where. */
export const DESK = { w: DESK_PX, h: DESK_PY };
export const SCREEN = { w: SCREEN_PX, h: SCREEN_PY };

export function within(box: Box, hit: { x: number; y: number }): boolean {
  return hit.x >= box.x && hit.x <= box.x + box.w && hit.y >= box.y && hit.y <= box.y + box.h;
}

function clamp01(f: number): number {
  return Math.max(0, Math.min(1, f));
}

function bar(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, f: number, color: string): void {
  g.fillStyle = '#2a3242';
  g.fillRect(x, y, w, h);
  g.fillStyle = color;
  g.fillRect(x + 1, y + 1, (w - 2) * clamp01(f), h - 2);
}

function ship(ctx: StarshipContext): ShipState | null {
  return ctx.ship()?.render ?? null;
}

function key(k: Omit<Key, 'kind'>): Key {
  return { kind: 'key', ...k };
}

// ---------------------------------------------------------------------------
// The four stations' keys
// ---------------------------------------------------------------------------

/** Helm: a throttle to run a finger along, keys for the big moves, and port/starboard to hold. */
function helmKeys(ctx: StarshipContext, scope: Scope, ref: () => { course: number | null }): Controls {
  let throttle: number | null = null;
  let steer = 0;
  let since = 0;
  const steering = (dir: number, dt: number): ConsoleAct | null => {
    const s = ship(ctx);
    if (!s) return null;
    const r = ref();
    if (steer !== dir) {
      steer = dir;
      r.course = s.course;
    }
    r.course = (r.course ?? s.course) + dir * 0.9 * dt;
    since += dt * 1000;
    if (since < REPEAT_MS) return null;
    since = 0;
    return act(Act.Course, r.course);
  };
  /** Letting go of port or starboard: hold the course reached, and give the map back the ship's own. */
  const stopSteering = (): ConsoleAct | null => {
    const held = ref().course;
    steer = 0;
    ref().course = null;
    return held === null ? null : act(Act.Course, held);
  };
  const throttleSlider: Slider = {
    kind: 'slider',
    span: 3,
    label: () => {
      const s = ship(ctx);
      const shown = throttle ?? s?.throttle ?? 0;
      return `IMPULSE ${Math.round(shown * 100)}%${s ? ` · ${Math.round(s.speed)} u/s` : ''}`;
    },
    at: () => ((throttle ?? ship(ctx)?.throttle ?? 0) + 0.25) / 1.25,
    set: (f) => {
      let v = -0.25 + f * 1.25;
      if (Math.abs(v) < 0.05) v = 0;
      throttle = Math.round(v * 20) / 20;
      return act(Act.Throttle, throttle);
    },
    release: () => {
      const v = throttle;
      throttle = null;
      return v === null ? null : act(Act.Throttle, v);
    },
  };
  return {
    rows: [
      [throttleSlider],
      [
        key({
          label: () => {
            const s = ship(ctx);
            return s?.warp === Warp.Charging ? `WARP ${Math.round(s.warpT * 100)}%` : s?.warp === Warp.Warping ? 'AT WARP' : 'WARP';
          },
          fill: () => {
            const s = ship(ctx);
            return s?.warp === Warp.Charging ? s.warpT : s?.warp === Warp.Warping ? 1 : 0;
          },
          off: () => {
            const s = ship(ctx);
            return !s || s.phase !== Phase.Underway || s.docked || (s.warp === Warp.Idle && (!s.waypoint || Math.hypot(s.wx - s.x, s.wy - s.y) < WARP_MIN));
          },
          press: () => act(Act.Warp),
        }),
        key({
          label: () => 'AUTOPILOT',
          on: () => !!ship(ctx)?.autopilot,
          off: () => {
            const s = ship(ctx);
            return !s || !s.waypoint || s.docked || s.phase !== Phase.Underway;
          },
          press: () => act(Act.Autopilot, ship(ctx)?.autopilot ? 0 : 1),
        }),
        key({
          label: () => {
            const s = ship(ctx);
            if (!s) return 'ORBIT';
            const near = ctx.sector.nearestPlanet(s.x, s.y);
            return s.orbit ? 'BREAK ORBIT' : near.surface <= ORBIT_REACH ? `ORBIT ${near.planet.name.toUpperCase()}` : 'ORBIT';
          },
          on: () => !!ship(ctx)?.orbit,
          off: () => {
            const s = ship(ctx);
            return !s || (!s.orbit && (ctx.sector.nearestPlanet(s.x, s.y).surface > ORBIT_REACH || s.docked || s.phase !== Phase.Underway));
          },
          press: () => act(Act.Orbit),
        }),
      ],
      [
        key({
          label: () => {
            const s = ship(ctx);
            return s?.phase === Phase.Briefing ? 'CAST OFF' : s?.docked ? 'UNDOCK' : 'DOCK';
          },
          on: () => ship(ctx)?.phase === Phase.Briefing,
          off: () => {
            const s = ship(ctx);
            return !s || s.phase === Phase.Over || (!s.docked && Math.hypot(ctx.sector.starbase.x - s.x, ctx.sector.starbase.y - s.y) > DOCK_REACH);
          },
          press: () => act(Act.Dock),
        }),
        key({ label: () => 'ALL STOP', color: '#ff7a5a', press: () => {
          throttle = null;
          return act(Act.AllStop);
        } }),
        key({ label: () => scope.zoomLabel!(), small: true, press: () => scope.zoom!() }),
      ],
      [
        key({ label: () => '◀ PORT', hold: true, press: (dt) => steering(-1, dt), release: stopSteering }),
        key({
          label: () => {
            const s = ship(ctx);
            return s ? `HEADING ${String(bearing(s.heading)).padStart(3, '0')}°` : 'HEADING';
          },
          small: true,
          off: () => true,
          press: () => {},
        }),
        key({ label: () => 'STBD ▶', hold: true, press: (dt) => steering(1, dt), release: stopSteering }),
      ],
    ],
    status: () => {
      const s = ship(ctx);
      if (!s) return [];
      const wd = Math.hypot(s.wx - s.x, s.wy - s.y);
      return [
        s.waypoint ? `WAYPOINT ${Math.round(wd)} u${s.speed > 5 && s.warp === Warp.Idle ? ` · ETA ${Math.round(wd / s.speed)} s` : ''}` : 'No waypoint: point at the map on the screen',
        `${s.orbit ? 'IN ORBIT' : s.autopilot ? 'AUTOPILOT' : `STEERING ${String(bearing(s.course)).padStart(3, '0')}°`}`,
      ];
    },
  };
}

/** Tactical: the target, the phasers, the tubes and the shields. */
function tacticalKeys(ctx: StarshipContext): Controls {
  const target = (): RaiderEntity | null => {
    const s = ship(ctx);
    return s ? ((ctx.world.getAs(Raider, s.target) as RaiderEntity | undefined) ?? null) : null;
  };
  return {
    rows: [
      [
        key({
          label: () => {
            const s = ship(ctx);
            const why = s ? phaserBlocked(s, target()) : 'No ship';
            return why ? (why === 'Charging' ? `CHARGING ${Math.round((s?.phaser ?? 0) * 100)}%` : why.toUpperCase()) : `PHASERS ${Math.round((s?.phaser ?? 0) * 100)}%`;
          },
          span: 2,
          color: '#ff9a4a',
          fill: () => ship(ctx)?.phaser ?? 0,
          off: () => {
            const s = ship(ctx);
            return !s || !!phaserBlocked(s, target()) || s.phase !== Phase.Underway;
          },
          press: () => act(Act.Phasers),
        }),
        key({
          label: () => {
            const s = ship(ctx);
            return s?.shieldsUp ? (s.shields < SHIELD_MAX * 0.95 ? 'SHIELDS RAISING' : 'SHIELDS UP') : 'SHIELDS DOWN';
          },
          color: '#6ab8ff',
          on: () => !!ship(ctx)?.shieldsUp,
          fill: () => (ship(ctx)?.shields ?? 0) / SHIELD_MAX,
          off: () => {
            const s = ship(ctx);
            return !!s && s.docked && !s.shieldsUp;
          },
          press: () => act(Act.Shields, ship(ctx)?.shieldsUp ? 0 : 1),
        }),
      ],
      [
        key({
          label: () => {
            const s = ship(ctx);
            if (!s) return 'TORPEDO';
            const loaded = (s.tubes & 1 ? 1 : 0) + (s.tubes & 2 ? 1 : 0);
            return `FIRE TORPEDO ${loaded}/2`;
          },
          span: 2,
          color: '#ffd35a',
          fill: () => ship(ctx)?.loadT ?? 0,
          off: () => {
            const s = ship(ctx);
            return !s || !s.tubes || s.docked || s.phase !== Phase.Underway;
          },
          press: () => act(Act.Torpedo),
        }),
        key({
          label: () => 'NEXT TARGET',
          small: true,
          off: () => !ctx.world.all(Raider).size,
          press: () => {
            const s = ship(ctx);
            if (!s) return null;
            const list = ([...ctx.world.all(Raider)] as RaiderEntity[]).sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y));
            if (!list.length) return null;
            const i = list.findIndex((r) => r.id === s.target);
            return act(Act.Target, 0, 0, list[(i + 1) % list.length].id);
          },
        }),
      ],
    ],
    status: () => {
      const s = ship(ctx);
      if (!s) return [];
      const t = target();
      if (!t) return [ctx.world.all(Raider).size ? 'NO TARGET · point at a raider on the scope' : 'NO TARGET · no raiders on sensors', `${s.torps} torpedoes in the rack`];
      const spec = RAIDERS[t.render.kind];
      const rel = Math.round((angleDiff(s.heading, Math.atan2(t.y - s.y, t.x - s.x)) * 180) / Math.PI);
      const side = Math.abs(rel) < 3 ? 'dead ahead' : `${Math.abs(rel)}° ${rel > 0 ? 'starboard' : 'port'}`;
      return [
        `${spec.name.toUpperCase()} · ${Math.round(Math.hypot(t.x - s.x, t.y - s.y))} u · ${side}`,
        `HULL ${Math.round((t.render.hp / spec.hp) * 100)}% · SHIELDS ${Math.round((t.render.shields / spec.shields) * 100)}%${t.render.scanned ? ' · HARMONICS KNOWN' : ''} · ${s.torps} in the rack`,
      ];
    },
  };
}

/** Science: scanning, the transporter, and what the viewscreen shows. */
function scienceKeys(ctx: StarshipContext, scope: Scope): Controls {
  const scanning = (): boolean => {
    const s = ship(ctx);
    const p = scope.picked;
    return !!s && !!p && ('planet' in p ? s.scanPlanet === p.planet + 1 : s.scanning === p.raider);
  };
  const beamable = (want: 'down' | 'up' | 'relic'): boolean => {
    const s = ship(ctx);
    if (!s || transporterBlocked(s) || s.beam !== Beam.Idle) return false;
    const planet = s.orbit - 1;
    if (want === 'relic') return planet >= 0 && [...ctx.world.all(Relic)].some((r) => r.render.site === planet + 1 && !r.render.carrier);
    const crew = [...ctx.world.all(Crew)] as CrewEntity[];
    if (want === 'down') return crew.some((c) => c.render.mode === CrewMode.Up && ctx.deck.onShip(c.x) && Math.hypot(c.x - PAD.x, c.y - PAD.y) <= PAD.radius);
    return planet >= 0 && crew.some((c) => !ctx.deck.onShip(c.x) && ctx.deck.siteAt(c.x) === planet);
  };
  return {
    rows: [
      [
        key({
          label: () => (scanning() ? `SCANNING ${Math.round((ship(ctx)?.scanT ?? 0) * 100)}%` : 'SCAN'),
          span: 2,
          color: '#b48aff',
          fill: () => (scanning() ? (ship(ctx)?.scanT ?? 0) : 0),
          off: () => {
            const s = ship(ctx);
            const p = scope.picked;
            if (!s || !p) return true;
            if ('planet' in p) {
              const pl = ctx.sector.planets[p.planet];
              return Math.max(0, Math.hypot(pl.x - s.x, pl.y - s.y) - pl.radius) > sensorRange(s) || s.phase !== Phase.Underway;
            }
            return !!(ctx.world.getAs(Raider, p.raider) as RaiderEntity | undefined)?.render.scanned;
          },
          press: () => {
            const p = scope.picked;
            if (!p) return null;
            return 'planet' in p ? act(Act.ScanPlanet, p.planet) : act(Act.Scan, 0, 0, p.raider);
          },
        }),
        key({ label: () => scope.zoomLabel!(), small: true, press: () => scope.zoom!() }),
      ],
      [
        key({ label: () => 'BEAM DOWN', off: () => !beamable('down'), press: () => act(Act.BeamDown) }),
        key({ label: () => 'BEAM UP', off: () => !beamable('up'), press: () => act(Act.BeamUp) }),
        key({ label: () => 'BEAM RELIC', color: '#ffd35a', off: () => !beamable('relic'), press: () => act(Act.BeamRelic) }),
        key({ label: () => 'ABORT', color: '#ff7a5a', off: () => ship(ctx)?.beam === Beam.Idle, press: () => act(Act.BeamAbort) }),
      ],
      SCREENS.map((s) =>
        key({
          label: () => ['FWD', 'AFT', 'TACT', 'TARGET', 'AWAY'][s],
          small: true,
          on: () => ship(ctx)?.screen === s,
          press: () => act(Act.OnScreen, s),
        }),
      ),
    ],
    status: () => {
      const s = ship(ctx);
      if (!s) return [];
      const p = scope.picked;
      const what = !p
        ? 'NOTHING SELECTED · point at a planet or raider on the scope'
        : 'planet' in p
          ? `${ctx.sector.planets[p.planet].name.toUpperCase()} · ${planetStatus(ctx, s, p.planet)}`
          : `${RAIDERS[(ctx.world.getAs(Raider, p.raider) as RaiderEntity | undefined)?.render.kind ?? 0].name.toUpperCase()} · ${(ctx.world.getAs(Raider, p.raider) as RaiderEntity | undefined)?.render.scanned ? 'harmonics known' : 'unscanned'}`;
      const blocked = transporterBlocked(s);
      const beam =
        s.beam !== Beam.Idle
          ? `${['', 'Beaming down', 'Beaming up', 'Locking onto the relic'][s.beam]}… ${Math.round(s.beamT * 100)}%`
          : blocked
            ? `TRANSPORTER: ${blocked}`
            : `TRANSPORTER READY · in orbit of ${ctx.sector.planets[s.orbit - 1].name}`;
      return [what, beam];
    },
  };
}

/** Engineering: a row per system — how it's doing, the power in it, and the damage control team. */
function engineeringKeys(ctx: StarshipContext): Controls {
  const rows = SYSTEMS.map((sys) => [
    key({
      label: () => {
        const s = ship(ctx);
        return s ? `${SYSTEM_NAMES[sys].toUpperCase()} ${Math.round(health(s, sys) * 100)}%` : SYSTEM_NAMES[sys].toUpperCase();
      },
      small: true,
      span: 2,
      off: () => true,
      fill: () => {
        const s = ship(ctx);
        return s ? health(s, sys) : 0;
      },
      press: () => {},
    }),
    ...Array.from({ length: MAX_PIPS + 1 }, (_, n) =>
      key({
        label: () => (n === 0 ? '○' : String(n)),
        small: true,
        on: () => {
          const s = ship(ctx);
          return !!s && n > 0 && n <= pips(s, sys);
        },
        off: () => {
          const s = ship(ctx);
          return !!s && n > pips(s, sys) && n - pips(s, sys) > POWER_POOL - powerUsed(s);
        },
        press: () => act(Act.Power, sys, n),
      }),
    ),
    key({
      label: () => 'TEAM',
      small: true,
      on: () => ship(ctx)?.team === sys,
      press: () => act(Act.DamageControl, sys),
    }),
  ]);
  return {
    rows,
    status: () => {
      const s = ship(ctx);
      if (!s) return [];
      const used = powerUsed(s);
      return [
        `POWER ${used} / ${POWER_POOL}${used < POWER_POOL ? ` · ${POWER_POOL - used} spare` : ''} · ${SYSTEMS.map((sys) => `${SYSTEM_NAMES[sys].slice(0, 3).toUpperCase()} ${Math.round(efficiency(s, sys) * 100)}%`).join('  ')}`,
        s.team !== 255 ? `Damage control team in the ${SYSTEM_NAMES[s.team as ShipSystem].toLowerCase()} room` : 'Hull hits start fires. Send the team, or crew with spanners.',
      ];
    },
  };
}
