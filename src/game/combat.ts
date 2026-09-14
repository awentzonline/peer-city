import type { GameContext } from './context';
import { Busted, Car, CarKind, CarMode, Damage, DamageCause, Explosion, Feed, Horn, Kill, Ped, PedMode, Pickup, PickupKind, Player, Shot } from './defs';
import { moveCircle, panicPeds } from './peds';
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

  world.onAction(Shot, (p) => {
    // police remember who has been shooting (see police.ts)
    const shooter = world.getAs(Player, p.shooter);
    if (shooter) shooter.local.lastShot = ctx.now;
    ctx.fx.tracer(p.x, p.y, p.angle, p.dist);
    ctx.sfx.play('shot', p.x, p.y);
    panicPeds(ctx, p.x, p.y, 420);
  });

  world.onAction(Explosion, (p) => {
    ctx.fx.explosion(p.x, p.y);
    ctx.sfx.play('boom', p.x, p.y);
    panicPeds(ctx, p.x, p.y, 700);
  });

  world.onAction(Horn, (p) => {
    const car = world.get(p.car);
    if (car) ctx.sfx.play('horn', car.x, car.y);
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
      moveCircle(ctx.city, s, p.kx * 0.08, p.ky * 0.08, 7);
      if (s.hp === 0) {
        s.mode = PedMode.Dead;
        s.angle = Math.atan2(p.ky, p.kx);
        if (Math.random() < 0.6) {
          world.spawn(Pickup, { x: s.x + 10, y: s.y + 6, kind: PickupKind.Cash, amount: 10 + Math.floor(Math.random() * 60) });
        }
        credit(s.cop ? VICTIM_COP : VICTIM_PED);
      } else if (s.cop) {
        // an officer who gets shot goes after the shooter
        if (s.mode === PedMode.Walk && world.getAs(Player, p.attacker)) {
          s.mode = PedMode.Attack;
          s.target = p.attacker;
        }
      } else {
        panicPeds(ctx, s.x - p.kx, s.y - p.ky, 40);
      }
      return;
    }

    if (target.is(Player)) {
      const s = target.state;
      if (s.hp === 0 || target !== ctx.me) return;
      s.hp = Math.max(0, s.hp - p.amount);
      if (p.cause !== DamageCause.Explosion && !s.car) moveCircle(ctx.city, s, p.kx * 0.05, p.ky * 0.05, 9);
      ctx.scene.cameras.main.shake(120, 0.004);
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
