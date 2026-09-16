import * as THREE from 'three';
import { box, merge, paint } from '../crossplay/models';
import { Tool, Toolbox, type ToolUse } from '../crossplay/tool';
import type { Builder } from './builder';
import type { DerbyContext, RacerEntity, Vec3 } from './context';
import { Edit, EditOp, Racer, RacerMode } from './defs';
import { CELL, DIRS, Dir, PARTS, PROBLEM_TEXT, PartKind, placeProblem, type PlaceProblem } from './parts';
import { rotate, type Quat } from './physics';
import { designOf, quatOf } from './racer';
import { pickShelf, type ShelfHit } from './shelf';

/** How far the part gun and the wrench reach, m. */
export const BUILD_REACH = 7;

/** What a building tool is pointing at: a part of a racer, and the face of it. */
export interface Target {
  racer: RacerEntity;
  /** Index of the part in the racer's design. */
  part: number;
  face: Dir;
  /** Distance along the aim. */
  distance: number;
}

/** What a hand's building tool would do if used now, for the views to preview and the HUD to explain. */
export interface Aim {
  target: Target | null;
  /** Add: the cell the new part would go in, racer space. */
  cell: { x: number; y: number; z: number } | null;
  kind: PartKind | null;
  remove: boolean;
  problem: PlaceProblem | 'seat' | 'racing' | null;
  /** A shelf's SAVE plaque or cubby, when that's nearer than any racer (and then `target` is null). */
  shelf: ShelfHit | null;
}

export function noAim(): Aim {
  return { target: null, cell: null, kind: null, remove: false, problem: null, shelf: null };
}

const conj: Quat = { x: 0, y: 0, z: 0, w: 1 };
const lo: Vec3 = { x: 0, y: 0, z: 0 };
const ld: Vec3 = { x: 0, y: 0, z: 0 };
const rel: Vec3 = { x: 0, y: 0, z: 0 };

/** The nearest part of any racer in its bay along a ray, within `reach`. */
export function pickPart(ctx: DerbyContext, origin: Vec3, dir: Vec3, reach = BUILD_REACH): Target | null {
  let best: Target | null = null;
  for (const racer of ctx.world.query(origin.x, origin.y, reach + 5, Racer)) {
    if (racer.render.mode !== RacerMode.Parked) continue;
    const s = racer.render;
    quatOf(s, conj);
    conj.x = -conj.x;
    conj.y = -conj.y;
    conj.z = -conj.z;
    rel.x = origin.x - s.x;
    rel.y = origin.y - s.y;
    rel.z = origin.z - s.z;
    rotate(conj, rel, lo);
    rotate(conj, dir, ld);
    const { design, keep } = designOf(racer);
    design.forEach((p, i) => {
      if (!keep[i]) return;
      const hit = rayBox(lo, ld, p.x * CELL, p.y * CELL, p.z * CELL, CELL / 2);
      if (!hit || hit.t > reach || (best && hit.t >= best.distance)) return;
      best = { racer, part: i, face: hit.face, distance: hit.t };
    });
  }
  return best;
}

/** Where a ray enters a cube (centre, half size), and through which face. */
export function rayBox(o: Vec3, d: Vec3, cx: number, cy: number, cz: number, h: number): { t: number; face: Dir } | null {
  let tNear = -Infinity;
  let tFar = Infinity;
  let face = Dir.PZ;
  const axes: [number, number, number, Dir, Dir][] = [
    [o.x, d.x, cx, Dir.NX, Dir.PX],
    [o.y, d.y, cy, Dir.NY, Dir.PY],
    [o.z, d.z, cz, Dir.NZ, Dir.PZ],
  ];
  for (const [oa, da, ca, neg, pos] of axes) {
    if (Math.abs(da) < 1e-9) {
      if (oa < ca - h || oa > ca + h) return null;
      continue;
    }
    let t1 = (ca - h - oa) / da;
    let t2 = (ca + h - oa) / da;
    let enter = neg;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      enter = pos;
    }
    if (t1 > tNear) {
      tNear = t1;
      face = enter;
    }
    tFar = Math.min(tFar, t2);
    if (tNear > tFar || tFar < 0) return null;
  }
  return tNear < 0 ? null : { t: tNear, face };
}

/** Work out what a tool aimed from `use` would do, into `out`. */
export function aimBuild(ctx: DerbyContext, use: ToolUse<Builder>, kind: PartKind | null, out: Aim): Aim {
  let target = pickPart(ctx, use.origin, use.aim);
  const shelf = pickShelf(ctx.course, use.origin, use.aim, BUILD_REACH);
  out.shelf = shelf && (!target || shelf.distance < target.distance) ? shelf : null;
  if (out.shelf) target = null;
  out.target = target;
  out.kind = kind;
  out.remove = kind === null;
  out.cell = null;
  out.problem = null;
  if (!target) return out;
  const { design } = designOf(target.racer);
  const p = design[target.part];
  if (kind === null) {
    if (target.part === 0) out.problem = 'seat';
    return out;
  }
  const [dx, dy, dz] = DIRS[target.face];
  out.cell = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
  out.problem = placeProblem(design, target.part, out.cell.x, out.cell.y, out.cell.z);
  return out;
}

export function problemText(problem: Aim['problem']): string {
  if (!problem) return '';
  if (problem === 'seat') return "The seat stays: everything's built out from it";
  if (problem === 'racing') return 'Not while it is racing';
  return PROBLEM_TEXT[problem];
}

/** Ask a racer's owner to make an edit (or make it, if it's ours). */
function sendEdit(ctx: DerbyContext, racer: RacerEntity, op: EditOp, cell: { x: number; y: number; z: number }, dir: Dir, kind: PartKind): void {
  ctx.world.send(Edit, { racer: racer.id, op, x: cell.x, y: cell.y, z: cell.z, dir, kind }, { to: 'owner', entity: racer });
}

export type Use = ToolUse<Builder>;

/** The part gun: point at a face of a racer's part and pull the trigger to stick the loaded part on it. */
export class PartGun extends Tool<Builder> {
  override onHold(hand: Use): void {
    const b = hand.avatar;
    aimBuild(b.ctx, hand, b.part, b.aimFor(hand.side));
  }

  override onUse(hand: Use): void {
    const b = hand.avatar;
    const aim = aimBuild(b.ctx, hand, b.part, b.aimFor(hand.side));
    if (aim.shelf) return pressShelf(hand, aim.shelf);
    if (!aim.target || !aim.cell) return;
    if (aim.problem) {
      b.ctx.hud.message(problemText(aim.problem));
      b.ctx.sfx.play('nope');
      return;
    }
    sendEdit(b.ctx, aim.target.racer, EditOp.Add, aim.cell, aim.target.face, b.part);
    hand.effect({ kick: 0.4 });
    b.placed(aim);
  }
}

/** The wrench: point at a part and pull the trigger to take it off, and anything only held on by it. */
export class Wrench extends Tool<Builder> {
  override onHold(hand: Use): void {
    const b = hand.avatar;
    aimBuild(b.ctx, hand, null, b.aimFor(hand.side));
  }

  override onUse(hand: Use): void {
    const b = hand.avatar;
    const aim = aimBuild(b.ctx, hand, null, b.aimFor(hand.side));
    if (aim.shelf) return pressShelf(hand, aim.shelf);
    if (!aim.target) return;
    if (aim.problem) {
      b.ctx.hud.message(problemText(aim.problem));
      b.ctx.sfx.play('nope');
      return;
    }
    const { design } = designOf(aim.target.racer);
    const p = design[aim.target.part];
    sendEdit(b.ctx, aim.target.racer, EditOp.Remove, p, p.dir, p.kind);
    hand.effect({ kick: 0.6 });
    b.removed(aim);
  }
}

/** Either tool works the shelf's buttons: it's pointing, not building. */
function pressShelf(hand: Use, hit: ShelfHit): void {
  hand.effect({ kick: 0.15 });
  hand.avatar.pressShelf(hit);
}

function gunGeometry(): THREE.BufferGeometry {
  return merge([
    box(0.07, 0.1, 0.22, 0, 0, 0.02, 0xf39c12),
    box(0.05, 0.05, 0.16, 0, 0.01, -0.16, 0x2d3436),
    box(0.09, 0.09, 0.05, 0, 0.01, -0.25, 0x74b9ff),
    box(0.05, 0.13, 0.05, 0, -0.1, 0.06, 0x2d3436),
    box(0.03, 0.05, 0.03, 0, 0.08, 0.02, 0xdfe6e9),
  ]);
}

function wrenchGeometry(): THREE.BufferGeometry {
  const jaw = (x: number) => box(0.02, 0.025, 0.06, x, 0, -0.33, 0xb2bec3);
  return merge([
    box(0.03, 0.022, 0.34, 0, 0, -0.1, 0x95a5a6),
    box(0.1, 0.028, 0.035, 0, 0, -0.29, 0xb2bec3),
    jaw(-0.04),
    jaw(0.04),
    paint(new THREE.CylinderGeometry(0.022, 0.022, 0.12, 8).rotateX(Math.PI / 2).translate(0, 0, 0.1), 0xc0392b),
  ]);
}

export const PART_GUN = new PartGun({
  name: 'Part gun',
  model: { build: gunGeometry, length: 0.36 },
  grip: { tip: [0, 0.03, -0.3] },
  stash: [{ at: [0.24, -0.62, -0.02], pitch: -Math.PI / 2 }],
  color: 0xf39c12,
  issued: 1,
  max: 1,
  cooldownMs: 160,
  laser: true,
});

export const WRENCH = new Wrench({
  name: 'Wrench',
  model: { build: wrenchGeometry, length: 0.44 },
  grip: { tip: [0, 0, -0.36] },
  stash: [{ at: [-0.24, -0.62, -0.02], pitch: -Math.PI / 2 }],
  color: 0x95a5a6,
  issued: 1,
  max: 1,
  cooldownMs: 220,
  laser: true,
});

export const TOOLS = new Toolbox<Tool<Builder>>([PART_GUN, WRENCH]);

/** A short name for a part kind, for the HUD. */
export function partName(kind: PartKind): string {
  return PARTS[kind].name;
}
