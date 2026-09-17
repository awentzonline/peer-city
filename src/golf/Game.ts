import { EntityViews, type NetWorld } from '@engine/index';
import type { Launch } from '../crossplay/lobby';
import type { Seat } from '../crossplay/role';
import { Shell } from '../crossplay/shell';
import { registerActions } from './actions';
import { CartWorld } from './carts';
import type { GolfContext } from './context';
import type { Course } from './course';
import { Golfer as GolferDef } from './defs';
import { DesktopGolfer } from './desktop';
import { Effects } from './effects';
import { stepRules, type GolfRules } from './frame';
import { Golfer, type GolferFrontend } from './golfer';
import type { Hud } from './hud';
import type { GolfIntent } from './intent';
import { MatchKeeper } from './match';
import { Scenery } from './scenery';
import type { Sfx } from './sfx';
import { TouchGolfer } from './touch';
import { registerViews } from './views';
import { VrGolfer } from './vr';

export interface GameDeps {
  world: NetWorld;
  course: Course;
  hud: Hud;
  sfx: Sfx;
  launch: Launch<unknown>;
}

export class Game {
  readonly shell: Shell;
  readonly ctx: GolfContext;
  readonly golfer: Golfer;
  /** The local player: the golfer role, and the frontend for whichever platform is playing it. */
  readonly seat: Seat<GolfIntent, GolferFrontend>;
  private readonly keeper: MatchKeeper;
  private readonly rules: GolfRules;
  private readonly views: EntityViews;
  private readonly extraViews: { update(dt: number): void };
  private readonly scenery: Scenery;

  constructor(deps: GameDeps) {
    const { world, course, hud, sfx, launch } = deps;
    const shell = (this.shell = new Shell({
      world,
      sfx,
      launch,
      players: GolferDef,
      company: 'golfers',
      announce: (text) => hud.message(text),
      showLock: (locked, platform) => hud.setLocked(locked, platform),
    }));
    const { rig, scene } = shell.stage;
    this.scenery = new Scenery(course, scene);
    hud.setMap(this.scenery.map);
    this.keeper = new MatchKeeper(world, course);
    const ctx: GolfContext = (this.ctx = {
      world,
      course,
      carts: new CartWorld(world, course),
      sfx,
      hud,
      settings: shell.settings,
      fx: new Effects(scene, course),
      me: null,
      ball: null,
      match: () => this.keeper.match,
      playerName: launch.playerName,
      now: performance.now(),
    });
    const golfer = (this.golfer = new Golfer(ctx));
    this.rules = { golfer, keeper: this.keeper };
    registerActions(ctx, golfer);
    this.views = new EntityViews(world);
    this.extraViews = registerViews(ctx, this.views, scene, rig, { showSelf: () => this.seat.frontend.showSelf, showDriver: () => this.seat.frontend.showDriver }, golfer);

    world.on('peerJoined', () => hud.message('Another golfer arrived'));
    golfer.spawn();
    this.seat = shell.seat<GolfIntent, GolferFrontend>(golfer, {
      desktop: (input) => new DesktopGolfer(ctx, golfer, input, rig),
      vr: (poses) => new VrGolfer(ctx, golfer, rig, poses),
      touch: (chips) => new TouchGolfer(ctx, golfer, rig, chips),
    });

    hud.show();
    hud.message(`Welcome to the club, ${launch.playerName}! Everyone plays the same hole at once.`);
    hud.message('Carts are at the barn by the clubhouse. There are never enough.');

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
        this.scenery.update(hud, dt);
      },
    });
  }

  dispose(): void {
    this.shell.dispose();
    this.ctx.carts.dispose();
  }
}
