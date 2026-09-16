import { EntityViews, NetDebugPanel, type NetWorld } from '@engine/index';
import type { Transport } from '@engine/transport/types';
import type { AvatarIntent } from '../crossplay/intent';
import type { DesktopInput } from '../crossplay/input';
import { Platform } from '../crossplay/platform';
import { WebXrPoses } from '../crossplay/rig';
import { Seat } from '../crossplay/role';
import { Settings } from '../crossplay/settings';
import { SettingsMenu } from '../crossplay/settingsMenu';
import { Stage, errorText } from '../crossplay/stage';
import { Voice, bodySpeakers } from '../crossplay/voice';
import { SimulatedXr } from '../crossplay/xrsim';
import { updateOwnedAnimals } from './animals';
import { Arrows } from './arrows';
import { dayTime } from './clock';
import { registerCombat } from './combat';
import type { WildsContext } from './context';
import { DesktopSurvivor } from './desktop';
import { Effects } from './effects';
import { trackStumps, updateOwnedHomestead } from './homestead';
import { Survivor as SurvivorDef } from './defs';
import type { Hud } from './hud';
import type { Land } from './land';
import { Scenery } from './scenery';
import type { Sfx } from './sfx';
import { Spawner } from './spawner';
import { Survivor, type SurvivorFrontend } from './survivor';
import { registerViews } from './views';
import { VrSurvivor } from './vr';

export interface GameDeps {
  world: NetWorld;
  /** The world's transport, which voice opens its own rooms on (see crossplay/voice.ts). */
  transport: Transport;
  land: Land;
  hud: Hud;
  sfx: Sfx;
  playerName: string;
  netLabel: string;
  container: HTMLElement;
  /** Emulate a headset on desktop (?xrsim). */
  sim: boolean;
  /** Seconds to shift this peer's time of day by (?hour=). */
  hourOffset: number;
}

export class Game {
  readonly stage: Stage;
  readonly ctx: WildsContext;
  readonly survivor: Survivor;
  readonly voice: Voice;
  /** The local player: the survivor role, and the frontend for whichever platform is playing it. */
  readonly seat: Seat<AvatarIntent, SurvivorFrontend>;
  private readonly menu: SettingsMenu;
  private readonly views: EntityViews;
  private readonly extraViews: { update(dt: number): void };
  private readonly scenery: Scenery;
  private readonly spawner: Spawner;
  private readonly debug: NetDebugPanel;
  private readonly hourOffset: number;
  private readonly simulateXr: boolean;
  private readonly vrButton = document.getElementById('vr-enter') as HTMLButtonElement;
  private readonly head = { x: 0, y: 0, z: 0 };

  constructor(deps: GameDeps) {
    const { world, land, hud, sfx } = deps;
    const stage = (this.stage = new Stage(deps.container));
    this.hourOffset = deps.hourOffset;
    this.simulateXr = deps.sim;
    this.scenery = new Scenery(land, stage.scene);
    const wall = Date.now() / 1000;
    // Voice follows the world's zone rooms, so it reaches the neighbourhood without widening the peer graph.
    this.voice = new Voice({
      transport: deps.transport,
      prefix: `${world.worldId}/voice/`,
      audio: sfx,
      zones: () => world.zoneKeys(),
      speakers: bodySpeakers(world, SurvivorDef),
    });
    const settings = new Settings({ voice: this.voice, sfx });
    this.ctx = {
      world,
      land,
      sfx,
      hud,
      settings,
      fx: new Effects(stage.scene, land),
      arrows: undefined as unknown as Arrows,
      me: null,
      playerName: deps.playerName,
      now: performance.now(),
      wall,
      day: dayTime(wall + this.hourOffset),
    };
    this.ctx.arrows = new Arrows(this.ctx);
    this.survivor = new Survivor(this.ctx);
    this.views = new EntityViews(world);
    this.extraViews = registerViews(this.ctx, this.views, stage.scene, { showSelf: () => this.seat.frontend.showSelf });
    registerCombat(this.ctx, this.survivor);
    trackStumps(this.ctx);
    this.spawner = new Spawner(this.ctx);

    world.on('peerJoined', () => hud.message('Another survivor is nearby'));
    this.survivor.spawn();
    this.seat = new Seat<AvatarIntent, SurvivorFrontend>(this.survivor, () => this.frontend());

    this.menu = new SettingsMenu(settings, stage.input);
    this.debug = new NetDebugPanel(world, document.body, deps.netLabel);
    this.debug.visible = new URLSearchParams(location.search).has('debug');

    stage.input.onLockChange = () => this.showLockPrompt();
    this.showLockPrompt();
    hud.show();
    hud.message(`Welcome to the wilds, ${deps.playerName}. Keep fed, and keep a fire going after dark.`);
    hud.message('Press Esc for settings, or V to turn on your microphone: survivors near you will hear your voice');

    void Stage.vrSupported().then((ok) => (this.vrButton.hidden = !ok));
    this.vrButton.addEventListener('click', () => {
      stage.enterVR().catch((err: unknown) => hud.message(`Couldn't start VR: ${errorText(err)}`));
    });

    stage.run({
      step: (dt, visible) => this.step(dt, visible),
      platformChanged: (presenting) => {
        this.vrButton.hidden = presenting;
        // The menu belongs to whichever frontend is playing; the next one opens its own.
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
  private frontend(): SurvivorFrontend {
    const { ctx, survivor, stage } = this;
    const { rig, input, scene } = stage;
    if (stage.presenting) return new VrSurvivor(ctx, survivor, rig, new WebXrPoses(stage.renderer.xr), scene);
    if (this.simulateXr) return new VrSurvivor(ctx, survivor, rig, new SimulatedXr(input), scene);
    return new DesktopSurvivor(ctx, survivor, input, rig, scene);
  }

  private showLockPrompt(): void {
    this.ctx.hud.setLocked(this.stage.input.locked, this.stage.presenting);
  }

  private step(dt: number, visible: boolean): void {
    const { ctx } = this;
    const { rig, input } = this.stage;
    ctx.now = performance.now();
    ctx.wall = Date.now() / 1000;
    ctx.day = dayTime(ctx.wall + this.hourOffset);

    ctx.world.update(ctx.now);
    this.voice.update();
    this.seat.step(dt);
    // integrate long background steps in small slices so movement stays stable
    for (let left = dt; left > 0; left -= 0.05) updateOwnedAnimals(ctx, Math.min(left, 0.05));
    ctx.arrows.update(dt);
    updateOwnedHomestead(ctx);
    this.spawner.update();
    if (!visible) return;

    this.views.update(dt);
    this.extraViews.update(dt);
    ctx.hud.tick(ctx.now);
    this.seat.present(dt);
    rig.update(dt);
    ctx.fx.update(dt);
    this.scenery.update(ctx.day, rig.head(this.head));
    this.menu.update(ctx.now);
    this.debug.update(ctx.now);

    // global keys, whatever the platform
    if (input.pressed('Backquote')) this.debug.visible = !this.debug.visible;
    if (input.pressed('KeyN')) {
      ctx.sfx.muted = !ctx.sfx.muted;
      ctx.hud.message(ctx.sfx.muted ? 'Sound off' : 'Sound on');
    }
    // The headset has its own settings panel and its own way in (see vr.ts); these keys are the desktop's.
    if (this.seat.frontend.platform !== Platform.Desktop) return;
    if (input.pressed('Escape')) this.menu.toggle();
    if (input.pressed('KeyV')) void this.talk();
  }

  /** Open or close the microphone, and say what happened: it asks the browser the first time. */
  private async talk(): Promise<void> {
    const on = await this.voice.toggleTalking();
    const { hud } = this.ctx;
    if (this.voice.error) hud.message(this.voice.error);
    else hud.message(on ? 'Microphone on: survivors near you can hear you' : 'Microphone off');
  }

  dispose(): void {
    this.voice.dispose();
    this.menu.dispose();
    this.ctx.world.dispose();
  }
}
