import type { Vec3 } from './context';
import { Car } from './defs';
import { isPoliceUnit } from './police';
import type { SoundName } from './sfx';
import { Tool, type ToolOptions, type ToolUse } from './tool';
import { fireBullet, scatter } from './weapons';

export interface GunOptions extends ToolOptions {
  range: number;
  /** Damage to a body, a head and a car. */
  body: number;
  head: number;
  car: number;
  /** Bullets per shot, fanned out within `spread` radians. */
  pellets?: number;
  spread?: number;
  /** Recoil strength, 1 = pistol. */
  kick: number;
  sound: SoundName;
}

const pellet: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * A hit-scan gun. Each use is a shot of `pellets` bullets, spending a round. Guns are automatic and have
 * a VR laser sight unless told otherwise, and their charges are called ammo.
 */
export class Gun extends Tool {
  readonly range: number;
  readonly body: number;
  readonly head: number;
  readonly car: number;
  readonly pellets: number;
  readonly spread: number;
  readonly kick: number;
  readonly sound: SoundName;

  constructor(o: GunOptions) {
    super({ automatic: true, laser: true, ...o, charges: o.charges && { unit: 'ammo', ...o.charges } });
    this.range = o.range;
    this.body = o.body;
    this.head = o.head;
    this.car = o.car;
    this.pellets = o.pellets ?? 1;
    this.spread = o.spread ?? 0;
    this.kick = o.kick;
    this.sound = o.sound;
  }

  override onUse(use: ToolUse): void {
    const { avatar } = use;
    const { ctx } = avatar;
    const me = avatar.me!;
    let hitSomething = false;
    let head = false;
    let hitPolice = false;
    for (let i = 0; i < this.pellets; i++) {
      const hit = fireBullet(ctx, me, use.origin, this.spread ? scatter(use.aim, this.spread, pellet) : use.aim, {
        range: this.range,
        ignore: me.state.car || undefined,
        from: use.tip,
        tool: this.id,
        quiet: i > 0,
        damage: (e, isHead) => (e.def === Car ? this.car : isHead ? this.head : this.body),
      });
      if (!hit.entity) continue;
      hitSomething = true;
      head ||= hit.head;
      hitPolice ||= isPoliceUnit(hit.entity);
    }
    use.spend();
    use.effect({ kick: this.kick, hit: !hitSomething ? 'miss' : head ? 'head' : 'body' });
    if (hitSomething) ctx.sfx.play(head ? 'headshot' : 'hit');
    // shooting at police is 2 stars; shooting anywhere near them is 1
    if (hitPolice) avatar.raiseWanted(2);
    else if (ctx.world.query(me.state.x, me.state.y, 65).some(isPoliceUnit)) avatar.raiseWanted(1);
  }
}
