import { TOOLS } from './arsenal';
import { direction, signedAngle, type GameContext } from './context';
import { Busted, Car, CarKind, CarMode, Damage, DamageCause, Explosion, Feed, Horn, Kill, Ped, PedMode, Pickup, PickupKind, Player, Shot } from './defs';
import { Gun } from './gun';
import { PED_RADIUS, moveCircle, panicPeds } from './peds';
import { ShotMemory } from './police';
import type { AvatarSim } from './avatar';
import { CarMind, wreckCar } from './vehicles';

const VICTIM_PED = 0;
const VICTIM_PLAYER = 1;
const VICTIM_COP = 2;

/**
 * Wires gameplay actions. Damage is always applied by the victim's owner, the
 * only peer allowed to write its state; everyone else just renders effects.
 */
export function registerCombat(ctx: GameContext, player: AvatarSim): void {
  const { world } = ctx;
  const dir = { x: 0, y: 0, z: 0 };

  world.onAction(Shot, (p) => {
    // police remember who has been shooting (see police.ts)
    const shooter = world.getAs(Player, p.shooter);
    if (shooter) ShotMemory.of(shooter).lastShot = ctx.now;
    direction(p.yaw, signedAngle(p.pitch), dir);
    ctx.fx.tracer(p.x, p.y, p.z, p.x + dir.x * p.dist, p.y + dir.y * p.dist, p.z + dir.z * p.dist, p.impact);
    if (p.quiet) return;
    ctx.fx.muzzle(p.x, p.y, p.z);
    const gun = TOOLS.get(p.tool);
    ctx.sfx.play(gun instanceof Gun ? gun.sound : 'shot', p);
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

  world.onCommand(Busted, Player, (suspect, p) => {
    if (suspect === ctx.me) player.busted(world.getAs(Ped, p.cop));
  });

  world.onCommand(Kill, Player, (attacker, p) => {
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

  /** Tell whoever did it that they got a kill. */
  const credit = (attacker: number, victimKind: number, x: number, y: number) => world.command(Kill, { attacker, victimKind, x, y });

  world.onCommand(Damage, Ped, (target, p) => {
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
      credit(p.attacker, s.cop ? VICTIM_COP : VICTIM_PED, target.x, target.y);
    } else if (s.cop) {
      // an officer who gets shot goes after the shooter
      if (s.mode === PedMode.Walk && world.getAs(Player, p.attacker)) {
        s.mode = PedMode.Attack;
        s.target = p.attacker;
      }
    } else {
      panicPeds(ctx, s.x - p.kx, s.y - p.ky, 4);
    }
  });

  world.onCommand(Damage, Player, (target, p) => {
    const s = target.state;
    if (s.hp === 0 || target !== ctx.me) return;
    s.hp = Math.max(0, s.hp - p.amount);
    if (p.cause !== DamageCause.Explosion && !s.car) player.nudge(p.kx * 0.05, p.ky * 0.05);
    player.hurt(p.amount);
    if (s.hp === 0) {
      const killer = world.getAs(Player, p.attacker);
      const byPolice = !!world.getAs(Ped, p.attacker)?.state.cop;
      if (killer && killer !== target) credit(p.attacker, VICTIM_PLAYER, target.x, target.y);
      player.die(killer && killer !== target ? killer.state.name : byPolice ? 'Police' : null);
    }
  });

  world.onCommand(Damage, Car, (target, p) => {
    const s = target.state;
    if (s.mode === CarMode.Wrecked) return;
    const mind = CarMind.of(target);
    if (p.attacker) mind.lastAttacker = p.attacker;
    s.hp = Math.max(0, s.hp - p.amount);
    if (p.cause === DamageCause.Vehicle) {
      mind.vx = (mind.vx ?? 0) + p.kx * 0.4;
      mind.vy = (mind.vy ?? 0) + p.ky * 0.4;
    }
    if (s.hp === 0) {
      if (s.kind === CarKind.Police) credit(p.attacker, VICTIM_COP, target.x, target.y);
      wreckCar(ctx, target);
    }
  });
}
