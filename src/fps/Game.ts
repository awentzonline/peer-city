import type * as THREE from 'three';
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
import { AvatarSim, type AvatarFrontend } from './avatar';
import type { City } from './city';
import { buildCity } from './cityMesh';
import { registerCombat } from './combat';
import type { GameContext } from './context';
import { Car, CarMode, Player } from './defs';
import { DesktopAvatar } from './desktopAvatar';
import { Effects } from './effects';
import type { Hud } from './hud';
import type { AvatarIntent } from './intent';
import { MinimapFeed } from './minimap';
import { updateOwnedPeds } from './peds';
import { updateOwnedCops } from './police';
import type { Sfx } from './sfx';
import { Spawner } from './spawner';
import { registerViews } from './views';
import { updateOwnedCars } from './vehicles';
import { VrAvatar } from './vrAvatar';

export interface GameDeps {
  world: NetWorld;
  /** The world's transport, which voice opens its own rooms on (see crossplay/voice.ts). */
  transport: Transport;
  city: City;
  hud: Hud;
  sfx: Sfx;
  playerName: string;
  netLabel: string;
  container: HTMLElement;
  /** Emulate a headset on desktop (?xrsim). */
  sim: boolean;
}

export class Game {
  readonly stage: Stage;
  readonly ctx: GameContext;
  readonly avatar: AvatarSim;
  readonly voice: Voice;
  /** The local player: the avatar role, and the frontend for whichever platform is playing it. */
  readonly seat: Seat<AvatarIntent, AvatarFrontend>;
  private readonly menu: SettingsMenu;
  private readonly simulateXr: boolean;
  private readonly minimap: MinimapFeed;
  private readonly views: EntityViews;
  private readonly spawner: Spawner;
  private readonly debug: NetDebugPanel;
  private readonly sky: THREE.Mesh;
  private readonly vrButton = document.getElementById('vr-enter') as HTMLButtonElement;
  private readonly head = { x: 0, y: 0, z: 0 };

  constructor(deps: GameDeps) {
    const { world, city, hud, sfx } = deps;
    const stage = (this.stage = new Stage(deps.container));
    this.sky = buildCity(city, stage.scene).sky;
    // Voice follows the world's zone rooms, so it reaches the neighbourhood without widening the peer graph.
    this.voice = new Voice({
      transport: deps.transport,
      prefix: `${world.worldId}/voice/`,
      audio: sfx,
      zones: () => world.zoneKeys(),
      speakers: bodySpeakers(world, Player),
    });
    const settings = new Settings({ voice: this.voice, sfx });
    this.ctx = {
      world,
      city,
      sfx,
      hud,
      settings,
      fx: new Effects(stage.scene, stage.rig),
      scene: stage.scene,
      me: null,
      playerName: deps.playerName,
      now: performance.now(),
    };
    this.simulateXr = deps.sim;
    this.avatar = new AvatarSim(this.ctx);
    this.minimap = new MinimapFeed(this.ctx);
    this.views = new EntityViews(world);
    registerViews(this.ctx, this.views, { showSelf: () => this.seat.frontend.showSelf, steer: () => this.avatar.steer });
    registerCombat(this.ctx, this.avatar);
    this.spawner = new Spawner(this.ctx);

    world.setTransferPolicy(Car, (car) => !car.held && car.state.mode !== CarMode.Wrecked);
    world.on('peerJoined', () => hud.message('A player connected nearby'));
    this.avatar.spawn();
    this.seat = new Seat<AvatarIntent, AvatarFrontend>(this.avatar, () => this.frontend());

    this.menu = new SettingsMenu(settings, stage.input);
    this.debug = new NetDebugPanel(world, document.body, deps.netLabel);
    this.debug.visible = new URLSearchParams(location.search).has('debug');

    stage.input.onLockChange = () => this.showLockPrompt();
    this.showLockPrompt();
    hud.show();
    hud.message(`Welcome to Peer City 3D, ${deps.playerName}`);
    hud.message('Press Esc for settings, or V to turn on your microphone: players near you will hear your voice');

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
  private frontend(): AvatarFrontend {
    const { ctx, avatar, minimap, stage } = this;
    const { rig, input } = stage;
    if (stage.presenting) return new VrAvatar(ctx, avatar, rig, new WebXrPoses(stage.renderer.xr), minimap);
    if (this.simulateXr) return new VrAvatar(ctx, avatar, rig, new SimulatedXr(input), minimap);
    return new DesktopAvatar(ctx, avatar, input, rig, minimap);
  }

  /** The page's "click to play" prompt and crosshair, which a headset can't see. */
  private showLockPrompt(): void {
    this.ctx.hud.setLocked(this.stage.input.locked, this.stage.presenting);
  }

  private step(dt: number, visible: boolean): void {
    const { ctx } = this;
    const { rig, input } = this.stage;
    ctx.now = performance.now();

    ctx.world.update(ctx.now);
    this.voice.update();
    this.seat.step(dt);
    // integrate long background steps in small slices so physics stays stable
    for (let left = dt; left > 0; left -= 0.05) {
      const slice = Math.min(left, 0.05);
      updateOwnedCars(ctx, slice);
      updateOwnedPeds(ctx, slice);
      updateOwnedCops(ctx, slice);
    }
    this.spawner.update();
    if (!visible) return;

    this.views.update(dt);
    ctx.hud.tick(ctx.now);
    this.minimap.update();
    this.seat.present(dt);
    rig.update(dt);
    ctx.fx.update(dt);
    const head = rig.head(this.head);
    this.sky.position.set(head.x, 0, head.y);
    this.menu.update(ctx.now);
    this.debug.update(ctx.now);

    // global keys, whatever the platform
    if (input.pressed('Backquote')) this.debug.visible = !this.debug.visible;
    if (input.pressed('KeyN')) {
      ctx.sfx.muted = !ctx.sfx.muted;
      ctx.hud.message(ctx.sfx.muted ? 'Sound off' : 'Sound on');
    }
    // The headset has its own settings panel and its own way in (see vrAvatar.ts); these keys are the desktop's.
    if (this.seat.frontend.platform !== Platform.Desktop) return;
    if (input.pressed('Escape')) this.menu.toggle();
    // Behind the wheel V is the car camera, so the microphone key is for when you're on foot.
    if (input.pressed('KeyV') && !this.avatar.driving) void this.talk();
  }

  /** Open or close the microphone, and say what happened: it asks the browser the first time. */
  private async talk(): Promise<void> {
    const on = await this.voice.toggleTalking();
    const { hud } = this.ctx;
    if (this.voice.error) hud.message(this.voice.error);
    else hud.message(on ? 'Microphone on: players near you can hear you' : 'Microphone off');
  }

  dispose(): void {
    this.voice.dispose();
    this.menu.dispose();
    this.ctx.world.dispose();
  }
}
