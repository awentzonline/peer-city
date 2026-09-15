import { weaponSpec } from './arsenal';
import { direction, signedAngle, type GameContext } from './context';
import { Busted, Car, CarKind, CarMode, Damage, DamageCause, Explosion, Feed, Horn, Kill, Ped, PedMode, Pickup, PickupKind, Player, Shot } from './defs';
import { PED_RADIUS, moveCircle, panicPeds } from './peds';
import type { PlayerController } from './player';
import { wreckCar } from './vehicles';

const VICTIM_PED = 0;
const VICTIM_PLAYER = 1;
const VICTIM_COP = 2;

/**
 * Wires gameplay actions. Damage is always applied by the victim's owner, the
 * only peer allowed to write its state; everyone else just renders effects.
 */
export function registerCombat(ctx: GameContext, player: PlayerController): void {
  const { world } = ctx;
  const dir = { x: 0, y: 0, z: 0 };

  world.onAction(Shot, (p) => {
    // police remember who has been shooting (see police.ts)
    const shooter = world.getAs(Player, p.shooter);
    if (shooter) shooter.local.lastShot = ctx.now;
    direction(p.yaw, signedAngle(p.pitch), dir);
    ctx.fx.tracer(p.x, p.y, p.z, p.x + dir.x * p.dist, p.y + dir.y * p.dist, p.z + dir.z * p.dist, p.impact);
    if (p.quiet) return;
    ctx.fx.muzzle(p.x, p.y, p.z);
    ctx.sfx.play(weaponSpec(p.weapon).sound, p);
    panicPeds(ctx, p.x, p.y, 40);
  });

  world.onAction(Explosion, (p) => {
    ctx.fx.explosion(p.x, p.y);
    ctx.sfx.play('boom', { x: p.x, y: p.y, z: 1 });
    panicPeds(ctx, p.x, p.y, 65);
  });

  world.onAction(Horn, (p) => {
    const car = world.get(p.car);
    if (car) ctx.sfx.play('horn', { x: car.x, y: car.y, z: 1 });
  });

  world.onAction(Feed, (p) => ctx.hud.message(p.text));

  world.onAction(Busted, (p) => {
    if (ctx.me && p.target === ctx.me.id) player.busted(world.getAs(Ped, p.cop));
  });

  world.onAction(Kill, (p) => {
    const attacker = world.getAs(Player, p.attacker);
    if (!attacker?.mine) return;
    attacker.state.kills++;
    if (p.victimKind === VICTIM_PED) {
      player.crime(1);
    } else if (p.victimKind === VICTIM_COP) {
      player.crime(2);
    } else {
      player.crime(1);
      attacker.state.cash += 100;
    }
  });

  world.onAction(Damage, (p) => {
    const target = world.get(p.target);
    if (!target || !target.mine) return;
    const credit = (victimKind: number) => {
      const attacker = world.get(p.attacker);
      if (attacker) world.send(Kill, { attacker: p.attacker, victimKind, x: target.x, y: target.y }, { to: 'owner', entity: attacker });
    };

    if (target.is(Ped)) {
      const s = target.state;
      if (s.mode === PedMode.Dead) return;
      s.hp = Math.max(0, s.hp - p.amount);
      moveCircle(ctx.city, s, p.kx * 0.08, p.ky * 0.08, PED_RADIUS);
      if (s.hp === 0) {
        s.mode = PedMode.Dead;
        s.angle = Math.atan2(p.ky, p.kx) + Math.PI; // falls away from the hit
        if (Math.random() < 0.6) {
          world.spawn(Pickup, { x: s.x + 0.8, y: s.y + 0.5, kind: PickupKind.Cash, amount: 10 + Math.floor(Math.random() * 60) });
        }
        credit(s.cop ? VICTIM_COP : VICTIM_PED);
      } else if (s.cop) {
        // an officer who gets shot goes after the shooter
        if (s.mode === PedMode.Walk && world.getAs(Player, p.attacker)) {
          s.mode = PedMode.Attack;
          s.target = p.attacker;
        }
      } else {
        panicPeds(ctx, s.x - p.kx, s.y - p.ky, 4);
      }
      return;
    }

    if (target.is(Player)) {
      const s = target.state;
      if (s.hp === 0 || target !== ctx.me) return;
      s.hp = Math.max(0, s.hp - p.amount);
      if (p.cause !== DamageCause.Explosion && !s.car) player.nudge(p.kx * 0.05, p.ky * 0.05);
      if (ctx.rig.xr) {
        ctx.rig.flash(0xff0000, Math.min(0.5, 0.15 + p.amount / 120));
        ctx.rig.left.pulse(0.5, 90);
        ctx.rig.right.pulse(0.5, 90);
      } else {
        ctx.hud.hurt();
        ctx.rig.shake(0.05);
      }
      if (s.hp === 0) {
        const killer = world.getAs(Player, p.attacker);
        const byPolice = !!world.getAs(Ped, p.attacker)?.state.cop;
        if (killer && killer !== target) credit(VICTIM_PLAYER);
        player.die(killer && killer !== target ? killer.state.name : byPolice ? 'Police' : null);
      }
      return;
    }

    if (target.is(Car)) {
      const s = target.state;
      if (s.mode === CarMode.Wrecked) return;
      if (p.attacker) target.local.lastAttacker = p.attacker;
      s.hp = Math.max(0, s.hp - p.amount);
      if (p.cause === DamageCause.Vehicle) {
        target.local.vx = (target.local.vx ?? 0) + p.kx * 0.4;
        target.local.vy = (target.local.vy ?? 0) + p.ky * 0.4;
      }
      if (s.hp === 0) {
        if (s.kind === CarKind.Police) credit(VICTIM_COP);
        wreckCar(ctx, target);
      }
    }
  });
}
