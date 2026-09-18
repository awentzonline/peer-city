import type { SewerContext } from './context';
import { Bank, Crumble, FatChunk, Feed, Goblin, GoblinMode, Hurt, Lord, Loot, LootWhere, Noise, Punch, Revive, Sewer, Snatch, Sound, Splat, SplatKind, Spray, TurnValve } from './defs';
import { punched } from './goblins';
import type { LordRole } from './lord';
import { snatched } from './loot';
import { banked, turned } from './round';

/** What the page does with events everyone sees: ragdolls, gunk and falling fat. Left out headless. */
export interface Show {
  splat(p: { goblin: number; kind: SplatKind; x: number; y: number; z: number; angle: number; vx: number; vy: number; vz: number }): void;
  crumble(ci: number, voxels: Uint8Array): void;
}

/**
 * Wires Sewer Lordz's actions. A change to an entity is made by its owner, the only peer that writes it: a scratch or
 * a helping hand by the Lord's, a punch by the goblin's, a jet by the fat chunk's, a snatch by the loot's (which is its
 * carrier's), and banking and valves by the sewer's. Splats, crumbles and noises are seen and heard by everyone.
 */
export function registerActions(ctx: SewerContext, lord: LordRole | null, show: Show | null): void {
  const { world } = ctx;

  world.onAction(Feed, (p) => ctx.hud.message(p.text));

  world.onCommand(Hurt, Lord, (target, p) => {
    if (target === ctx.me) lord?.hurt(p.amount, p.kx, p.ky);
  });

  world.onCommand(Revive, Lord, (target, p) => {
    if (target === ctx.me) lord?.helpedBy(p.by);
  });

  world.onCommand(Punch, Goblin, (g, p) => punched(ctx, g, p.force, p.dx, p.dy, p.dz));

  world.onCommand(Snatch, Loot, (loot, p) => snatched(ctx, loot, p.by));

  world.onCommand(Spray, FatChunk, (chunk, p) => ctx.plug.sprayed(chunk, { u: p.u, v: p.v, w: p.w }, p.power));

  world.onCommand(Bank, Sewer, (e, p) => banked(ctx, e, p.by, p.kind));

  world.onCommand(TurnValve, Sewer, (e, p) => turned(ctx, e, p.valve, p.amount));

  world.onAction(Splat, (p) => {
    show?.splat(p);
    ctx.sfx.play(p.kind === SplatKind.Gib ? 'gib' : p.kind === SplatKind.Tear ? 'rip' : 'punch', { x: p.x, y: p.y, z: p.z + 0.8 });
  });

  world.onAction(Crumble, (p) => {
    show?.crumble(p.ci, p.voxels);
  });

  world.onAction(Noise, (p) => {
    const at = { x: p.x, y: p.y, z: p.z };
    switch (p.kind) {
      case Sound.Scratch:
        ctx.sfx.play('scratch', at);
        break;
      case Sound.Snatch:
        ctx.sfx.play('cackle', at);
        break;
      case Sound.Dig:
        ctx.sfx.play('dig', at);
        ctx.fx.splash(p.x, p.y, p.z, 0.6);
        break;
      case Sound.Bank:
        ctx.sfx.play('bank', at);
        ctx.fx.sparkle(p.x, p.y, p.z);
        break;
      case Sound.Down:
        ctx.sfx.play('down', at);
        break;
      case Sound.Thump:
        ctx.sfx.play('thump', at, 0.5 + p.a / 200);
        ctx.fx.gunk(p.x, p.y, p.z, 0, 0, 0, 6);
        break;
      case Sound.Grab:
        ctx.sfx.play('squeal', at);
        break;
      case Sound.Escape:
        ctx.sfx.play(p.a ? 'cackle' : 'splash', at);
        ctx.fx.splash(p.x, p.y, p.z, 0.8);
        break;
      case Sound.Breach:
        ctx.sfx.play('breach', at);
        break;
      case Sound.Gush:
        ctx.sfx.play('gush', at);
        break;
    }
  });

  // loot's handed over only while it's lying loose; goblins to whoever grabs them, unless they're already in a hand
  world.setTransferPolicy(Loot, (loot) => loot.state.where !== LootWhere.Carried);
  world.setTransferPolicy(Goblin, (g) => g.state.mode !== GoblinMode.Held && g.state.mode !== GoblinMode.Dead && g.state.mode !== GoblinMode.Gone);
}
