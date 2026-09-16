import { EntityViews, type NetWorld } from '@engine/index';
import type { AvatarIntent } from '../crossplay/intent';
import type { Launch } from '../crossplay/lobby';
import type { Seat } from '../crossplay/role';
import { Shell } from '../crossplay/shell';
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
  land: Land;
  hud: Hud;
  sfx: Sfx;
  launch: Launch<unknown>;
  /** Seconds to shift this peer's time of day by (?hour=). */
  hourOffset: number;
}

export class Game {
  readonly shell: Shell;
  readonly ctx: WildsContext;
  readonly survivor: Survivor;
  /** The local player: the survivor role, and the frontend for whichever platform is playing it. */
  readonly seat: Seat<AvatarIntent, SurvivorFrontend>;
  private readonly views: EntityViews;
  private readonly extraViews: { update(dt: number): void };
  private readonly scenery: Scenery;
  private readonly spawner: Spawner;
  private readonly head = { x: 0, y: 0, z: 0 };

  constructor(deps: GameDeps) {
    const { world, land, hud, sfx, launch, hourOffset } = deps;
    const shell = (this.shell = new Shell({
      world,
      sfx,
      launch,
      players: SurvivorDef,
      company: 'survivors',
      announce: (text) => hud.message(text),
      showLock: (locked, platform) => hud.setLocked(locked, platform),
    }));
    const { rig, scene } = shell.stage;
    this.scenery = new Scenery(land, scene);
    const wall = Date.now() / 1000;
    const ctx: WildsContext = (this.ctx = {
      world,
      land,
      sfx,
      hud,
      settings: shell.settings,
      fx: new Effects(scene, land),
      arrows: undefined as unknown as Arrows,
      me: null,
      playerName: launch.playerName,
      now: performance.now(),
      wall,
      day: dayTime(wall + hourOffset),
    });
    ctx.arrows = new Arrows(ctx);
    const survivor = (this.survivor = new Survivor(ctx));
    this.views = new EntityViews(world);
    this.extraViews = registerViews(ctx, this.views, scene, { showSelf: () => this.seat.frontend.showSelf });
    registerCombat(ctx, survivor);
    trackStumps(ctx);
    this.spawner = new Spawner(ctx);

    world.on('peerJoined', () => hud.message('Another survivor is nearby'));
    survivor.spawn();
    this.seat = shell.seat<AvatarIntent, SurvivorFrontend>(survivor, {
      desktop: (input) => new DesktopSurvivor(ctx, survivor, input, rig, scene),
      vr: (poses) => new VrSurvivor(ctx, survivor, rig, poses, scene),
    });

    hud.show();
    hud.message(`Welcome to the wilds, ${launch.playerName}. Keep fed, and keep a fire going after dark.`);
    hud.message('Press Esc for settings, or V to turn on your microphone: survivors near you will hear your voice');

    shell.run({
      simulate: (dt, now) => {
        ctx.now = now;
        ctx.wall = Date.now() / 1000;
        ctx.day = dayTime(ctx.wall + hourOffset);
        shell.receive(now);
        this.seat.step(dt);
        // integrate long background steps in small slices so movement stays stable
        for (let left = dt; left > 0; left -= 0.05) updateOwnedAnimals(ctx, Math.min(left, 0.05));
        ctx.arrows.update(dt);
        updateOwnedHomestead(ctx);
        this.spawner.update();
      },
      present: (dt) => {
        this.views.update(dt);
        this.extraViews.update(dt);
        hud.tick(ctx.now);
        this.seat.present(dt);
        rig.update(dt);
        ctx.fx.update(dt);
        this.scenery.update(ctx.day, rig.head(this.head));
      },
    });
  }

  dispose(): void {
    this.shell.dispose();
  }
}
