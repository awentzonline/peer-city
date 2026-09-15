import { animalSpec } from './bodies';
import type { WildsContext } from './context';
import { Animal, AnimalKind, AnimalMode, Butcher, Campfire, Chop, Damage, Feed, Fuel, Hunted, Item, Survivor } from './defs';
import { applyFuel } from './homestead';
import { RAW_MEAT } from './kit';
import type { Survivor as SurvivorRole } from './survivor';

/**
 * Wires Peer Wilds' actions. As in Peer City, a change to an entity is made by its owner, the only peer
 * allowed to write it: damage by the victim's, butchering by the carcass's, stoking by the fire's.
 */
export function registerCombat(ctx: WildsContext, survivor: SurvivorRole): void {
  const { world, land } = ctx;

  world.onAction(Feed, (p) => ctx.hud.message(p.text));

  world.onAction(Chop, (p) => {
    ctx.fx.chips(p.x, p.y, p.z, p.wood);
    ctx.sfx.play(p.wood ? 'chop' : 'hit', p);
  });

  world.onAction(Fuel, (p) => {
    const fire = world.getAs(Campfire, p.fire);
    if (fire?.mine) applyFuel(ctx, fire, p.seconds);
  });

  world.onAction(Hunted, (p) => {
    if (world.get(p.attacker) === ctx.me && ctx.me) ctx.hud.message(`You brought down a ${animalSpec(p.kind).name}. Butcher it with the axe.`);
  });

  world.onAction(Butcher, (p) => {
    const a = world.getAs(Animal, p.animal);
    if (!a?.mine || a.state.mode !== AnimalMode.Dead || a.state.meat === 0) return;
    a.state.meat--;
    const angle = Math.random() * Math.PI * 2;
    world.spawn(Item, { x: a.state.x + Math.cos(angle) * 0.8, y: a.state.y + Math.sin(angle) * 0.8, tool: RAW_MEAT.id, amount: 1 });
  });

  world.onAction(Damage, (p) => {
    const target = world.get(p.target);
    if (!target || !target.mine) return;

    if (target.is(Animal)) {
      const s = target.state;
      if (s.mode === AnimalMode.Dead) return;
      const spec = animalSpec(s.kind);
      s.hp = Math.max(0, s.hp - p.amount);
      land.move(s, p.kx * 0.05, p.ky * 0.05, spec.radius);
      const attacker = world.get(p.attacker);
      if (s.hp === 0) {
        s.mode = AnimalMode.Dead;
        s.meat = spec.meat;
        s.target = 0;
        if (attacker) world.send(Hunted, { attacker: p.attacker, kind: s.kind }, { to: 'owner', entity: attacker });
      } else if (s.kind === AnimalKind.Wolf && attacker?.is(Survivor)) {
        s.mode = AnimalMode.Hunt; // wolves turn on whoever hurt them
        s.target = attacker.id;
      } else if (attacker) {
        s.mode = AnimalMode.Flee;
        Object.assign(target.local, { fleeUntil: ctx.now + 5000, fx: attacker.x, fy: attacker.y });
      }
      return;
    }

    if (target.is(Survivor)) {
      const s = target.state;
      if (s.hp <= 0 || target !== ctx.me) return;
      s.hp = Math.max(0, s.hp - p.amount);
      survivor.nudge(p.kx * 0.05, p.ky * 0.05);
      survivor.hurt(p.amount);
      ctx.sfx.play('hurt');
      if (s.hp === 0) {
        const attacker = world.get(p.attacker);
        const name = attacker?.is(Animal) ? `a ${animalSpec(attacker.state.kind).name}` : attacker?.is(Survivor) && attacker !== target ? attacker.state.name : null;
        survivor.die(name);
      }
    }
  });
}
