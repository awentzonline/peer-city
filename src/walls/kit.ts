import * as THREE from 'three';
import { box, merge, paint } from '../crossplay/models';
import { Tool, Toolbox, type ToolOptions, type ToolUse } from '../crossplay/tool';
import type { Painter } from './painter';
import { Brush, PX_PER_M, type StrokePoint, type WallHit } from './wall';
import { pickSwatch, pickWall } from './yard';

/**
 * Peer Walls' tools: a spray can, a marker and a roller. They all paint where they point, from a tracked hand's
 * nozzle, nib or roller, or from the eyes through the crosshair. With a crosshair the tool's held about an arm's
 * length in front of the eyes, so how far you stand from the wall matters the same way on every platform.
 *
 * Point any of them at the rack and use it to load that colour.
 */

/** A crosshair's tool is this far in front of the eyes. */
export const ARM = 0.55;
/** How far away a swatch on the rack can be picked. */
export const RACK_REACH = 2.6;
export const SIZES = 3;

/** What a hand's tool is pointing at, for the views to preview and the HUD to explain. */
export interface PaintAim {
  hit: WallHit | null;
  /** From the tool to the wall, m: a spray gets wider and fainter further off. */
  distance: number;
  /** Whether paint would land from here. */
  inReach: boolean;
  /** The brush's radius on the wall there, m. */
  radius: number;
  /** A swatch on the rack, when that's nearer than any wall. */
  swatch: number | null;
  painting: boolean;
}

export function noAim(): PaintAim {
  return { hit: null, distance: 0, inReach: false, radius: 0, swatch: null, painting: false };
}

/** How a kind of tool paints. */
export interface BrushSpec {
  brush: Brush;
  /** The furthest the tool can be from the wall and still paint, m. */
  reach: number;
  /** Radius on the wall, m, by size, from `distance` away. */
  radius(size: number, distance: number): number;
  /** How much paint a point carries. Spray arrives over time, so it takes the frame's `dt`. */
  strength(size: number, distance: number, dt: number): number;
  /** The sizes, for the HUD. */
  sizes: readonly string[];
}

interface Stroke {
  surface: number;
  last: StrokePoint | null;
  /** This press picked a colour off the rack: it doesn't paint until it's let go. */
  picked: boolean;
}

const strokes = new WeakMap<ToolUse<Painter>, Stroke>();

function strokeOf(hand: ToolUse<Painter>): Stroke {
  let s = strokes.get(hand);
  if (!s) strokes.set(hand, (s = { surface: -1, last: null, picked: false }));
  return s;
}

export class PaintTool extends Tool<Painter> {
  constructor(
    o: ToolOptions,
    readonly spec: BrushSpec,
  ) {
    super(o);
  }

  override onUse(hand: ToolUse<Painter>): void {
    const aim = this.aim(hand);
    if (aim.swatch === null) return;
    strokeOf(hand).picked = true;
    hand.avatar.pickColor(aim.swatch);
    hand.effect({ kick: 0.1 });
  }

  override onRelease(hand: ToolUse<Painter>): void {
    const s = strokeOf(hand);
    s.picked = false;
    s.last = null;
  }

  override onUnequip(hand: ToolUse<Painter>): void {
    this.onRelease(hand);
  }

  override onHold(hand: ToolUse<Painter>, dt: number): void {
    const painter = hand.avatar;
    const aim = this.aim(hand);
    const s = strokeOf(hand);
    const size = painter.size;
    const pressed = hand.pressedAt !== null && !s.picked;
    aim.painting = pressed && aim.inReach;
    if (pressed && this.spec.brush === Brush.Spray) painter.spraying[hand.side ?? 0] = true;
    if (!aim.painting || !aim.hit) {
      s.last = null;
      return;
    }
    const hit = aim.hit;
    const point: StrokePoint = { x: hit.px, y: hit.py, r: aim.radius * PX_PER_M, a: this.spec.strength(size, aim.distance, dt) };
    const cont = !!s.last && s.surface === hit.surface;
    // a nib or roller that hasn't moved has nothing new to put down; spray keeps building up
    if (cont && this.spec.brush !== Brush.Spray && Math.abs(s.last!.x - point.x) < 0.25 && Math.abs(s.last!.y - point.y) < 0.25) return;
    // (painting rounds the point to what goes over the wire, so the next stroke carries on from exactly there)
    painter.ctx.sync.paint(hit.surface, this.spec.brush, painter.color, cont ? [s.last!, point] : [point], cont);
    s.last = point;
    s.surface = hit.surface;
  }

  /** Work out what the hand's tool is pointing at, into the painter's aim for that hand. */
  aim(hand: ToolUse<Painter>): PaintAim {
    const painter = hand.avatar;
    const aim = painter.aimFor(hand.side);
    const offset = hand.side === null ? ARM : 0;
    const hit = pickWall(painter.ctx.surfaces, hand.origin, hand.aim, offset + Math.max(this.spec.reach, RACK_REACH));
    const swatch = pickSwatch(hand.origin, hand.aim, RACK_REACH);
    aim.swatch = swatch && (!hit || swatch.distance < hit.distance) ? swatch.color : null;
    aim.hit = aim.swatch === null ? hit : null;
    aim.distance = hit ? Math.max(0, hit.distance - offset) : 0;
    aim.inReach = !!aim.hit && aim.distance <= this.spec.reach;
    aim.radius = this.spec.radius(painter.size, aim.distance);
    return aim;
  }
}

// ---------------------------------------------------------------------------
// The kinds
// ---------------------------------------------------------------------------

const CAP_BASE = [0.008, 0.02, 0.045];
const CAP_SPREAD = [0.06, 0.12, 0.26];
const CAP_RATE = [16, 11, 8];

export const SPRAY: BrushSpec = {
  brush: Brush.Spray,
  reach: 1.5,
  radius: (size, d) => CAP_BASE[size] + CAP_SPREAD[size] * d,
  // wider from further off, so the same paint covers more wall more thinly
  strength: (size, d, dt) => Math.min(1, (CAP_RATE[size] * dt) / (1 + d * 1.5)),
  sizes: ['Skinny cap', 'Standard cap', 'Fat cap'],
};

const NIBS = [0.006, 0.013, 0.026];

export const MARKER: BrushSpec = {
  brush: Brush.Marker,
  reach: 0.25,
  radius: (size) => NIBS[size],
  strength: () => 1,
  sizes: ['Fine nib', 'Chisel nib', 'Mop marker'],
};

const ROLLERS = [0.08, 0.14, 0.22];

export const ROLLER: BrushSpec = {
  brush: Brush.Roller,
  reach: 0.3,
  radius: (size) => ROLLERS[size],
  strength: () => 0.92,
  sizes: ['Small roller', 'Roller', 'Wide roller'],
};

function canGeometry(): THREE.BufferGeometry {
  return merge([
    paint(new THREE.CylinderGeometry(0.033, 0.033, 0.19, 12), 0xdfe6e9),
    paint(new THREE.CylinderGeometry(0.0335, 0.0335, 0.07, 12).translate(0, 0.02, 0), 0xe0282e),
    paint(new THREE.CylinderGeometry(0.028, 0.033, 0.025, 12).translate(0, 0.107, 0), 0xb2bec3),
    paint(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 8).translate(0, 0.128, 0), 0x2d3436),
    box(0.012, 0.012, 0.018, 0, 0.13, -0.017, 0x2d3436),
  ]);
}

function markerGeometry(): THREE.BufferGeometry {
  return merge([
    paint(new THREE.CylinderGeometry(0.011, 0.011, 0.12, 10).rotateX(Math.PI / 2), 0x2d3436),
    paint(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 10).rotateX(Math.PI / 2).translate(0, 0, 0.05), 0xf5f3ee),
    paint(new THREE.CylinderGeometry(0.004, 0.009, 0.02, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.07), 0x16161a),
  ]);
}

function rollerGeometry(): THREE.BufferGeometry {
  return merge([
    paint(new THREE.CylinderGeometry(0.016, 0.016, 0.12, 8).rotateX(Math.PI / 2).translate(0, 0, 0.04), 0xe17055),
    box(0.008, 0.008, 0.2, 0, 0, -0.1, 0xb2bec3),
    box(0.008, 0.07, 0.008, 0, 0.035, -0.2, 0xb2bec3),
    paint(new THREE.CylinderGeometry(0.03, 0.03, 0.2, 12).rotateZ(Math.PI / 2).translate(0, 0.075, -0.2), 0xf5f3ee),
  ]);
}

export const SPRAY_CAN = new PaintTool(
  {
    name: 'Spray can',
    model: { build: canGeometry, length: 0.077 },
    grip: { tip: [0, 0.1, -0.045] },
    stash: [{ at: [0.24, -0.62, -0.02], pitch: 0 }],
    color: 0xe0282e,
    issued: 1,
    max: 1,
    laser: false,
  },
  SPRAY,
);

export const MARKER_PEN = new PaintTool(
  {
    name: 'Marker',
    model: { build: markerGeometry, length: 0.16 },
    grip: { tip: [0, 0, -0.09] },
    stash: [{ at: [-0.24, -0.62, -0.02], pitch: -Math.PI / 2 }],
    color: 0x2d3436,
    issued: 1,
    max: 1,
  },
  MARKER,
);

export const PAINT_ROLLER = new PaintTool(
  {
    name: 'Roller',
    model: { build: rollerGeometry, length: 0.31 },
    grip: { tip: [0, 0.075, -0.26] },
    stash: [{ at: [-0.2, -0.05, 0.22], pitch: Math.PI / 2 }],
    color: 0xf5f3ee,
    issued: 1,
    max: 1,
  },
  ROLLER,
);

export const TOOLS = new Toolbox<PaintTool>([SPRAY_CAN, MARKER_PEN, PAINT_ROLLER]);
