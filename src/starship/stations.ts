import { angleDiff, type CrewEntity, type RaiderEntity, type StarshipContext } from './context';
import { crewStations } from './crew';
import { PAD } from './deck';
import { Act, Beam, Crew, CrewMode, Fault, FaultKind, Phase, Raider, Relic, Screen, SCREENS, ShipSystem, Station, STATIONS, SYSTEMS, Warp } from './defs';
import { act, type ConsoleAct } from './intent';
import { STATION_COLORS, css } from './models';
import { manning } from './officer';
import { RAIDERS } from './raiders';
import { engineeringScope, helmScope, phaseLine, planetStatus, scienceScope, tacticalScope, type Picked, type Scope } from './scopes';
import {
  DOCK_REACH,
  MAX_PIPS,
  MAX_TORPS,
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
  private readonly scopeEl = el('canvas', 'scope');
  private readonly controls = el('div', 'controls');
  private readonly feedEl = el('div', 'feed-line');
  private station: Station;
  private scope: Scope = { draw: () => {}, tap: () => null };
  private tick: () => void = () => {};
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
    scopeBox.appendChild(this.scopeEl);
    body.append(scopeBox, this.controls);
    this.root.append(top, this.phaseEl, body, this.feedEl);
    (opts.parent ?? document.body).appendChild(this.root);

    this.scopeEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = this.scopeEl.getBoundingClientRect();
      const order = this.scope.tap(e.clientX - r.left, e.clientY - r.top);
      if (order) this.send(order);
      else this.ctx.sfx.play('tap');
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
    const box = this.scopeEl.parentElement!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return;
    this.scopeEl.width = Math.round(w * dpr);
    this.scopeEl.height = Math.round(h * dpr);
    this.scopeEl.style.width = `${w}px`;
    this.scopeEl.style.height = `${h}px`;
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
    const g = this.scopeEl.getContext('2d');
    if (!g) return;
    const dpr = this.scopeEl.width / Math.max(1, this.scopeEl.clientWidth);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = this.scopeEl.clientWidth;
    const h = this.scopeEl.clientHeight;
    g.clearRect(0, 0, w, h);
    this.scope.draw(g, w, h);
  }

  // -------------------------------------------------------------------------
  // Helm
  // -------------------------------------------------------------------------

  private buildHelm(): void {
    const { ctx } = this;
    let throttle: number | null = null;
    let lastThrottleSent = 0;
    let steering = 0;
    let course: number | null = null;
    let lastCourseSent = 0;

    const scope = (this.scope = helmScope(ctx, { course: () => course }));

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
    const zoomB = press('SECTOR MAP', '', () => scope.zoom!());
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
      setText(zoomB, scope.zoomLabel!());
      const dg = dial.getContext('2d');
      if (dg) {
        dg.clearRect(0, 0, dial.width, dial.height);
        drawDial(dg, dial.width, ship.heading, course ?? ship.course, ship.autopilot || ship.warp !== Warp.Idle || !!ship.orbit);
      }
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
    this.scope = tacticalScope(ctx);

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
    const scope = (this.scope = scienceScope(ctx));

    const card = el('div', 'card');
    const name = el('b');
    const info = el('div', 'small');
    const scan = press('SCAN', 'big scan', () => {
      const picked = scope.picked;
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
    const zoomB = press('LOCAL MAP', 'small-btn', () => scope.zoom!());
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
      setText(zoomB, scope.zoomLabel!());
      const picked: Picked = scope.picked ?? null;
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
    this.scope = engineeringScope(ctx);

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


/** A compass dial `size` across, drawn into the box at the context's origin: which way the ship points and is steering. */
export function drawDial(g: CanvasRenderingContext2D, size: number, heading: number, course: number, auto: boolean): void {
  // drawn in a 360-unit box and scaled to fit, so it reads the same on a phone as on a console's face
  const r = 172;
  g.save();
  g.translate(size / 2, size / 2);
  g.scale(size / 360, size / 360);
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
