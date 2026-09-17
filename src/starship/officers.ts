import { HeadsetHud } from '../crossplay/headsetHud';
import type { DesktopInput } from '../crossplay/input';
import { Platform } from '../crossplay/platform';
import { Btn, type Rig, type XrPoseSource } from '../crossplay/rig';
import { VrSettings } from '../crossplay/settingsPanel';
import type { TouchChips } from '../crossplay/shell';
import { headingToYaw } from '../crossplay/math';
import { SnapTurn } from '../crossplay/vrControls';
import { VrConsole } from './consoleVr';
import type { StarshipContext } from './context';
import { CONSOLES, SPAWN } from './deck';
import type { DeckView } from './decks';
import { Act, Screen, SCREENS, Station, STATIONS } from './defs';
import { act, idleOfficerIntent, type ConsoleAct, type OfficerIntent } from './intent';
import { manning, type OfficerFrontend } from './officer';
import { StationPanel, STATION_NAMES } from './stations';
import { AwayCamera, type Draws, type Drawn } from './view';

/** A station nobody's at yet, else the least crowded one. */
export function freeStation(ctx: StarshipContext): Station {
  const manned = manning(ctx);
  let best: Station = Station.Helm;
  let fewest = Infinity;
  for (const s of STATIONS) {
    const n = manned.get(s)?.length ?? 0;
    if (n < fewest) {
      fewest = n;
      best = s;
    }
  }
  return best;
}

/**
 * A bridge station on a phone, a tablet or a desktop's screen: the station panel fills the page and nothing 3D is drawn.
 * Tabs switch stations, so a small crew can run the whole bridge between them.
 */
export class StationScreen implements OfficerFrontend, Draws {
  readonly cursor = true;
  private readonly panel: StationPanel;
  private readonly intent: OfficerIntent;
  private readonly queue: ConsoleAct[] = [];

  constructor(
    private readonly ctx: StarshipContext,
    readonly platform: Platform,
    station: Station,
    chips: TouchChips | null,
    onStation: (s: Station) => void,
  ) {
    this.intent = idleOfficerIntent(station);
    this.panel = new StationPanel(ctx, {
      station,
      send: (a) => this.queue.push(a),
      switchTo: (s) => {
        this.panel.show(s);
        onStation(s);
      },
      chips: chips ?? undefined,
    });
    ctx.hud.message(`You have the ${['helm', 'tactical station', 'science station', 'engineering station'][station]}. The tabs along the top switch stations.`);
  }

  drawn(): Drawn {
    return { place: 'none' };
  }

  jolt(amount: number, shielded: boolean): void {
    navigator.vibrate?.(shielded ? 30 : Math.min(300, 60 + amount * 10));
    this.panel.root.classList.remove('jolt');
    void this.panel.root.offsetWidth;
    this.panel.root.classList.add('jolt');
  }

  read(): OfficerIntent {
    const { intent } = this;
    intent.station = this.panel.current;
    intent.acts.length = 0;
    intent.acts.push(...this.queue);
    this.queue.length = 0;
    return intent;
  }

  present(): void {
    this.panel.update(this.ctx.now);
  }

  dispose(): void {
    this.panel.dispose();
  }
}

/**
 * A station player in a headset: you stand at that station's console on the bridge and work it with your hands, the same
 * console a seated crew member gets (see consoleVr.ts). CHANGE STATION in its corner walks you round to the next one, so
 * a headset can cover the bridge the way a phone's tabs do.
 */
export class StationVr implements OfficerFrontend, Draws {
  readonly platform = Platform.Vr;
  private readonly panels: HeadsetHud;
  private readonly menu: VrSettings;
  private readonly turn = new SnapTurn();
  private readonly intent: OfficerIntent;
  private console: VrConsole | null = null;
  private station: Station;
  private place = true;

  constructor(
    private readonly ctx: StarshipContext,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
    private readonly decks: DeckView,
    station: Station,
    private readonly onStation: (s: Station) => void,
  ) {
    rig.setMode(source.mode);
    this.station = station;
    this.intent = idleOfficerIntent(station);
    this.panels = new HeadsetHud(rig, ctx.hud, 0.2);
    this.menu = new VrSettings(ctx.settings, rig);
    ctx.hud.message(`You have the ${STATION_NAMES[station].toLowerCase()}. Touch a key on the console and pull the trigger.`);
  }

  drawn(): Drawn {
    return { place: 'deck', camera: this.rig.camera, x: SPAWN.x };
  }

  read(dt: number): OfficerIntent {
    const { rig, intent } = this;
    this.source.read(rig, dt);
    intent.acts.length = 0;
    intent.station = this.station;
    if (this.place) {
      // standing at the console, a step back from it, facing the way it faces
      const c = CONSOLES[this.station];
      rig.root.position.set(c.x - Math.cos(c.heading) * STAND_BACK, rig.floorY, c.y - Math.sin(c.heading) * STAND_BACK);
      rig.root.rotation.set(0, headingToYaw(c.heading), 0);
      this.place = false;
    }
    this.turn.update(rig, rig.right.stickX);
    if (rig.left.pressed(Btn.B)) this.menu.toggle();
    const onMenu = this.menu.update(this.ctx.now);
    if (this.console?.station !== this.station) {
      this.console?.dispose();
      this.console = new VrConsole(this.ctx, rig, this.decks, this.station, { label: 'CHANGE STATION', press: () => this.moveOn() });
    }
    if (!onMenu) this.console.update(this.ctx.now, dt, intent.acts);
    return intent;
  }

  /** Round to the next station, and stand at its console. */
  private moveOn(): void {
    const i = STATIONS.findIndex((s) => s === this.station);
    this.station = STATIONS[(i + 1) % STATIONS.length];
    this.place = true;
    this.onStation(this.station);
    this.ctx.hud.message(`You have the ${STATION_NAMES[this.station].toLowerCase()}.`);
  }

  present(): void {
    this.panels.update(this.ctx.now);
  }

  dispose(): void {
    this.console?.dispose();
    this.panels.dispose();
    this.menu.dispose();
  }
}

/** How far back from a console a standing officer plants themselves, m. */
const STAND_BACK = 0.75;

const SCREEN_KEYS: Record<string, Screen> = { Digit1: Screen.Forward, Digit2: Screen.Aft, Digit3: Screen.Tactical, Digit4: Screen.Target, Digit5: Screen.Away };

/**
 * The viewscreen: a big screen for the bridge crew to look at, a TV or a laptop at the front of the room. It shows space
 * the way science has put it on screen (or the away team), with the ship's status round the edge. 1-5 or the buttons
 * change what's on screen, for everyone.
 */
export class ViewerScreen implements OfficerFrontend, Draws {
  readonly cursor = true;
  private readonly intent = idleOfficerIntent(Station.Viewer);
  private readonly away: AwayCamera;
  private readonly buttons = document.getElementById('screens');
  private readonly queue: ConsoleAct[] = [];
  private awayShown = false;

  constructor(
    private readonly ctx: StarshipContext,
    readonly platform: Platform,
    private readonly input: DesktopInput | null,
    private readonly aimSpace: (mode: Screen, aspect: number) => void,
  ) {
    this.away = new AwayCamera(ctx);
    if (this.buttons) {
      this.buttons.hidden = false;
      this.buttons.replaceChildren(
        ...SCREENS.map((s, i) => {
          const b = document.createElement('button');
          b.innerHTML = `<small>${i + 1}</small>${['FORWARD', 'AFT', 'TACTICAL', 'TARGET', 'AWAY TEAM'][s]}`;
          b.addEventListener('click', () => this.queue.push(act(Act.OnScreen, s)));
          return b;
        }),
      );
    }
    ctx.hud.message('This screen is the viewscreen. Put it where the bridge crew can see it.');
  }

  drawn(): Drawn {
    const mode = this.ctx.ship()?.render.screen ?? Screen.Forward;
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    if (mode === Screen.Away && this.away.aim(aspect, 1 / 60)) {
      this.awayShown = true;
      return { place: 'deck', camera: this.away.camera, x: this.away.subject()!.x };
    }
    this.awayShown = false;
    this.aimSpace(mode === Screen.Away ? Screen.Tactical : mode, aspect);
    return { place: 'space' };
  }

  read(): OfficerIntent {
    const { intent, input } = this;
    intent.acts.length = 0;
    intent.acts.push(...this.queue);
    this.queue.length = 0;
    if (input && !this.ctx.settings.open) {
      for (const [code, s] of Object.entries(SCREEN_KEYS)) if (input.pressed(code)) intent.acts.push(act(Act.OnScreen, s));
    }
    return intent;
  }

  present(): void {
    const { ctx } = this;
    const ship = ctx.ship()?.render;
    const mode = ship?.screen ?? Screen.Forward;
    ctx.hud.viewer(mode, this.awayShown ? (this.away.subject()?.render.name ?? '') : '');
    if (this.buttons) [...this.buttons.children].forEach((b, i) => b.classList.toggle('on', SCREENS[i] === mode));
    ctx.sfx.setListener({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  }

  jolt(amount: number, shielded: boolean): void {
    const el = document.getElementById('hurt');
    if (shielded || amount < 3 || !el) return;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  dispose(): void {
    if (this.buttons) this.buttons.hidden = true;
  }
}

/**
 * The viewscreen in a headset: sit up on the ship's hull just behind the bow, and ride it through space. Turning's the
 * ship's, so it's gentle, and the right stick snap-turns to look round.
 */
export class ViewerVr implements OfficerFrontend, Draws {
  readonly platform = Platform.Vr;
  private readonly intent = idleOfficerIntent(Station.Viewer);
  private readonly panels: HeadsetHud;
  private readonly menu: VrSettings;
  private readonly turn = new SnapTurn();
  private turnOffset = 0;

  constructor(
    private readonly ctx: StarshipContext,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
  ) {
    rig.setMode(source.mode);
    this.panels = new HeadsetHud(rig, ctx.hud, 0.2);
    this.menu = new VrSettings(ctx.settings, rig);
    rig.camera.far = 80000;
    rig.camera.updateProjectionMatrix();
    ctx.hud.message('You are riding on the hull. Snap-turn with the right stick to look round.');
  }

  drawn(): Drawn {
    return { place: 'space', camera: this.rig.camera };
  }

  /** Where the headset rides: on the hull behind the bridge, turning with the ship. */
  private ride(): void {
    const ship = this.ctx.ship();
    if (!ship) return;
    const s = ship.render;
    const root = this.rig.root;
    root.position.set(ship.x + Math.cos(s.heading) * 4, 6, ship.y + Math.sin(s.heading) * 4);
    root.rotation.y = -s.heading - Math.PI / 2 + this.turnOffset;
    root.updateMatrixWorld(true);
  }

  read(dt: number): OfficerIntent {
    const { rig } = this;
    this.source.read(rig, dt);
    const before = rig.root.rotation.y;
    this.turn.update(rig, rig.right.stickX);
    this.turnOffset += rig.root.rotation.y - before;
    if (rig.left.pressed(Btn.B)) this.menu.toggle();
    this.menu.update(this.ctx.now);
    this.ride();
    this.intent.acts.length = 0;
    return this.intent;
  }

  present(): void {
    this.ride();
    this.ctx.hud.setHint('');
    this.panels.update(this.ctx.now);
  }

  dispose(): void {
    this.panels.dispose();
    this.menu.dispose();
    this.rig.camera.far = 1500;
    this.rig.camera.updateProjectionMatrix();
  }
}
