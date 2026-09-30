import { EntityViews, type NetWorld } from '@engine/index';
import type { Launch } from '../crossplay/lobby';
import type { Seat } from '../crossplay/role';
import { heading, type SettingsRow } from '../crossplay/settings';
import { Shell } from '../crossplay/shell';
import { registerActions } from './actions';
import { TeamKeeper } from './buddies';
import type { HiContext } from './context';
import { Pal } from './defs';
import { DesktopPal } from './desktop';
import { Effects } from './effects';
import { Grounds } from './field';
import { stepRules } from './frame';
import type { Hud } from './hud';
import type { PalIntent } from './intent';
import { Pairs } from './moves';
import { PalRole, type PalFrontend } from './pal';
import { Scenery } from './scenery';
import type { Sfx } from './sfx';
import { TouchPal } from './touch';
import { registerViews } from './views';
import { VrPal } from './vr';

/** Where this browser remembers that its player would rather not be slapped. */
const NO_SLAPS_KEY = 'high-five-no-slaps';

export interface GameDeps {
  world: NetWorld;
  hud: Hud;
  sfx: Sfx;
  launch: Launch<unknown>;
}

export class Game {
  readonly shell: Shell;
  readonly ctx: HiContext;
  readonly role: PalRole;
  readonly seat: Seat<PalIntent, PalFrontend>;
  private readonly keeper: TeamKeeper;
  private readonly views: EntityViews;

  constructor(deps: GameDeps) {
    const { world, hud, sfx, launch } = deps;
    const shell = (this.shell = new Shell({
      world,
      sfx,
      launch,
      players: Pal,
      company: 'pals',
      announce: (text) => hud.message(text),
      showLock: (locked, platform) => hud.setLocked(locked, platform),
    }));
    const { rig, scene } = shell.stage;
    const scenery = new Scenery(scene);
    const ctx: HiContext = (this.ctx = {
      world,
      grounds: new Grounds(),
      pairs: new Pairs(),
      sfx,
      hud,
      settings: shell.settings,
      fx: new Effects(scene),
      me: null,
      playerName: launch.playerName,
      now: performance.now(),
    });
    this.keeper = new TeamKeeper(ctx);
    const role = (this.role = new PalRole(ctx));
    role.noSlaps = load(NO_SLAPS_KEY) === '1';
    shell.settings.game = () => slapRows(role);
    this.views = new EntityViews(world);
    const extra = registerViews(ctx, this.views, scene, { showSelf: () => this.seat.frontend.showSelf }, scenery, role);
    registerActions(ctx, role, extra.shows);

    world.on('entityAdded', (e) => {
      if (e.def !== Pal || e.mine) return;
      setTimeout(() => {
        const name = world.getAs(Pal, e.id)?.state.name;
        if (name) hud.message(`${name} is here. Up high!`);
      }, 1500);
      sfx.play('join');
    });
    role.spawn();
    this.seat = shell.seat<PalIntent, PalFrontend>(role, {
      desktop: (input) => new DesktopPal(ctx, role, input, rig),
      vr: (poses) => new VrPal(ctx, role, rig, poses),
      touch: (chips) => new TouchPal(ctx, role, rig, chips),
    });

    hud.show();
    hud.message(`Welcome to the locker room, ${launch.playerName}!`);
    hud.message('Give everyone five. Mix up your moves to keep a combo going, and watch your back.');

    shell.run({
      simulate: (dt, now) => {
        ctx.now = now;
        shell.receive(now);
        this.seat.step(dt);
        stepRules(ctx, this.keeper, dt, now);
      },
      present: (dt, now) => {
        hud.tick(now);
        this.views.update(dt);
        extra.update(dt);
        this.seat.present(dt);
        rig.update(dt);
        scenery.update(world, ctx.me?.id ?? 0, now);
      },
    });
  }

  dispose(): void {
    this.shell.dispose();
  }
}

/** The settings menu's say on butt slaps: on for everyone unless you'd rather not. */
function slapRows(role: PalRole): SettingsRow[] {
  return [
    heading('Butt slaps'),
    {
      id: 'hifive:slaps',
      kind: 'toggle',
      label: 'Butt slaps',
      detail: role.noSlaps ? "Off: nobody can slap yours, and you can't slap anyone's" : 'On: creep up and slap, and watch your own back',
      on: !role.noSlaps,
      level: -1,
      toggle: () => {
        role.noSlaps = !role.noSlaps;
        save(NO_SLAPS_KEY, role.noSlaps ? '1' : '0');
      },
    },
  ];
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: it lasts this visit */
  }
}
