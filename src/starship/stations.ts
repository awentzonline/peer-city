import { angleDiff, type CrewEntity, type FaultEntity, type RaiderEntity, type ShipState, type StarshipContext } from './context';
import { crewStations } from './crew';
import { PAD, ROOMS, SHIP } from './deck';
import { Act, Beam, Crew, CrewMode, Fault, FaultKind, Phase, Raider, RaiderKind, Relic, Result, Screen, SCREENS, ShipSystem, Station, STATIONS, SYSTEMS, Warp } from './defs';
import { act, type ConsoleAct } from './intent';
import { STATION_COLORS, css } from './models';
import { manning } from './officer';
import { RAIDERS } from './raiders';
import { SECTOR, bitCount } from './sector';
import {
  DOCK_REACH,
  MAX_PIPS,
  MAX_TORPS,
  ORBIT_REACH,
  PHASER_ARC,
  PHASER_RANGE,
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

export const STATION_NAMES: Record<Station, string> = {
  [Station.Helm]: 'Helm',
  [Station.Tactical]: 'Tactical',
  [Station.Science]: 'Science',
  [Station.Engineering]: 'Engineering',
  [Station.Viewer]: 'Viewscreen',
  [Station.None]: '',
};

const SCREEN_NAMES: Record<Screen, string> = {
  [Screen.Forward]: 'FWD',
  [Screen.Aft]: 'AFT',
  [Screen.Tactical]: 'TACT',
  [Screen.Target]: 'TARGET',
  [Screen.Away]: 'AWAY',
};

/** Ship headings as a compass shows them: 0° up the map (-y), clockwise. */
export function bearing(heading: number): number {
  return Math.round(((((heading * 180) / Math.PI + 90) % 360) + 360) % 360);
}

export function headingOf(degrees: number): number {
  return ((degrees - 90) * Math.PI) / 180;
}

export interface PanelOptions {
  station: Station;
  /** An order was given. */
  send(a: ConsoleAct): void;
  /** Another station's tab was chosen. Leave out to hide the tabs (a console on the bridge is one station). */
  switchTo?(station: Station): void;
  /** Chips for what a phone can't reach with keys. */
  chips?: { menu(): void; mic(): void };
  /** A button to get up from a console. */
  leave?(): void;
  parent?: HTMLElement;
}

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

/** A button that acts the moment a finger lands on it, rather than on the click a moment later. */
function press(label: string, cls: string, onPress: () => void): HTMLButtonElement {
  const b = el('button', `sb ${cls}`, label);
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!b.disabled) onPress();
  });
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  return b;
}

/** A bar that fills to a fraction. */
function meter(cls = ''): { root: HTMLElement; set(f: number, color?: string): void } {
  const root = el('div', `meter ${cls}`);
  const fill = el('i');
  root.appendChild(fill);
  let last = -1;
  let lastColor = '';
  return {
    root,
    set(f, color) {
      const v = Math.round(Math.max(0, Math.min(1, f)) * 200) / 2;
      if (v !== last) fill.style.width = `${v}%`;
      if (color && color !== lastColor) fill.style.background = color;
      last = v;
      lastColor = color ?? lastColor;
    },
  };
}

/**
 * A bridge station, as a page of touch controls: the phone becomes the console. Tabs along the top switch between helm,
 * tactical, science and engineering (and show who's at each), under them the ship's hull, shields and alert, then the
 * station itself: a scope to tap on (a nav map, a tactical radar, the long-range sensors, the ship's decks) and the
 * controls beside it. It gives orders through `send` and reads the ship's replicated state, so it's the same on a phone,
 * a desktop's screen, or a crew member's console on the bridge.
 */
export class StationPanel {
  readonly root = el('div', 'bridge-ui');
  private readonly tabs = new Map<Station, { el: HTMLButtonElement; who: HTMLElement }>();
  private readonly hull = meter('hull');
  private readonly shields = meter('shields');
  private readonly phaseEl = el('div', 'phase');
  private readonly alertEl = el('div', 'alert', 'RED ALERT');
  private readonly scope = el('canvas', 'scope');
  private readonly controls = el('div', 'controls');
  private readonly feedEl = el('div', 'feed-line');
  private station: Station;
  private draw: Draw = () => {};
  private tick: () => void = () => {};
  private onScopeTap: (x: number, y: number) => void = () => {};
  private nextDraw = 0;
  private feedDrawn = '';
  private readonly observer: ResizeObserver | null = null;

  constructor(
    private readonly ctx: StarshipContext,
    private readonly opts: PanelOptions,
  ) {
    this.station = opts.station;
    const top = el('header', 'bridge-top');
    if (opts.switchTo) {
      const nav = el('nav', 'tabs');
      for (const s of STATIONS) {
        const b = press('', 'tab', () => {
          if (s !== this.station) opts.switchTo!(s);
        });
        const name = el('b');
        name.append(el('span', 'long', STATION_NAMES[s].toUpperCase()), el('span', 'short', ['HELM', 'TAC', 'SCI', 'ENG'][s]));
        const who = el('small');
        b.append(name, who);
        b.style.setProperty('--station', css(STATION_COLORS[s]));
        nav.appendChild(b);
        this.tabs.set(s, { el: b, who });
      }
      top.appendChild(nav);
    } else {
      const name = el('div', 'console-name', STATION_NAMES[this.station].toUpperCase());
      name.style.color = css(STATION_COLORS[this.station]);
      top.appendChild(name);
    }
    const status = el('div', 'status');
    const hullBox = el('div', 'stat');
    hullBox.append(el('span', '', 'HULL'), this.hull.root);
    const shieldBox = el('div', 'stat');
    shieldBox.append(el('span', '', 'SHIELDS'), this.shields.root);
    status.append(hullBox, shieldBox, this.alertEl);
    if (opts.chips) {
      status.append(press('\u{1F3A4}', 'chip', () => opts.chips!.mic()), press('⚙', 'chip', () => opts.chips!.menu()));
    }
    if (opts.leave) status.append(press('STAND UP', 'chip leave', () => opts.leave!()));
    top.appendChild(status);

    const body = el('main', 'bridge-body');
    const scopeBox = el('section', 'scope-box');
    scopeBox.appendChild(this.scope);
    body.append(scopeBox, this.controls);
    this.root.append(top, this.phaseEl, body, this.feedEl);
    (opts.parent ?? document.body).appendChild(this.root);

    this.scope.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = this.scope.getBoundingClientRect();
      this.onScopeTap(e.clientX - r.left, e.clientY - r.top);
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.fit());
      this.observer.observe(scopeBox);
    }
    this.build();
  }

  get current(): Station {
    return this.station;
  }

  show(station: Station): void {
    if (station === this.station) return;
    this.station = station;
    this.build();
  }

  dispose(): void {
    this.observer?.disconnect();
    this.root.remove();
  }

  private send(a: ConsoleAct): void {
    this.opts.send(a);
    this.ctx.sfx.play('tap');
  }

  private fit(): void {
    const box = this.scope.parentElement!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return;
    this.scope.width = Math.round(w * dpr);
    this.scope.height = Math.round(h * dpr);
    this.scope.style.width = `${w}px`;
    this.scope.style.height = `${h}px`;
    this.nextDraw = 0;
  }

  private build(): void {
    this.root.dataset.station = STATION_NAMES[this.station].toLowerCase();
    this.root.style.setProperty('--station', css(STATION_COLORS[this.station]));
    this.controls.replaceChildren();
    for (const [s, t] of this.tabs) t.el.classList.toggle('on', s === this.station);
    switch (this.station) {
      case Station.Helm:
        this.buildHelm();
        break;
      case Station.Tactical:
        this.buildTactical();
        break;
      case Station.Science:
        this.buildScience();
        break;
      default:
        this.buildEngineering();
    }
    this.fit();
  }

  /** Call every rendered frame. */
  update(now: number): void {
    const { ctx } = this;
    const ship = ctx.ship()?.render;
    // who's where
    const officers = manning(ctx);
    const seated = crewStations(ctx);
    for (const [s, t] of this.tabs) setText(t.who, [...(officers.get(s) ?? []), ...(seated.get(s) ?? [])].join(', ') || 'unmanned');
    const feed = ctx.hud.feed.at(-1)?.text ?? '';
    if (feed !== this.feedDrawn) {
      this.feedDrawn = feed;
      this.feedEl.textContent = feed;
      this.feedEl.classList.remove('fresh');
      void this.feedEl.offsetWidth;
      this.feedEl.classList.add('fresh');
    }
    if (!ship) {
      setText(this.phaseEl, 'LOOKING FOR THE SHIP…');
      return;
    }
    this.hull.set(ship.hull / 100, ship.hull < 30 ? '#ff5a4a' : ship.hull < 60 ? '#ffb84a' : '#7ae08a');
    this.shields.set(ship.shields / SHIELD_MAX, ship.shieldsUp ? '#6ab8ff' : '#4a5a70');
    this.alertEl.classList.toggle('on', ship.alert);
    setText(this.phaseEl, phaseLine(ctx, ship));
    this.tick();
    if (now < this.nextDraw) return;
    this.nextDraw = now + 50;
    const g = this.scope.getContext('2d');
    if (!g) return;
    const dpr = this.scope.width / Math.max(1, this.scope.clientWidth);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = this.scope.clientWidth;
    const h = this.scope.clientHeight;
    g.clearRect(0, 0, w, h);
    this.draw(g, w, h);
  }

  // -------------------------------------------------------------------------
  // Helm
  // -------------------------------------------------------------------------

  private buildHelm(): void {
    const { ctx } = this;
    let zoom: 'local' | 'sector' = 'local';
    let throttle: number | null = null;
    let lastThrottleSent = 0;
    let steering = 0;
    let course: number | null = null;
    let lastCourseSent = 0;

    const map = new MapScope(ctx);
    this.draw = (g, w, h) => {
      const ship = ctx.ship()?.render;
      if (!ship) return;
      map.frame(ship, w, h, zoom === 'local' ? 3200 : SECTOR * 1.05);
      map.drawSector(g, ship, { waypoint: true, raiders: sensorRange(ship), course: course ?? ship.course });
      g.fillStyle = 'rgba(200,220,255,0.6)';
      g.font = '11px system-ui, sans-serif';
      g.fillText('Tap the map to set a waypoint', 8, h - 8);
    };
    this.onScopeTap = (x, y) => {
      const p = map.toWorld(x, y);
      this.send(act(Act.Waypoint, p.x, p.y));
    };

    // throttle
    const throttleBox = el('div', 'throttle');
    const track = el('div', 'track');
    const fill = el('i');
    const knob = el('b');
    const zeroMark = el('u');
    track.append(fill, zeroMark, knob);
    const tLabel = el('div', 'readout');
    throttleBox.append(el('span', 'label', 'IMPULSE'), track, tLabel);
    const setFromY = (clientY: number) => {
      const r = track.getBoundingClientRect();
      const f = 1 - (clientY - r.top) / r.height;
      let v = -0.25 + Math.max(0, Math.min(1, f)) * 1.25;
      if (Math.abs(v) < 0.05) v = 0;
      throttle = Math.round(v * 20) / 20;
      const t = performance.now();
      if (t - lastThrottleSent > 90) {
        lastThrottleSent = t;
        this.opts.send(act(Act.Throttle, throttle));
      }
    };
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      track.setPointerCapture(e.pointerId);
      setFromY(e.clientY);
    });
    track.addEventListener('pointermove', (e) => {
      if (track.hasPointerCapture(e.pointerId)) setFromY(e.clientY);
    });
    const release = () => {
      if (throttle !== null) this.send(act(Act.Throttle, throttle));
      throttle = null;
    };
    track.addEventListener('pointerup', release);
    track.addEventListener('pointercancel', release);

    // steering: a compass to drag round, and port/starboard held
    const steer = el('div', 'steer');
    const dial = el('canvas', 'dial');
    dial.width = dial.height = 360;
    const dialLabel = el('div', 'readout');
    const port = el('button', 'sb hold', '◀ PORT');
    const stbd = el('button', 'sb hold', 'STBD ▶');
    for (const [b, dir] of [
      [port, -1],
      [stbd, 1],
    ] as const) {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        steering = dir;
        course = ctx.ship()?.render.course ?? 0;
      });
      const stop = () => {
        steering = 0;
        if (course !== null) this.opts.send(act(Act.Course, course));
        course = null;
      };
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointercancel', stop);
    }
    const dialAt = (e: PointerEvent) => {
      const r = dial.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < r.width * 0.12) return;
      course = Math.atan2(dy, dx);
      const t = performance.now();
      if (t - lastCourseSent > 90) {
        lastCourseSent = t;
        this.opts.send(act(Act.Course, course));
      }
    };
    dial.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dial.setPointerCapture(e.pointerId);
      dialAt(e);
    });
    dial.addEventListener('pointermove', (e) => dial.hasPointerCapture(e.pointerId) && dialAt(e));
    const dialUp = () => {
      if (course !== null && steering === 0) this.send(act(Act.Course, course));
      if (steering === 0) course = null;
    };
    dial.addEventListener('pointerup', dialUp);
    dial.addEventListener('pointercancel', dialUp);
    const ports = el('div', 'row');
    ports.append(port, stbd);
    steer.append(dial, dialLabel, ports);

    const buttons = el('div', 'grid2');
    const autopilot = press('AUTOPILOT', 'toggle', () => this.send(act(Act.Autopilot, ctx.ship()?.render.autopilot ? 0 : 1)));
    const warp = press('WARP', 'warp', () => this.send(act(Act.Warp)));
    const orbit = press('ORBIT', '', () => this.send(act(Act.Orbit)));
    const dock = press('DOCK', '', () => this.send(act(Act.Dock)));
    const stop = press('ALL STOP', 'danger', () => {
      throttle = null;
      this.send(act(Act.AllStop));
    });
    const zoomB = press('SECTOR MAP', '', () => (zoom = zoom === 'local' ? 'sector' : 'local'));
    buttons.append(autopilot, warp, orbit, dock, stop, zoomB);
    const nav = el('div', 'readout nav');
    const left = el('div', 'col');
    left.append(throttleBox);
    const right = el('div', 'col grow');
    right.append(steer, nav, buttons);
    const wrap = el('div', 'helm');
    wrap.append(left, right);
    this.controls.appendChild(wrap);

    this.tick = () => {
      const ship = ctx.ship()?.render;
      if (!ship) return;
      const dt = 1 / 60;
      if (steering !== 0 && course !== null) {
        course += steering * 0.9 * dt;
        const t = performance.now();
        if (t - lastCourseSent > 100) {
          lastCourseSent = t;
          this.opts.send(act(Act.Course, course));
        }
      }
      const shown = throttle ?? ship.throttle;
      const f = (shown + 0.25) / 1.25;
      knob.style.bottom = `calc(${f * 100}% - 14px)`;
      fill.style.height = `${Math.abs(shown) * 80}%`;
      fill.style.bottom = shown >= 0 ? '20%' : `${20 - Math.abs(shown) * 80}%`;
      fill.classList.toggle('reverse', shown < 0);
      zeroMark.style.bottom = '20%';
      setText(tLabel, `${Math.round(shown * 100)}% · ${Math.round(ship.speed)} u/s`);
      setText(zoomB, zoom === 'local' ? 'SECTOR MAP' : 'LOCAL MAP');
      drawDial(dial, ship.heading, course ?? ship.course, ship.autopilot || ship.warp !== Warp.Idle || !!ship.orbit);
      setText(dialLabel, `HEADING ${String(bearing(ship.heading)).padStart(3, '0')}°${ship.orbit ? ' · IN ORBIT' : ship.autopilot ? ' · AUTOPILOT' : ''}`);
      autopilot.classList.toggle('on', ship.autopilot);
      autopilot.disabled = !ship.waypoint || ship.docked || ship.phase !== Phase.Underway;
      const wd = Math.hypot(ship.wx - ship.x, ship.wy - ship.y);
      setText(nav, ship.waypoint ? `WAYPOINT ${Math.round(wd)} u · ${ship.speed > 5 && ship.warp === Warp.Idle ? `ETA ${Math.round(wd / ship.speed)} s` : ship.warp === Warp.Warping ? 'AT WARP' : ''}` : 'No waypoint: tap the map');
      warp.disabled = ship.phase !== Phase.Underway || ship.docked || (ship.warp === Warp.Idle && (!ship.waypoint || wd < WARP_MIN));
      setText(warp, ship.warp === Warp.Charging ? `CHARGING ${Math.round(ship.warpT * 100)}%` : ship.warp === Warp.Warping ? 'AT WARP' : 'WARP');
      warp.style.setProperty('--charge', `${ship.warp === Warp.Charging ? ship.warpT * 100 : ship.warp === Warp.Warping ? 100 : 0}%`);
      const near = ctx.sector.nearestPlanet(ship.x, ship.y);
      orbit.disabled = !ship.orbit && (near.surface > ORBIT_REACH || ship.docked || ship.phase !== Phase.Underway);
      setText(orbit, ship.orbit ? 'BREAK ORBIT' : near.surface <= ORBIT_REACH ? `ORBIT ${near.planet.name.toUpperCase()}` : 'ORBIT');
      orbit.classList.toggle('on', !!ship.orbit);
      const sb = Math.hypot(ctx.sector.starbase.x - ship.x, ctx.sector.starbase.y - ship.y);
      dock.disabled = ship.phase === Phase.Over || (!ship.docked && sb > DOCK_REACH);
      setText(dock, ship.phase === Phase.Briefing ? 'CAST OFF' : ship.docked ? 'UNDOCK' : 'DOCK');
      dock.classList.toggle('go', ship.phase === Phase.Briefing);
    };
  }

  // -------------------------------------------------------------------------
  // Tactical
  // -------------------------------------------------------------------------

  private buildTactical(): void {
    const { ctx } = this;
    const RANGE = 1600;
    let scale = 1;
    let cx = 0;
    let cy = 0;
    this.draw = (g, w, h) => {
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
      g.fillStyle = 'rgba(200,220,255,0.6)';
      g.font = '11px system-ui, sans-serif';
      g.fillText('Tap a raider to target it', 8, h - 8);
    };
    this.onScopeTap = (x, y) => {
      const ship = ctx.ship()?.render;
      if (!ship) return;
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
      if (best) this.send(act(Act.Target, 0, 0, best.id));
    };

    const card = el('div', 'card target');
    const tName = el('b');
    const tInfo = el('div', 'small');
    const tHull = meter();
    const tShields = meter();
    const next = press('NEXT TARGET', '', () => {
      const ship = ctx.ship()?.render;
      if (!ship) return;
      const list = ([...ctx.world.all(Raider)] as RaiderEntity[]).sort((a, b) => Math.hypot(a.x - ship.x, a.y - ship.y) - Math.hypot(b.x - ship.x, b.y - ship.y));
      if (!list.length) return;
      const i = list.findIndex((r) => r.id === ship.target);
      this.send(act(Act.Target, 0, 0, list[(i + 1) % list.length].id));
    });
    card.append(tName, tInfo, labelled('HULL', tHull.root), labelled('SHIELDS', tShields.root), next);

    const phasers = press('PHASERS', 'big fire', () => this.send(act(Act.Phasers)));
    const phaserNote = el('div', 'small center');
    const torpBox = el('div', 'card');
    const tubes = el('div', 'tubes');
    const tubeEls = [el('i'), el('i')];
    tubes.append(el('span', '', 'TUBES'), ...tubeEls);
    const stock = el('div', 'small');
    const loader = meter('thin');
    const torpedo = press('FIRE TORPEDO', 'big fire torp', () => this.send(act(Act.Torpedo)));
    torpBox.append(tubes, stock, loader.root, torpedo);
    const shieldsB = press('SHIELDS', 'big shields', () => this.send(act(Act.Shields, ctx.ship()?.render.shieldsUp ? 0 : 1)));
    const shieldMeter = meter();
    const col1 = el('div', 'col grow');
    col1.append(card, shieldsB, shieldMeter.root);
    const col2 = el('div', 'col grow');
    col2.append(phasers, phaserNote, torpBox);
    const wrap = el('div', 'two');
    wrap.append(col1, col2);
    this.controls.appendChild(wrap);

    this.tick = () => {
      const ship = ctx.ship()?.render;
      if (!ship) return;
      const target = (ctx.world.getAs(Raider, ship.target) as RaiderEntity | undefined) ?? null;
      if (target) {
        const t = target.render;
        const spec = RAIDERS[t.kind];
        setText(tName, spec.name.toUpperCase());
        const rel = Math.round((angleDiff(ship.heading, Math.atan2(target.y - ship.y, target.x - ship.x)) * 180) / Math.PI);
        const side = Math.abs(rel) < 3 ? 'dead ahead' : `${Math.abs(rel)}° ${rel > 0 ? 'starboard' : 'port'}`;
        setText(tInfo, `${Math.round(Math.hypot(target.x - ship.x, target.y - ship.y))} u · ${side}${t.scanned ? ' · HARMONICS KNOWN' : ''}`);
        tHull.set(t.hp / spec.hp, '#ff7a5a');
        tShields.set(t.shields / spec.shields, '#5aff8a');
        card.classList.toggle('scanned', t.scanned);
      } else {
        setText(tName, 'NO TARGET');
        setText(tInfo, ctx.world.all(Raider).size ? 'Tap a raider on the scope' : 'No raiders on sensors');
        tHull.set(0);
        tShields.set(0);
      }
      const why = phaserBlocked(ship, target);
      phasers.disabled = !!why || ship.phase !== Phase.Underway;
      phasers.style.setProperty('--charge', `${Math.round(ship.phaser * 100)}%`);
      setText(phaserNote, why ? `${why}${why === 'Charging' ? ` ${Math.round(ship.phaser * 100)}%` : ''}` : `READY · ${Math.round(ship.phaser * 100)}%`);
      tubeEls.forEach((e, i) => e.classList.toggle('loaded', (ship.tubes & (1 << i)) !== 0));
      setText(stock, `${ship.torps} of ${MAX_TORPS} in the rack${ship.tubes !== 3 && ship.torps > 0 ? ' · autoloading' : ''}`);
      loader.set(ship.loadT, '#ffb84a');
      torpedo.disabled = !ship.tubes || ship.docked || ship.phase !== Phase.Underway;
      shieldsB.classList.toggle('on', ship.shieldsUp);
      shieldsB.disabled = ship.docked && !ship.shieldsUp;
      setText(shieldsB, ship.shieldsUp ? (ship.shields < SHIELD_MAX * 0.95 ? 'SHIELDS RAISING' : 'SHIELDS UP') : 'SHIELDS DOWN');
      shieldMeter.set(ship.shields / SHIELD_MAX, '#6ab8ff');
    };
  }

  // -------------------------------------------------------------------------
  // Science
  // -------------------------------------------------------------------------

  private buildScience(): void {
    const { ctx } = this;
    let zoom: 'local' | 'sector' = 'sector';
    let picked: { planet: number } | { raider: number } | null = null;
    const map = new MapScope(ctx);
    this.draw = (g, w, h) => {
      const ship = ctx.ship()?.render;
      if (!ship) return;
      map.frame(ship, w, h, zoom === 'local' ? 3600 : SECTOR * 1.05);
      map.drawSector(g, ship, { sensors: true, raiders: sensorRange(ship), labels: true, picked });
    };
    this.onScopeTap = (x, y) => {
      const ship = ctx.ship()?.render;
      if (!ship) return;
      const p = map.toWorld(x, y);
      const reach = 30 / map.scale;
      let best: typeof picked = null;
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
      ctx.sfx.play('tap');
    };

    const card = el('div', 'card');
    const name = el('b');
    const info = el('div', 'small');
    const scan = press('SCAN', 'big scan', () => {
      if (!picked) return;
      if ('planet' in picked) this.send(act(Act.ScanPlanet, picked.planet));
      else this.send(act(Act.Scan, 0, 0, picked.raider));
    });
    const scanMeter = meter();
    card.append(name, info, scan, scanMeter.root);

    const tp = el('div', 'card transporter');
    const tpStatus = el('div', 'small');
    const beamMeter = meter();
    const down = press('BEAM DOWN', '', () => this.send(act(Act.BeamDown)));
    const up = press('BEAM UP', '', () => this.send(act(Act.BeamUp)));
    const relic = press('BEAM RELIC', '', () => this.send(act(Act.BeamRelic)));
    const abort = press('ABORT', 'danger', () => this.send(act(Act.BeamAbort)));
    const tpButtons = el('div', 'grid2');
    tpButtons.append(down, up, relic, abort);
    tp.append(el('b', '', 'TRANSPORTER'), tpStatus, beamMeter.root, tpButtons);

    const screen = el('div', 'card');
    const screenRow = el('div', 'row screens');
    const screenButtons = SCREENS.map((s) => {
      const b = press(SCREEN_NAMES[s], 'small-btn', () => this.send(act(Act.OnScreen, s)));
      screenRow.appendChild(b);
      return b;
    });
    const zoomB = press('LOCAL MAP', 'small-btn', () => (zoom = zoom === 'local' ? 'sector' : 'local'));
    screen.append(el('b', '', 'ON SCREEN'), screenRow);
    const col1 = el('div', 'col grow');
    col1.append(card, screen, zoomB);
    const col2 = el('div', 'col grow');
    col2.append(tp);
    const wrap = el('div', 'two');
    wrap.append(col1, col2);
    this.controls.appendChild(wrap);

    this.tick = () => {
      const ship = ctx.ship()?.render;
      if (!ship) return;
      setText(zoomB, zoom === 'local' ? 'SECTOR MAP' : 'LOCAL MAP');
      if (picked && 'raider' in picked && !ctx.world.getAs(Raider, picked.raider)) picked = null;
      const scanningThis = picked && ('planet' in picked ? ship.scanPlanet === picked.planet + 1 : ship.scanning === picked.raider);
      if (!picked) {
        setText(name, 'NOTHING SELECTED');
        setText(info, 'Tap a planet or a raider on the map');
        scan.disabled = true;
      } else if ('planet' in picked) {
        const p = ctx.sector.planets[picked.planet];
        const d = Math.max(0, Math.hypot(p.x - ship.x, p.y - ship.y) - p.radius);
        setText(name, p.name.toUpperCase());
        setText(info, `${Math.round(d)} u · ${planetStatus(ctx, ship, p.index)}`);
        scan.disabled = d > sensorRange(ship) || ship.phase !== Phase.Underway;
      } else {
        const r = ctx.world.getAs(Raider, picked.raider) as RaiderEntity;
        setText(name, RAIDERS[r.render.kind].name.toUpperCase());
        setText(info, `${Math.round(Math.hypot(r.x - ship.x, r.y - ship.y))} u · ${r.render.scanned ? 'shield harmonics known: tactical does half again the damage' : 'unscanned'}`);
        scan.disabled = r.render.scanned;
      }
      setText(scan, scanningThis ? `SCANNING ${Math.round(ship.scanT * 100)}%` : 'SCAN');
      scanMeter.set(scanningThis ? ship.scanT : 0, '#b48aff');

      const blocked = transporterBlocked(ship);
      const pad = ([...ctx.world.all(Crew)] as CrewEntity[]).filter((c) => c.render.mode === CrewMode.Up && ctx.deck.onShip(c.x) && Math.hypot(c.x - PAD.x, c.y - PAD.y) <= PAD.radius).length;
      const planet = ship.orbit - 1;
      const away = planet >= 0 ? ([...ctx.world.all(Crew)] as CrewEntity[]).filter((c) => !ctx.deck.onShip(c.x) && ctx.deck.siteAt(c.x) === planet).length : 0;
      const relicThere = planet >= 0 && [...ctx.world.all(Relic)].some((r) => r.render.site === planet + 1 && !r.render.carrier);
      const busy = ship.beam !== Beam.Idle;
      setText(tpStatus, busy ? `${['', 'Beaming down', 'Beaming up', 'Locking onto the relic through the interference'][ship.beam]}… ${Math.round(ship.beamT * 100)}%` : blocked ? `${blocked}${blocked === 'Shields are up' ? ': tactical must lower them' : blocked === 'Not in orbit' ? ': helm must take up orbit' : ''}` : `In orbit of ${ctx.sector.planets[planet].name} · ${pad} on the pad · ${away} on the surface`);
      beamMeter.set(ship.beamT, '#6ad0ff');
      down.disabled = !!blocked || busy || !pad;
      up.disabled = !!blocked || busy || !away;
      relic.disabled = !!blocked || busy || !relicThere;
      abort.disabled = !busy;
      screenButtons.forEach((b, i) => b.classList.toggle('on', ship.screen === SCREENS[i]));
    };
  }

  // -------------------------------------------------------------------------
  // Engineering
  // -------------------------------------------------------------------------

  private buildEngineering(): void {
    const { ctx } = this;
    let hitRooms: { x0: number; y0: number; x1: number; y1: number; system: ShipSystem | null }[] = [];
    this.draw = (g, w, h) => {
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
      g.fillStyle = 'rgba(200,220,255,0.6)';
      g.font = '11px system-ui, sans-serif';
      g.fillText('Tap a room to send the damage control team there', 8, h - 6);
    };
    this.onScopeTap = (x, y) => {
      const room = hitRooms.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
      if (room && room.system !== null) this.send(act(Act.DamageControl, room.system));
    };

    const power = el('div', 'readout power');
    const rows = SYSTEMS.map((sys) => {
      const row = el('div', 'system');
      const name = el('b', '', SYSTEM_NAMES[sys].toUpperCase());
      const hp = meter();
      const eff = el('small');
      const faults = el('small', 'faults');
      const pipsEl = el('div', 'pips');
      const pipButtons = Array.from({ length: MAX_PIPS + 1 }, (_, n) => {
        const b = press(n === 0 ? '○' : '', `pip${n === 0 ? ' off' : ''}`, () => this.send(act(Act.Power, sys, n)));
        pipsEl.appendChild(b);
        return b;
      });
      const team = press('TEAM', 'small-btn', () => this.send(act(Act.DamageControl, sys)));
      const head = el('div', 'row');
      head.append(name, eff, faults, team);
      row.append(head, hp.root, pipsEl);
      return { sys, hp, eff, faults, pipButtons, team };
    });
    const note = el('div', 'small');
    const col = el('div', 'col grow');
    col.append(power, ...rows.map((r) => r.pipButtons[0].parentElement!.parentElement!), note);
    this.controls.appendChild(col);

    this.tick = () => {
      const ship = ctx.ship()?.render;
      if (!ship) return;
      const used = powerUsed(ship);
      setText(power, `POWER ${used} / ${POWER_POOL}${used < POWER_POOL ? ` · ${POWER_POOL - used} spare` : ''}`);
      const counts = new Map<ShipSystem, { fire: number; sparks: number }>();
      for (const f of ctx.world.all(Fault)) {
        const c = counts.get(f.render.system) ?? { fire: 0, sparks: 0 };
        if (f.render.kind === FaultKind.Fire) c.fire++;
        else c.sparks++;
        counts.set(f.render.system, c);
      }
      for (const r of rows) {
        const hl = health(ship, r.sys);
        r.hp.set(hl, hl > 0.8 ? '#7ae08a' : hl > 0.5 ? '#ffb84a' : '#ff5a4a');
        setText(r.eff, `${Math.round(efficiency(ship, r.sys) * 100)}%`);
        const c = counts.get(r.sys);
        setText(r.faults, c ? `${'🔥'.repeat(c.fire)}${'⚡'.repeat(c.sparks)}` : '');
        const p = pips(ship, r.sys);
        r.pipButtons.forEach((b, n) => {
          b.classList.toggle('lit', n > 0 && n <= p);
          b.classList.toggle('over', n > 2 && n <= p);
          b.disabled = n > p && n - p > POWER_POOL - used;
        });
        r.team.classList.toggle('on', ship.team === r.sys);
      }
      setText(note, ship.team !== 255 ? `Damage control team in the ${SYSTEM_NAMES[ship.team as ShipSystem].toLowerCase()} room. Crew with spanners work faster.` : 'Hull hits start fires and break things. Send the team, or crew.');
    };
  }
}

function labelled(text: string, child: HTMLElement): HTMLElement {
  const row = el('div', 'labelled');
  row.append(el('span', '', text), child);
  return row;
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

function triangle(g: CanvasRenderingContext2D, x: number, y: number, heading: number, size: number, color: string): void {
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

function drawDial(c: HTMLCanvasElement, heading: number, course: number, auto: boolean): void {
  const g = c.getContext('2d');
  if (!g) return;
  const s = c.width;
  const r = s / 2 - 8;
  g.clearRect(0, 0, s, s);
  g.save();
  g.translate(s / 2, s / 2);
  g.strokeStyle = 'rgba(160,190,230,0.5)';
  g.lineWidth = 4;
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(200,220,255,0.8)';
  g.font = 'bold 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const [deg, t] of [
    [0, '0'],
    [90, '90'],
    [180, '180'],
    [270, '270'],
  ] as const) {
    const a = headingOf(deg);
    g.fillText(t, Math.cos(a) * (r - 30), Math.sin(a) * (r - 30));
  }
  for (let d = 0; d < 360; d += 15) {
    const a = headingOf(d);
    g.beginPath();
    g.moveTo(Math.cos(a) * (r - (d % 45 ? 6 : 14)), Math.sin(a) * (r - (d % 45 ? 6 : 14)));
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    g.stroke();
  }
  // the course asked for
  g.strokeStyle = auto ? 'rgba(255,211,90,0.5)' : '#ffd35a';
  g.lineWidth = 10;
  g.beginPath();
  g.arc(0, 0, r - 4, course - 0.08, course + 0.08);
  g.stroke();
  // where the ship points
  g.rotate(heading);
  g.fillStyle = '#6ad0ff';
  g.beginPath();
  g.moveTo(r - 50, 0);
  g.lineTo(-30, 26);
  g.lineTo(-14, 0);
  g.lineTo(-30, -26);
  g.closePath();
  g.fill();
  g.restore();
}

interface MapOptions {
  waypoint?: boolean;
  /** Show raiders within this range. */
  raiders?: number;
  sensors?: boolean;
  labels?: boolean;
  course?: number;
  picked?: { planet: number } | { raider: number } | null;
}

/** A top-down map of the sector for a canvas: north up, centred on the ship (or the whole sector). */
class MapScope {
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
