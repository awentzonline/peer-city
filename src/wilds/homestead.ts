import { clamp, type CampfireEntity, type PlotEntity, type WildsContext } from './context';
import { Campfire, Crop, Fuel, Plot, Stump, Survivor } from './defs';
import { Ground, ObstacleKind } from './land';

/** How long a crop takes to grow, seconds. */
export const GROW_SECONDS = 150;
/** Plots sit on a grid this many meters apart, so farms come out tidy. */
export const PLOT_SPACING = 1.5;
/** A new fire burns this long; each log adds more, up to a limit. Seconds. */
export const FIRE_BUILD_SECONDS = 150;
export const FIRE_LOG_SECONDS = 60;
const FIRE_MAX_SECONDS = 600;
/** Logs it takes to build a fire. */
export const FIRE_LOGS = 3;
/** How near a lit fire keeps you warm, and keeps wolves off. */
export const WARM_RADIUS = 7;
/** Swings to fell a tree, and how long until it grows back, seconds. */
export const CHOPS_TO_FELL = 5;
const REGROW_SECONDS = 900;
/** How long a burnt-out fire's ashes stay, seconds. */
const ASH_SECONDS = 90;

/**
 * The lasting things people make in the wild: tilled plots and their crops, campfires, and felled trees.
 * They're migratable entities, so they outlive whoever made them for as long as anyone is nearby to keep
 * them. Changing one uses the engine's ownership as a lock, like picking something up.
 */

/** How grown a plot's crop is, 0..1 (0 with nothing sown). */
export function growth(plot: PlotEntity, wall: number): number {
  const s = plot.render;
  if (s.crop === Crop.None) return 0;
  return clamp((wall - s.planted) / GROW_SECONDS, 0, 1);
}

export function ripe(plot: PlotEntity, wall: number): boolean {
  return plot.render.crop !== Crop.None && growth(plot, wall) >= 1;
}

/** The plot nearest a point, within `r`, that `accept` likes. */
export function plotNear(ctx: WildsContext, x: number, y: number, r: number, accept: (p: PlotEntity) => boolean = () => true): PlotEntity | undefined {
  let best: PlotEntity | undefined;
  let bestD = r;
  for (const p of ctx.world.query(x, y, r, Plot)) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bestD && accept(p)) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** Break the soil at a point, snapped to the plot grid. False if the ground's no good or there's a plot there already. */
export function till(ctx: WildsContext, x: number, y: number): boolean {
  const { land } = ctx;
  const px = (Math.floor(x / PLOT_SPACING) + 0.5) * PLOT_SPACING;
  const py = (Math.floor(y / PLOT_SPACING) + 0.5) * PLOT_SPACING;
  const g = land.groundAt(px, py);
  if (g !== Ground.Grass && g !== Ground.Forest) return false;
  if (land.blocked(px, py, 0.5) || plotNear(ctx, px, py, PLOT_SPACING * 0.9)) return false;
  ctx.world.spawn(Plot, { x: px, y: py });
  const z = land.heightAt(px, py);
  ctx.fx.dirt(px, py, z);
  ctx.sfx.play('till', { x: px, y: py, z });
  return true;
}

/** Plant a crop in an empty plot. Resolves true once it's in. */
export async function sow(ctx: WildsContext, plot: PlotEntity, crop: Crop): Promise<boolean> {
  if (plot.state.crop !== Crop.None) return false;
  const sown = await ctx.world.withLock(plot, (p) => {
    if (p.state.crop !== Crop.None) return false;
    p.state.crop = crop;
    p.state.planted = Math.floor(ctx.wall);
    return true;
  });
  if (sown) ctx.sfx.play('sow', { x: plot.x, y: plot.y, z: ctx.land.heightAt(plot.x, plot.y) });
  return !!sown;
}

/** Pull a ripe crop, leaving the soil tilled. Resolves to the crop pulled, or None. */
export async function harvest(ctx: WildsContext, plot: PlotEntity): Promise<Crop> {
  if (!ripe(plot, ctx.wall)) return Crop.None;
  const crop = await ctx.world.withLock(plot, (p) => {
    if (!ripe(p, ctx.wall)) return Crop.None;
    const pulled = p.state.crop;
    p.state.crop = Crop.None;
    p.state.planted = 0;
    return pulled;
  });
  if (!crop) return Crop.None;
  const z = ctx.land.heightAt(plot.x, plot.y);
  ctx.fx.dirt(plot.x, plot.y, z);
  ctx.sfx.play('harvest', { x: plot.x, y: plot.y, z });
  return crop;
}

/** A fire within `r` of a point: lit ones only, unless `ashes` too. */
export function fireNear(ctx: WildsContext, x: number, y: number, r: number, ashes = false): CampfireEntity | undefined {
  let best: CampfireEntity | undefined;
  let bestD = r;
  for (const f of ctx.world.query(x, y, r, Campfire)) {
    if (!ashes && f.render.until <= ctx.wall) continue;
    const d = Math.hypot(f.x - x, f.y - y);
    if (d <= bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

/** Whether a spot can take a new fire: open, dry ground, clear of other fires. */
export function canBuildFire(ctx: WildsContext, x: number, y: number): boolean {
  const g = ctx.land.groundAt(x, y);
  return g !== Ground.Water && !ctx.land.blocked(x, y, 0.7) && !fireNear(ctx, x, y, 2.5, true) && !plotNear(ctx, x, y, 1.2);
}

export function buildFire(ctx: WildsContext, x: number, y: number): CampfireEntity {
  const fire = ctx.world.spawn(Campfire, { x, y, until: Math.floor(ctx.wall) + FIRE_BUILD_SECONDS });
  ctx.sfx.play('ignite', { x, y, z: ctx.land.heightAt(x, y) });
  return fire;
}

/** Put logs on a fire (lit or ashes). Its owner does it. */
export function addLogs(ctx: WildsContext, fire: CampfireEntity, logs: number): void {
  ctx.world.command(Fuel, { fire: fire.id, seconds: logs * FIRE_LOG_SECONDS });
  ctx.sfx.play('ignite', { x: fire.x, y: fire.y, z: ctx.land.heightAt(fire.x, fire.y) });
}

/** The fire's owner, burning the logs someone added. */
export function applyFuel(ctx: WildsContext, fire: CampfireEntity, seconds: number): void {
  const now = Math.floor(ctx.wall);
  fire.state.until = Math.min(now + FIRE_MAX_SECONDS, Math.max(fire.state.until, now) + seconds);
}

/** Bring a tree down. False if it's already down. */
export function fell(ctx: WildsContext, tree: number): boolean {
  const { land, world } = ctx;
  const o = land.obstacles[tree];
  if (!o || o.kind === ObstacleKind.Rock || !land.standing(tree)) return false;
  world.spawn(Stump, { x: o.x, y: o.y, tree, felled: Math.floor(ctx.wall) });
  land.felled.add(tree);
  ctx.sfx.play('fell', { x: o.x, y: o.y, z: o.base + 2 });
  return true;
}

/** Keep the land's felled trees in step with the stumps this peer knows about. */
export function trackStumps(ctx: WildsContext): void {
  const { world, land } = ctx;
  world.track(Stump, {
    added: (stump) => land.felled.add(stump.state.tree),
    removed: (stump) => {
      const tree = stump.state.tree;
      for (const other of world.all(Stump)) if (other !== stump && other.state.tree === tree) return;
      land.felled.delete(tree);
    },
  });
}

/** Owned stumps grow back into trees, and owned fires' ashes blow away, in time. */
export function updateOwnedHomestead(ctx: WildsContext): void {
  const { world, land, wall } = ctx;
  for (const stump of world.owned(Stump)) {
    if (wall - stump.state.felled < REGROW_SECONDS) continue;
    const o = land.obstacles[stump.state.tree];
    // not while someone's standing where the trunk would be
    if (o && world.query(o.x, o.y, o.r + 0.6, Survivor).length) continue;
    world.despawn(stump);
  }
  for (const fire of world.owned(Campfire)) {
    if (wall - fire.state.until > ASH_SECONDS) world.despawn(fire);
  }
}
