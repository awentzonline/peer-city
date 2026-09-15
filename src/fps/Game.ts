import type * as THREE from 'three';
import { EntityViews, NetDebugPanel, type NetWorld } from '@engine/index';
import type { DesktopInput } from '../crossplay/input';
import { WebXrPoses } from '../crossplay/rig';
import { Seat } from '../crossplay/role';
import { Stage, errorText } from '../crossplay/stage';
import { SimulatedXr } from '../crossplay/xrsim';
import { AvatarSim, type AvatarFrontend } from './avatar';
import type { City } from './city';
import { buildCity } from './cityMesh';
import { registerCombat } from './combat';
import type { GameContext } from './context';
import { Car, CarMode } from './defs';
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
  /** The local player: the avatar role, and the frontend for whichever platform is playing it. */
  readonly seat: Seat<AvatarIntent, AvatarFrontend>;
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
    this.ctx = {
      world,
      city,
      sfx,
      hud,
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

    this.debug = new NetDebugPanel(world, document.body, deps.netLabel);
    this.debug.visible = new URLSearchParams(location.search).has('debug');

    stage.input.onLockChange = () => this.showLockPrompt();
    this.showLockPrompt();
    hud.show();
    hud.message(`Welcome to Peer City 3D, ${deps.playerName}`);

    void Stage.vrSupported().then((ok) => (this.vrButton.hidden = !ok));
    this.vrButton.addEventListener('click', () => {
      stage.enterVR().catch((err: unknown) => hud.message(`Couldn't start VR: ${errorText(err)}`));
    });

    stage.run({
      step: (dt, visible) => this.step(dt, visible),
      platformChanged: (presenting) => {
        this.vrButton.hidden = presenting;
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
    this.debug.update(ctx.now);

    // global keys, whatever the platform
    if (input.pressed('Backquote')) this.debug.visible = !this.debug.visible;
    if (input.pressed('KeyN')) {
      ctx.sfx.muted = !ctx.sfx.muted;
      ctx.hud.message(ctx.sfx.muted ? 'Sound off' : 'Sound on');
    }
  }
}
