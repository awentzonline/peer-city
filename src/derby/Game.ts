import { EntityViews, type NetWorld } from '@engine/index';
import type { Launch } from '../crossplay/lobby';
import type { Seat } from '../crossplay/role';
import { Shell } from '../crossplay/shell';
import { registerActions } from './actions';
import { Builder, type BuilderFrontend } from './builder';
import type { DerbyContext } from './context';
import type { Course } from './course';
import { Builder as BuilderDef } from './defs';
import { DesktopBuilder } from './desktop';
import { Effects } from './effects';
import { stepRules, type DerbyRules } from './frame';
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
  course: Course;
  hud: Hud;
  sfx: Sfx;
  launch: Launch<unknown>;
}

export class Game {
  readonly shell: Shell;
  readonly ctx: DerbyContext;
  readonly builder: Builder;
  /** The local player: the builder role, and the frontend for whichever platform is playing it. */
  readonly seat: Seat<DerbyIntent, BuilderFrontend>;
  private readonly keeper: RaceKeeper;
  private readonly rules: DerbyRules;
  private readonly views: EntityViews;
  private readonly extraViews: { update(dt: number): void };
  private readonly scenery: Scenery;

  constructor(deps: GameDeps) {
    const { world, course, hud, sfx, launch } = deps;
    const shell = (this.shell = new Shell({
      world,
      sfx,
      launch,
      players: BuilderDef,
      company: 'builders',
      announce: (text) => hud.message(text),
      showLock: (locked, platform) => hud.setLocked(locked, platform),
    }));
    const { rig, scene } = shell.stage;
    this.scenery = new Scenery(course, scene);
    this.keeper = new RaceKeeper(world);
    const ctx: DerbyContext = (this.ctx = {
      world,
      course,
      physics: new Physics(course),
      sfx,
      hud,
      settings: shell.settings,
      shelf: new LocalShelf(),
      fx: new Effects(scene, course),
      me: null,
      racer: null,
      race: () => this.keeper.race,
      playerName: launch.playerName,
      now: performance.now(),
    });
    const builder = (this.builder = new Builder(ctx));
    this.rules = { builder, keeper: this.keeper, proxies: new RacerProxies(ctx) };
    registerActions(ctx, builder);
    this.views = new EntityViews(world);
    this.extraViews = registerViews(
      ctx,
      this.views,
      scene,
      { showSelf: () => this.seat.frontend.showSelf, showDriver: () => this.seat.frontend.showDriver },
      builder,
    );

    world.on('peerJoined', () => hud.message('Another builder arrived'));
    builder.spawn();
    this.seat = shell.seat<DerbyIntent, BuilderFrontend>(builder, {
      desktop: (input) => new DesktopBuilder(ctx, builder, input, rig),
      vr: (poses) => new VrBuilder(ctx, builder, rig, poses),
      touch: (chips) => new TouchBuilder(ctx, builder, rig, chips),
    });

    hud.show();
    hud.message(`Welcome to the derby, ${launch.playerName}! Your racer is in bay ${(ctx.racer?.state.bay ?? 0) + 1}.`);
    if (!launch.touch) hud.message('Point at a racer and click to stick parts on.');
    hud.message("Anyone can help build anyone else's racer.");

    shell.run({
      simulate: (dt, now) => {
        ctx.now = now;
        shell.receive(now);
        this.seat.step(dt);
        stepRules(ctx, this.rules, dt, now);
      },
      present: (dt, now) => {
        hud.tick(now);
        this.views.update(dt);
        this.extraViews.update(dt);
        this.seat.present(dt);
        rig.update(dt);
        ctx.fx.update(dt);
        this.scenery.update(hud);
      },
    });
  }

  dispose(): void {
    this.shell.dispose();
  }
}
