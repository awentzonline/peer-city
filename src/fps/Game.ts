import type * as THREE from 'three';
import { EntityViews, type NetWorld } from '@engine/index';
import type { Launch } from '../crossplay/lobby';
import type { Seat } from '../crossplay/role';
import { Shell } from '../crossplay/shell';
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
import { TouchAvatar } from './touchAvatar';
import { registerViews } from './views';
import { updateOwnedCars } from './vehicles';
import { VrAvatar } from './vrAvatar';

export interface GameDeps {
  world: NetWorld;
  city: City;
  hud: Hud;
  sfx: Sfx;
  launch: Launch<unknown>;
}

export class Game {
  readonly shell: Shell;
  readonly ctx: GameContext;
  readonly avatar: AvatarSim;
  /** The local player: the avatar role, and the frontend for whichever platform is playing it. */
  readonly seat: Seat<AvatarIntent, AvatarFrontend>;
  private readonly minimap: MinimapFeed;
  private readonly views: EntityViews;
  private readonly spawner: Spawner;
  private readonly sky: THREE.Mesh;
  private readonly head = { x: 0, y: 0, z: 0 };

  constructor(deps: GameDeps) {
    const { world, city, hud, sfx, launch } = deps;
    const shell = (this.shell = new Shell({
      world,
      sfx,
      launch,
      players: Player,
      announce: (text) => hud.message(text),
      showLock: (locked, platform) => hud.setLocked(locked, platform),
      // Behind the wheel V is the car camera, so the microphone key is for when you're on foot.
      talkKey: () => !this.avatar.driving,
    }));
    const { rig, scene } = shell.stage;
    this.sky = buildCity(city, scene).sky;
    const ctx: GameContext = (this.ctx = {
      world,
      city,
      sfx,
      hud,
      settings: shell.settings,
      fx: new Effects(scene, rig),
      scene,
      me: null,
      playerName: launch.playerName,
      now: performance.now(),
    });
    const avatar = (this.avatar = new AvatarSim(ctx));
    const minimap = (this.minimap = new MinimapFeed(ctx));
    this.views = new EntityViews(world);
    registerViews(ctx, this.views, { showSelf: () => this.seat.frontend.showSelf, steer: () => avatar.steer });
    registerCombat(ctx, avatar);
    this.spawner = new Spawner(ctx);

    world.setTransferPolicy(Car, (car) => !car.held && car.state.mode !== CarMode.Wrecked);
    world.on('peerJoined', () => hud.message('A player connected nearby'));
    avatar.spawn();
    this.seat = shell.seat<AvatarIntent, AvatarFrontend>(avatar, {
      desktop: (input) => new DesktopAvatar(ctx, avatar, input, rig, minimap),
      vr: (poses) => new VrAvatar(ctx, avatar, rig, poses, minimap),
      touch: (chips) => new TouchAvatar(ctx, avatar, rig, minimap, chips),
    });

    hud.show();
    hud.message(`Welcome to Peer City 3D, ${launch.playerName}`);
    hud.message(
      launch.touch
        ? 'The cog opens settings; the microphone lets players near you hear your voice'
        : 'Press Esc for settings, or V to turn on your microphone: players near you will hear your voice',
    );

    shell.run({
      simulate: (dt, now) => {
        ctx.now = now;
        shell.receive(now);
        this.seat.step(dt);
        // integrate long background steps in small slices so physics stays stable
        for (let left = dt; left > 0; left -= 0.05) {
          const slice = Math.min(left, 0.05);
          updateOwnedCars(ctx, slice);
          updateOwnedPeds(ctx, slice);
          updateOwnedCops(ctx, slice);
        }
        this.spawner.update();
      },
      present: (dt) => {
        this.views.update(dt);
        hud.tick(ctx.now);
        this.minimap.update();
        this.seat.present(dt);
        rig.update(dt);
        ctx.fx.update(dt);
        const head = rig.head(this.head);
        this.sky.position.set(head.x, 0, head.y);
      },
    });
  }

  dispose(): void {
    this.shell.dispose();
  }
}
