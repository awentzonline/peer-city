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
import { registerActions } from './actions';
import { Builder, type BuilderFrontend } from './builder';
import type { DerbyContext } from './context';
import type { Course } from './course';
import { Builder as BuilderDef } from './defs';
import { DesktopBuilder } from './desktop';
import { Effects } from './effects';
import type { Hud } from './hud';
import type { DerbyIntent } from './intent';
import { Physics } from './physics';
import { RaceKeeper } from './race';
import { RacerProxies } from './racer';
import { Scenery } from './scenery';
import type { Sfx } from './sfx';
import { TouchBuilder } from './touch';
import { LocalShelf } from './shelf';
import { registerViews } from './views';
import { VrBuilder } from './vr';

export interface GameDeps {
  world: NetWorld;
  /** The world's transport, which voice opens its own rooms on (see crossplay/voice.ts). */
  transport: Transport;
  course: Course;
  hud: Hud;
  sfx: Sfx;
  playerName: string;
  netLabel: string;
  container: HTMLElement;
  /** Emulate a headset on desktop (?xrsim). */
  sim: boolean;
  /** Play with fingers: the touch frontend rather than keys and mouse. */
  touch: boolean;
}

export class Game {
  readonly stage: Stage;
  readonly ctx: DerbyContext;
  readonly builder: Builder;
  readonly voice: Voice;
  /** The local player: the builder role, and the frontend for whichever platform is playing it. */
  readonly seat: Seat<DerbyIntent, BuilderFrontend>;
  private readonly keeper: RaceKeeper;
  private readonly proxies: RacerProxies;
  private readonly menu: SettingsMenu;
  private readonly views: EntityViews;
  private readonly extraViews: { update(dt: number): void };
  private readonly scenery: Scenery;
  private readonly debug: NetDebugPanel;
  private readonly simulateXr: boolean;
  private readonly touch: boolean;
  private readonly vrButton = document.getElementById('vr-enter') as HTMLButtonElement;

  constructor(deps: GameDeps) {
    const { world, course, hud, sfx } = deps;
    const stage = (this.stage = new Stage(deps.container));
    this.simulateXr = deps.sim;
    this.touch = deps.touch;
    this.scenery = new Scenery(course, stage.scene);
    this.voice = new Voice({
      transport: deps.transport,
      prefix: `${world.worldId}/voice/`,
      audio: sfx,
      zones: () => world.zoneKeys(),
      speakers: bodySpeakers(world, BuilderDef),
    });
    const settings = new Settings({ voice: this.voice, sfx });
    this.keeper = new RaceKeeper(world);
    this.ctx = {
      world,
      course,
      physics: new Physics(course),
      sfx,
      hud,
      settings,
      shelf: new LocalShelf(),
      fx: new Effects(stage.scene, course),
      me: null,
      racer: null,
      race: () => this.keeper.race,
      playerName: deps.playerName,
      now: performance.now(),
    };
    this.builder = new Builder(this.ctx);
    this.proxies = new RacerProxies(this.ctx);
    registerActions(this.ctx, this.builder);
    this.views = new EntityViews(world);
    this.extraViews = registerViews(
      this.ctx,
      this.views,
      stage.scene,
      { showSelf: () => this.seat.frontend.showSelf, showDriver: () => this.seat.frontend.showDriver },
      this.builder,
    );

    world.on('peerJoined', () => hud.message('Another builder arrived'));
    this.builder.spawn();
    this.seat = new Seat<DerbyIntent, BuilderFrontend>(this.builder, () => this.frontend());

    this.menu = new SettingsMenu(settings, stage.input);
    this.debug = new NetDebugPanel(world, document.body, deps.netLabel);
    this.debug.visible = new URLSearchParams(location.search).has('debug');

    stage.input.onLockChange = () => this.showLockPrompt();
    this.showLockPrompt();
    hud.show();
    hud.message(`Welcome to the derby, ${deps.playerName}! Your racer is in bay ${(this.ctx.racer?.state.bay ?? 0) + 1}.`);
    if (!this.touch) hud.message('Point at a racer and click to stick parts on.');
    hud.message("Anyone can help build anyone else's racer.");

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
  private frontend(): BuilderFrontend {
    const { ctx, builder, stage } = this;
    const { rig, input } = stage;
    if (stage.presenting) return new VrBuilder(ctx, builder, rig, new WebXrPoses(stage.renderer.xr));
    if (this.simulateXr) return new VrBuilder(ctx, builder, rig, new SimulatedXr(input));
    // Touch has no keyboard to reach the menu or the microphone with, so its chips call them directly.
    if (this.touch) return new TouchBuilder(ctx, builder, rig, { menu: () => this.menu.toggle(), mic: () => void this.talk() });
    return new DesktopBuilder(ctx, builder, input, rig);
  }

  private showLockPrompt(): void {
    // a simulated headset is still played with a captured mouse
    const { stage } = this;
    const platform = stage.presenting ? Platform.Vr : this.touch ? Platform.Touch : Platform.Desktop;
    this.ctx.hud.setLocked(stage.input.locked, platform);
  }

  private step(dt: number, visible: boolean): void {
    const { ctx } = this;
    const { rig, input } = this.stage;
    ctx.now = performance.now();

    ctx.world.update(ctx.now);
    this.voice.update();
    this.seat.step(dt);
    this.keeper.update(dt, ctx.now);
    this.proxies.update();
    ctx.physics.step(dt);
    this.builder.afterPhysics(dt);
    if (!visible) return;

    this.views.update(dt);
    this.extraViews.update(dt);
    this.seat.present(dt);
    rig.update(dt);
    ctx.fx.update(dt);
    this.scenery.update(ctx.hud);
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

  private async talk(): Promise<void> {
    const on = await this.voice.toggleTalking();
    const { hud } = this.ctx;
    if (this.voice.error) hud.message(this.voice.error);
    else hud.message(on ? 'Microphone on: builders near you can hear you' : 'Microphone off');
  }

  dispose(): void {
    this.voice.dispose();
    this.menu.dispose();
    this.ctx.world.dispose();
  }
}
