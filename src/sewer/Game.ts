import * as THREE from 'three';
import { EntityViews, type NetWorld } from '@engine/index';
import type { Launch } from '../crossplay/lobby';
import type { Seat } from '../crossplay/role';
import { Shell } from '../crossplay/shell';
import { registerActions } from './actions';
import { waterLevel, type SewerContext, type Vec3 } from './context';
import { Lord, VALVE_FIELDS } from './defs';
import { DesktopLord } from './desktop';
import { Effects } from './effects';
import { VOX } from './fatberg';
import { FatView } from './fatView';
import { stepRules } from './frame';
import type { DiveNews, Hud } from './hud';
import type { LordIntent } from './intent';
import { LordRole, type LordFrontend } from './lord';
import { Plug } from './plug';
import { Ragdolls } from './ragdoll';
import { DiveKeeper } from './round';
import { Scenery } from './scenery';
import { Paths, type SewerMap } from './sewer';
import type { Sfx } from './sfx';
import { TouchLord } from './touch';
import { registerViews } from './views';
import { VrLord } from './vr';
import { Sewage } from './water';

/** A Lord's frontend, which also says where its hose's nozzle is seen. */
export type SewerFrontend = LordFrontend & { nozzle(out: Vec3): Vec3 | null };

export interface GameDeps {
  world: NetWorld;
  map: SewerMap;
  hud: Hud;
  sfx: Sfx;
  launch: Launch<unknown>;
}

const camPos = new THREE.Vector3();
const camDir = new THREE.Vector3();

export class Game {
  readonly shell: Shell;
  readonly ctx: SewerContext;
  readonly lord: LordRole;
  readonly seat: Seat<LordIntent, SewerFrontend>;
  private readonly keeper: DiveKeeper;
  private readonly views: EntityViews;

  constructor(deps: GameDeps) {
    const { world, map, hud, sfx, launch } = deps;
    const shell = (this.shell = new Shell({
      world,
      sfx,
      launch,
      players: Lord,
      announce: (text) => hud.message(text),
      showLock: (locked, platform) => hud.setLocked(locked, platform),
    }));
    const { rig, scene } = shell.stage;
    const scenery = new Scenery(map, scene);
    const sewage = new Sewage(scene, map);
    const plug = new Plug(map);
    const fat = new FatView(scene, plug);
    const ragdolls = new Ragdolls(scene, map);
    let keeper: DiveKeeper | null = null;
    const ctx: SewerContext = (this.ctx = {
      world,
      map,
      paths: new Paths(map),
      plug,
      sfx,
      hud,
      settings: shell.settings,
      fx: new Effects(scene),
      me: null,
      sewer: () => keeper?.sewer ?? null,
      playerName: launch.playerName,
      now: performance.now(),
    });
    keeper = this.keeper = new DiveKeeper(ctx);
    this.views = new EntityViews(world);
    const lord = (this.lord = new LordRole(ctx));
    const extra = registerViews(ctx, this.views, scene, rig, { showSelf: () => this.seat.frontend.showSelf, nozzle: (out) => this.seat.frontend.nozzle(out) }, ragdolls);
    registerActions(ctx, lord, {
      splat: (p) => extra.splat(p),
      crumble: (_ci, voxels) => {
        const centres: Vec3[] = [];
        for (let k = 0; k + 2 < voxels.length; k += 3) centres.push(plug.frame.toWorld(voxels[k], voxels[k + 1], voxels[k + 2]));
        if (!centres.length) return;
        ragdolls.lumps(centres);
        const c = centres[0];
        sfx.play('crumble', c);
        ctx.fx.splash(c.x, c.y, waterLevel(ctx), Math.min(2, centres.length * VOX));
      },
    });
    lord.spawn();
    this.seat = shell.seat<LordIntent, SewerFrontend>(lord, {
      desktop: (input) => new DesktopLord(ctx, lord, input, rig),
      vr: (poses) => new VrLord(ctx, lord, rig, poses),
      touch: (chips) => new TouchLord(ctx, lord, rig, chips),
    });

    // your hard hat's lamp: wherever you look, in a headset too
    const lamp = new THREE.SpotLight(0xfff2d8, 14, 24, 0.62, 0.6, 1.6);
    lamp.position.set(0, 0.08, 0);
    lamp.target.position.set(0, 0, -1);
    const fill = new THREE.PointLight(0xfff0d0, 1.2, 5, 1.8);
    rig.camera.add(lamp, lamp.target, fill);

    hud.message(`Welcome to the sewers, ${launch.playerName}. Mind your step.`);
    hud.message('Dig up the loot, blast through the fatberg to the vault, and get it all back to the ladder.');
    world.on('peerJoined', () => hud.message('Another Lord has come down the ladder'));

    hud.show();
    shell.run({
      simulate: (dt, now) => {
        ctx.now = now;
        shell.receive(now);
        this.seat.step(dt);
        stepRules(ctx, this.keeper, dt, now);
      },
      present: (dt, now) => {
        hud.tick(now);
        this.news(hud.dive(ctx));
        this.views.update(dt);
        extra.update(dt);
        this.seat.present(dt);
        rig.update(dt);
        ctx.fx.update(dt);
        ragdolls.update(dt);
        fat.update(now);
        rig.camera.getWorldPosition(camPos);
        rig.camera.getWorldDirection(camDir);
        const e = ctx.sewer()?.render;
        sewage.update(dt, waterLevel(ctx), !!e?.surge, camPos, camDir);
        scenery.update(dt, e ? VALVE_FIELDS.map((f) => e[f]) : [0, 0, 0, 0], sfx.listenerAt, ctx.fx, sfx);
      },
    });
  }

  /** Make a fuss about how the dive's going. */
  private news(news: DiveNews): void {
    const { hud, sfx } = this.ctx;
    switch (news) {
      case 'dive':
        sfx.play('dive');
        hud.showBanner('DOWN WE GO', '#c8e05a', 2500);
        break;
      case 'surge':
        sfx.play('surge');
        hud.showBanner('SURGE!', '#e0c04a', 2500);
        break;
      case 'breach':
        hud.showBanner('THE FATBERG’S BREACHED', '#ffd35a', 3000);
        break;
      case 'rich':
        sfx.play('rich');
        hud.showBanner(`OUT WITH £${this.ctx.sewer()?.render.worth ?? 0}`, '#ffd35a', 4000);
        break;
      case 'lost':
        sfx.play('lost');
        hud.showBanner('THE SEWER KEEPS IT ALL', '#b04a4a', 4000);
        break;
    }
  }

  dispose(): void {
    this.shell.dispose();
  }
}
