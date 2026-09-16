import { Avatar, EYE, RADIUS, type AvatarBody, type AvatarFrontend } from '../crossplay/avatar';
import { Side, type AvatarIntent, type HandIntent } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Role } from '../crossplay/role';
import { isNight } from './clock';
import { clamp, direction, type PlotEntity, type SurvivorEntity, type Vec3, type WildsContext } from './context';
import { Crop, Feed, Item, Survivor as SurvivorDef } from './defs';
import { WARM_RADIUS, fireNear, harvest, plotNear, ripe } from './homestead';
import { ARROWS, CARROT, SEEDS, TOOLS, type WildTool } from './kit';
import type { Toolbox } from '../crossplay/tool';

/** Seconds from full to starving. */
const FULL_SECONDS = 420;
/** Hunger runs this much faster out in the cold at night. */
const COLD_HUNGER = 1.6;
const STARVE_HP_PER_SECOND = 1.5;
const HEAL_HP_PER_SECOND = 0.8;
const RESPAWN_MS = 5000;
/** How far an empty hand, or the crosshair's reach, pulls crops from. */
const HAND_REACH = 0.5;
const CROSSHAIR_REACH = 3;

export type SurvivorFrontend = AvatarFrontend<AvatarIntent>;

const NO_BODY: AvatarBody = { platform: Platform.Desktop, moved() {}, placed() {}, hurt() {}, used() {}, died() {} };
const aim: Vec3 = { x: 0, y: 0, z: 0 };
const eye: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The survivor role in Peer Wilds: walk the island (on the ground's height), use tools (kit.ts), keep fed and
 * warm, pull crops, pick things up, and die and come back. Like every avatar it only sees an intent and
 * reaches the device through `body` (see crossplay/avatar.ts).
 */
export class Survivor extends Avatar<AvatarIntent, AvatarBody, WildTool> implements Role<AvatarIntent, SurvivorFrontend> {
  body: AvatarBody = NO_BODY;
  /** A ripe crop within reach this frame, for the HUD to point out. */
  nearRipe: PlotEntity | undefined;
  /** Out at night with no fire nearby. */
  cold = false;
  /** Swings each tree has taken from this survivor, by obstacle index. */
  readonly chops = new Map<number, number>();
  private respawnAt = 0;
  private readonly collecting = new Set<number>();
  private readonly grabbing: [boolean, boolean] = [false, false];

  constructor(
    readonly ctx: WildsContext,
    tools: Toolbox<WildTool> = TOOLS,
  ) {
    super(tools);
  }

  get me(): SurvivorEntity | null {
    return this.ctx.me;
  }

  get now(): number {
    return this.ctx.now;
  }

  get alive(): boolean {
    return !!this.me && this.me.state.hp > 0;
  }

  protected override move(p: { x: number; y: number }, dx: number, dy: number): void {
    this.ctx.land.move(p, dx, dy, RADIUS);
  }

  protected override groundAt(x: number, y: number): number {
    return this.ctx.land.heightAt(x, y);
  }

  protected override switchedTool(): void {
    this.ctx.sfx.play('switch');
  }

  spawn(): void {
    const { ctx } = this;
    const spot = ctx.land.spawnPoint();
    ctx.me = ctx.world.spawn(SurvivorDef, { x: spot.x, y: spot.y, name: ctx.playerName, skin: Math.floor(Math.random() * 30), hp: 100, food: 80 });
    this.heading = Math.random() * Math.PI * 2;
    this.inventory.add(ARROWS, 12);
    this.inventory.add(SEEDS, 6);
    this.inventory.add(CARROT, 3);
    ctx.world.setFocus(spot.x, spot.y);
  }

  update(dt: number, intent: AvatarIntent): void {
    const { ctx } = this;
    const me = this.me;
    if (!me) return;
    const s = me.state;
    this.begin(intent);
    s.draw = 0;
    this.nearRipe = undefined;

    if (s.hp <= 0) {
      if (this.respawnAt && ctx.now >= this.respawnAt) this.respawn();
      ctx.world.setFocus(s.x, s.y);
      return;
    }

    if (intent.head) this.walkTracked(dt, intent.head, intent, true);
    else this.walk(dt, intent);
    this.collectItems();
    this.metabolise(dt);
    if (s.hp <= 0) {
      ctx.world.setFocus(s.x, s.y);
      return;
    }

    this.nearRipe = plotNear(ctx, s.x, s.y, CROSSHAIR_REACH + 0.2, (p) => ripe(p, ctx.wall));
    if (intent.hands) {
      this.useHands(intent.hands, dt);
      this.reachWithHands(intent.hands);
    } else {
      this.useCrosshair(intent, dt);
      if (intent.interact) this.reachAhead();
    }
    ctx.world.setFocus(s.x, s.y);
  }

  /** Hunger, starving, healing on a full stomach, and the cold. */
  private metabolise(dt: number): void {
    const { ctx } = this;
    const s = this.me!.state;
    this.cold = isNight(ctx.day) && !fireNear(ctx, s.x, s.y, WARM_RADIUS);
    s.food = Math.max(0, s.food - (dt * 100 * (this.cold ? COLD_HUNGER : 1)) / FULL_SECONDS);
    if (s.food <= 0) {
      s.hp = Math.max(0, s.hp - STARVE_HP_PER_SECOND * dt);
      if (s.hp <= 0) this.die(null, 'starved');
    } else if (s.food > 60 && s.hp < 100) {
      s.hp = Math.min(100, s.hp + HEAL_HP_PER_SECOND * dt);
    }
  }

  /** Eat something: `food` fills you up, `hp` heals (or hurts, for raw meat). */
  eat(food: number, hp: number): void {
    const s = this.me!.state;
    s.food = clamp(s.food + food, 0, 100);
    s.hp = clamp(s.hp + hp, 1, 100);
    if (hp < 0) this.body.hurt(-hp);
    this.ctx.sfx.play('eat');
  }

  /** Put charges of a tool into the inventory and say so. */
  give(tool: WildTool, charges: number): void {
    tool.onPickup(this, this.inventory.add(tool, charges));
  }

  /** An empty hand closing near a ripe crop pulls it. */
  private reachWithHands(hands: [HandIntent, HandIntent]): void {
    const { land } = this.ctx;
    for (const side of [Side.Right, Side.Left]) {
      const hand = hands[side];
      const fresh = hand.grab && !this.grabbing[side];
      this.grabbing[side] = hand.grab;
      if (!fresh || !hand.tracked || hand.tool) continue;
      const g = hand.grip;
      if (g.z > land.heightAt(g.x, g.y) + 0.7) continue;
      const plot = plotNear(this.ctx, g.x, g.y, HAND_REACH, (p) => ripe(p, this.ctx.wall));
      if (plot) this.pull(plot);
    }
  }

  /** Pull whatever ripe crop is where you're looking, or failing that at your feet. */
  private reachAhead(): void {
    const { ctx } = this;
    const s = this.me!.state;
    this.eyePosition(eye);
    direction(this.heading, this.pitch, aim);
    const hit = ctx.land.raycast(eye.x, eye.y, eye.z, aim.x, aim.y, aim.z, CROSSHAIR_REACH);
    const isRipe = (p: PlotEntity) => ripe(p, ctx.wall);
    const plot = plotNear(ctx, eye.x + aim.x * hit.t, eye.y + aim.y * hit.t, 1.2, isRipe) ?? plotNear(ctx, s.x, s.y, 1.6, isRipe);
    if (plot) this.pull(plot);
  }

  private pull(plot: PlotEntity): void {
    void harvest(this.ctx, plot).then((crop) => {
      if (crop !== Crop.Carrot || !this.alive) return;
      this.give(CARROT, 2);
      this.give(SEEDS, Math.random() < 0.5 ? 2 : 1);
    });
  }

  private collectItems(): void {
    const { ctx } = this;
    const s = this.me!.state;
    for (const item of ctx.world.query(s.x, s.y, 1.4, Item)) {
      if (this.collecting.has(item.id)) continue;
      const tool = this.inventory.tools.get(item.state.tool);
      if (!tool || !this.inventory.wants(tool)) continue;
      this.collecting.add(item.id);
      // Ownership doubles as a lock: only one survivor gets it.
      void ctx.world
        .withLock(item, () => {
          if (!this.alive) return;
          this.give(tool, item.state.amount);
          ctx.world.despawn(item);
          ctx.sfx.play('pickup');
        })
        .then(() => this.collecting.delete(item.id));
    }
  }

  /** Called by combat when this survivor takes damage (already applied to its hp). */
  hurt(amount: number): void {
    this.body.hurt(amount);
  }

  /** Called when hp reaches zero: by an animal or survivor's name, or by hunger. */
  die(killerName: string | null, how = 'died'): void {
    const { ctx } = this;
    const me = this.me!;
    me.state.hp = 0;
    me.state.draw = 0;
    this.respawnAt = ctx.now + RESPAWN_MS;
    this.body.died();
    ctx.hud.showBanner('YOU DIED', '#e0533a', RESPAWN_MS - 500);
    ctx.sfx.play('died');
    // everything you gathered spills where you fell
    for (const lost of this.inventory.clear()) this.drop(lost.tool, 'dropped', lost.charges, (Math.random() - 0.5) * 2);
    const text = killerName ? `${me.state.name} was killed by ${killerName}` : `${me.state.name} ${how}`;
    ctx.world.send(Feed, { text }, { to: 'all' });
  }

  private respawn(): void {
    const me = this.me!;
    const p = this.ctx.land.spawnPoint();
    Object.assign(me.state, { hp: 100, food: 60 });
    this.teleport(p.x, p.y);
    this.respawnAt = 0;
    this.inventory.add(ARROWS, 6);
    this.inventory.add(CARROT, 1);
  }

  /** The eyes' height above the ground, for tools that act at arm's length. */
  static readonly eye = EYE;
}
