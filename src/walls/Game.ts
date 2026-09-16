import { EntityViews, NetDebugPanel, type NetWorld } from '@engine/index';
import type { Transport } from '@engine/transport/types';
import type { DesktopInput } from '../crossplay/input';
import { Platform } from '../crossplay/platform';
import { WebXrPoses } from '../crossplay/rig';
import { Seat } from '../crossplay/role';
import { Settings } from '../crossplay/settings';
import { SettingsMenu } from '../crossplay/settingsMenu';
import { Stage, errorText } from '../crossplay/stage';
import { Voice, bodySpeakers } from '../crossplay/voice';
import { SimulatedXr } from '../crossplay/xrsim';
import type { WallsContext } from './context';
import { Painter as PainterDef } from './defs';
import { DesktopPainter } from './desktop';
import { Effects } from './effects';
import type { Hud } from './hud';
import type { WallsIntent } from './intent';
import { Painter, type PainterFrontend } from './painter';
import { Scenery } from './scenery';
import type { Sfx } from './sfx';
import type { WallStore } from './store';
import { WallSync, type SavedTile } from './sync';
import { TouchPainter } from './touch';
import { registerViews } from './views';
import { VrPainter } from './vr';
import { buildSurfaces } from './yard';

/** How often the walls are kept in this browser while they're changing, ms. */
const AUTOSAVE_MS = 15_000;

export interface GameDeps {
  world: NetWorld;
  /** The world's transport, which voice opens its own rooms on (see crossplay/voice.ts). */
  transport: Transport;
  hud: Hud;
  sfx: Sfx;
  playerName: string;
  /** The yard's name: which walls this is, here and in the store. */
  yard: string;
  netLabel: string;
  container: HTMLElement;
  store: WallStore;
  /** What the store had for this yard, loaded before starting. */
  saved: SavedTile[] | null;
  /** Emulate a headset on desktop (?xrsim). */
  sim: boolean;
  /** Play with fingers: the touch frontend rather than keys and mouse. */
  touch: boolean;
  /** How long to look for other painters before starting walls of your own, ms. */
  settleMs: number;
}

export class Game {
  readonly stage: Stage;
  readonly ctx: WallsContext;
  readonly painter: Painter;
  readonly voice: Voice;
  readonly seat: Seat<WallsIntent, PainterFrontend>;
  private readonly menu: SettingsMenu;
  private readonly views: EntityViews;
  private readonly extraViews: { update(dt: number): void };
  private readonly debug: NetDebugPanel;
  private readonly vrButton = document.getElementById('vr-enter') as HTMLButtonElement;
  private savedVersion = 0;
  private nextSave = 0;

  constructor(private readonly deps: GameDeps) {
    const { world, hud, sfx } = deps;
    const stage = (this.stage = new Stage(deps.container));
    new Scenery(stage.scene);
    this.voice = new Voice({
      transport: deps.transport,
      prefix: `${world.worldId}/voice/`,
      audio: sfx,
      zones: () => world.zoneKeys(),
      speakers: bodySpeakers(world, PainterDef),
    });
    const settings = new Settings({ voice: this.voice, sfx });
    const surfaces = buildSurfaces();
    const ctx: WallsContext = (this.ctx = {
      world,
      surfaces,
      sync: null as unknown as WallSync,
      sfx,
      hud,
      settings,
      fx: new Effects(stage.scene),
      me: null,
      playerName: deps.playerName,
      now: performance.now(),
    });
    ctx.sync = new WallSync(
      {
        world,
        surfaces,
        me: () => ctx.me,
        now: () => performance.now(),
        wallClock: () => Date.now() / 1000,
        message: (text) => hud.message(text),
        saved: () => deps.saved,
      },
      { settleMs: deps.settleMs, staleMs: 12_000 },
    );
    this.painter = new Painter(ctx);
    this.views = new EntityViews(world);
    this.extraViews = registerViews(ctx, this.views, stage.scene, { showSelf: () => this.seat.frontend.showSelf }, this.painter);

    world.on('entityAdded', (e) => {
      if (e.def !== PainterDef || e.mine) return;
      setTimeout(() => {
        const name = world.getAs(PainterDef, e.id)?.state.name;
        if (name) hud.message(`${name} is painting here`);
      }, 1500);
      sfx.play('join');
    });
    this.painter.spawn();
    this.seat = new Seat<WallsIntent, PainterFrontend>(this.painter, () => this.frontend());

    this.menu = new SettingsMenu(settings, stage.input);
    this.debug = new NetDebugPanel(world, document.body, deps.netLabel);
    this.debug.visible = new URLSearchParams(location.search).has('debug');

    stage.input.onLockChange = () => this.showLockPrompt();
    this.showLockPrompt();
    hud.show();
    hud.message(`Welcome to the yard, ${deps.playerName}!`);
    if (!deps.touch) hud.message('Hold the mouse button to spray. Get closer for a sharper line.');
    hud.message(deps.touch ? 'Tap a colour along the bottom, or use a tool on the rack by the gate.' : 'Pick colours off the rack by the gate, or with the wheel.');

    void Stage.vrSupported().then((ok) => (this.vrButton.hidden = !ok));
    this.vrButton.addEventListener('click', () => {
      stage.enterVR().catch((err: unknown) => hud.message(`Couldn't start VR: ${errorText(err)}`));
    });

    stage.run({
      step: (dt, visible) => this.step(dt, visible),
      platformChanged: (presenting) => {
        this.vrButton.hidden = presenting;
        this.menu.setOpen(false);
        this.seat.use(() => this.frontend());
        this.showLockPrompt();
      },
    });
  }

  get input(): DesktopInput {
    return this.stage.input;
  }

  startSession(session: XRSession): Promise<void> {
    return this.stage.startSession(session);
  }

  /** A frontend for how this page is being played right now. */
  private frontend(): PainterFrontend {
    const { ctx, painter, stage } = this;
    const { rig, input } = stage;
    if (stage.presenting) return new VrPainter(ctx, painter, rig, new WebXrPoses(stage.renderer.xr));
    if (this.deps.sim) return new VrPainter(ctx, painter, rig, new SimulatedXr(input));
    if (this.deps.touch) return new TouchPainter(ctx, painter, rig, { menu: () => this.menu.toggle(), mic: () => void this.talk() });
    return new DesktopPainter(ctx, painter, input, rig);
  }

  private showLockPrompt(): void {
    const { stage } = this;
    const platform = stage.presenting ? Platform.Vr : this.deps.touch ? Platform.Touch : Platform.Desktop;
    this.ctx.hud.setLocked(stage.input.locked, platform);
  }

  private step(dt: number, visible: boolean): void {
    const { ctx } = this;
    const { rig, input } = this.stage;
    ctx.now = performance.now();

    ctx.world.update(ctx.now);
    this.voice.update();
    ctx.sync.update();
    this.seat.step(dt);
    this.autosave();
    if (!visible) return;

    this.views.update(dt);
    this.extraViews.update(dt);
    this.seat.present(dt);
    rig.update(dt);
    this.menu.update(ctx.now);
    this.debug.update(ctx.now);

    if (input.pressed('Backquote')) this.debug.visible = !this.debug.visible;
    if (input.pressed('KeyN')) {
      ctx.sfx.muted = !ctx.sfx.muted;
      ctx.hud.message(ctx.sfx.muted ? 'Sound off' : 'Sound on');
    }
    if (this.seat.frontend.platform !== Platform.Desktop) return;
    if (input.pressed('Escape')) this.menu.toggle();
    if (input.pressed('KeyV')) void this.talk();
  }

  /** Keep the walls in this browser every so often while they're changing, so they're here next time. */
  private autosave(force = false): void {
    const { sync } = this.ctx;
    if (!sync.synced || sync.version === this.savedVersion) return;
    if (!force && this.ctx.now < this.nextSave) return;
    this.savedVersion = sync.version;
    this.nextSave = this.ctx.now + AUTOSAVE_MS;
    void this.deps.store.save(this.deps.yard, this.ctx.surfaces);
  }

  private async talk(): Promise<void> {
    const on = await this.voice.toggleTalking();
    const { hud } = this.ctx;
    if (this.voice.error) hud.message(this.voice.error);
    else hud.message(on ? 'Microphone on: painters near you can hear you' : 'Microphone off');
  }

  dispose(): void {
    this.autosave(true);
    this.voice.dispose();
    this.menu.dispose();
    this.ctx.world.dispose();
  }
}
