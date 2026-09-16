/**
 * What racers are made of. A racer's design is a set of parts, each filling one cell of a grid around the
 * seat, and replicates as a compact blob (`Racer.design`). Everything here is plain data and runs headless:
 * encoding, where a new part may go, which parts still hang together after a crash.
 *
 * Racer space: +X forward, +Y left, +Z up, meters from the middle of the seat's cell.
 */

/** Size of a grid cell, meters. */
export const CELL = 0.5;
/** Most parts a racer can have, the seat included. Also the size of the broken-parts mask. */
export const MAX_PARTS = 64;
/** How far from the seat parts may go, in cells, on each axis. */
export const EXTENT = { x: 6, y: 5, z: [-3, 6] as const };

export const enum PartKind {
  Seat = 0,
  Block = 1,
  Wheel = 2,
  BigWheel = 3,
  Ballast = 4,
  Rocket = 5,
  Wing = 6,
  Balloon = 7,
  Bumper = 8,
  Runner = 9,
}

/** A face of a cell, and the direction it faces: +X, -X, +Y, -Y, +Z, -Z. */
export const enum Dir {
  PX = 0,
  NX = 1,
  PY = 2,
  NY = 3,
  PZ = 4,
  NZ = 5,
}

export const DIRS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export function dirOf(dx: number, dy: number, dz: number): Dir {
  if (dx) return dx > 0 ? Dir.PX : Dir.NX;
  if (dy) return dy > 0 ? Dir.PY : Dir.NY;
  return dz > 0 ? Dir.PZ : Dir.NZ;
}

export interface PartSpec {
  name: string;
  /** One line on what it does, for the HUD. */
  blurb: string;
  color: number;
  /** kg. */
  mass: number;
  /** Contact force (N) that tears it off. Infinity for never. */
  strength: number;
  /** Collider friction and bounciness: what it's like to scrape along the ground on it. */
  friction: number;
  restitution: number;
  /** Nothing can be attached to it. */
  leaf: boolean;
  wheel?: { radius: number; width: number };
  /** Newtons pushed out of the opposite side to the one it faces, while boosting. */
  thrust?: number;
  /** Newtons of lift per (m/s)², up in racer space. */
  lift?: number;
  /** Newtons pulling up in the world. */
  buoyancy?: number;
}

export const PARTS: Record<PartKind, PartSpec> = {
  [PartKind.Seat]: {
    name: 'Seat',
    blurb: 'Where you sit. Everything is built out from it.',
    color: 0xc0392b,
    mass: 25,
    strength: Infinity,
    friction: 0.6,
    restitution: 0.1,
    leaf: false,
  },
  [PartKind.Block]: {
    name: 'Crate',
    blurb: 'A wooden frame block to build out from.',
    color: 0xb58a57,
    mass: 6,
    strength: 120_000,
    friction: 0.5,
    restitution: 0.1,
    leaf: false,
  },
  [PartKind.Wheel]: {
    name: 'Wheel',
    blurb: 'Rolls. Wheels in front of the middle steer.',
    color: 0x2b2b2b,
    mass: 5,
    strength: 50_000,
    friction: 0.8,
    restitution: 0.2,
    leaf: true,
    wheel: { radius: 0.3, width: 0.18 },
  },
  [PartKind.BigWheel]: {
    name: 'Big wheel',
    blurb: 'A tractor tyre: rides over bumps, heavy.',
    color: 0x3a3226,
    mass: 14,
    strength: 90_000,
    friction: 0.8,
    restitution: 0.2,
    leaf: true,
    wheel: { radius: 0.55, width: 0.3 },
  },
  [PartKind.Ballast]: {
    name: 'Anvil',
    blurb: 'Very heavy. Keeps you low and fast downhill.',
    color: 0x4a4f57,
    mass: 60,
    strength: 400_000,
    friction: 0.4,
    restitution: 0.02,
    leaf: false,
  },
  [PartKind.Rocket]: {
    name: 'Rocket',
    blurb: 'Hold boost to fire, pushing away from the side it points.',
    color: 0xd35400,
    mass: 8,
    strength: 40_000,
    friction: 0.5,
    restitution: 0.1,
    leaf: false,
    thrust: 1100,
  },
  [PartKind.Wing]: {
    name: 'Wing',
    blurb: 'Lifts you the faster you go. Glide off jumps.',
    color: 0xecf0f1,
    mass: 3,
    strength: 25_000,
    friction: 0.3,
    restitution: 0.1,
    leaf: false,
    lift: 0.28,
  },
  [PartKind.Balloon]: {
    name: 'Balloon',
    blurb: 'Pulls you up. Pops if it hits anything hard.',
    color: 0xe84393,
    mass: 0.5,
    strength: 4_000,
    friction: 0.2,
    restitution: 0.6,
    leaf: true,
    buoyancy: 160,
  },
  [PartKind.Bumper]: {
    name: 'Bumper',
    blurb: 'Rubber: bounces off walls and other racers.',
    color: 0xf1c40f,
    mass: 4,
    strength: 200_000,
    friction: 0.9,
    restitution: 0.95,
    leaf: false,
  },
  [PartKind.Runner]: {
    name: 'Ski',
    blurb: 'Slides with almost no friction. Build a sled.',
    color: 0x74b9ff,
    mass: 4,
    strength: 50_000,
    friction: 0.02,
    restitution: 0.05,
    leaf: false,
  },
};

/** What the part gun places, in the order it cycles through them. */
export const PLACEABLE: readonly PartKind[] = [
  PartKind.Block,
  PartKind.Wheel,
  PartKind.BigWheel,
  PartKind.Rocket,
  PartKind.Wing,
  PartKind.Balloon,
  PartKind.Ballast,
  PartKind.Bumper,
  PartKind.Runner,
];

export interface Part {
  x: number;
  y: number;
  z: number;
  kind: PartKind;
  /** The face of its neighbour it was put against: a wheel's axle points this way, a rocket's nozzle does too. */
  dir: Dir;
}

/** A racer's parts. The seat is always first, at the origin. */
export type Design = Part[];

const VERSION = 1;
const BYTES_PER_PART = 4;

export function starterDesign(): Design {
  return [
    { x: 0, y: 0, z: 0, kind: PartKind.Seat, dir: Dir.PZ },
    { x: 1, y: 0, z: 0, kind: PartKind.Block, dir: Dir.PX },
    { x: -1, y: 0, z: 0, kind: PartKind.Block, dir: Dir.NX },
    { x: 1, y: 1, z: 0, kind: PartKind.Wheel, dir: Dir.PY },
    { x: 1, y: -1, z: 0, kind: PartKind.Wheel, dir: Dir.NY },
    { x: -1, y: 1, z: 0, kind: PartKind.Wheel, dir: Dir.PY },
    { x: -1, y: -1, z: 0, kind: PartKind.Wheel, dir: Dir.NY },
  ];
}

/** A version byte, then four bytes a part: x, y and z offset by 128, then the kind and the face in a nibble each. */
export function encodeDesign(design: Design): Uint8Array {
  const n = Math.min(design.length, MAX_PARTS);
  const out = new Uint8Array(1 + n * BYTES_PER_PART);
  out[0] = VERSION;
  for (let i = 0; i < n; i++) {
    const p = design[i];
    const o = 1 + i * BYTES_PER_PART;
    out[o] = (p.x + 128) & 255;
    out[o + 1] = (p.y + 128) & 255;
    out[o + 2] = (p.z + 128) & 255;
    out[o + 3] = (p.kind << 4) | p.dir;
  }
  return out;
}

/** A design from its blob. Anything unreadable comes back as just a seat. */
export function decodeDesign(bytes: Uint8Array): Design {
  if (bytes.length < 1 + BYTES_PER_PART || bytes[0] !== VERSION) return [{ x: 0, y: 0, z: 0, kind: PartKind.Seat, dir: Dir.PZ }];
  const out: Design = [];
  for (let o = 1; o + BYTES_PER_PART <= bytes.length && out.length < MAX_PARTS; o += BYTES_PER_PART) {
    const kind = (bytes[o + 3] >> 4) as PartKind;
    const dir = (bytes[o + 3] & 15) as Dir;
    if (!(kind in PARTS) || dir > Dir.NZ) continue;
    out.push({ x: bytes[o] - 128, y: bytes[o + 1] - 128, z: bytes[o + 2] - 128, kind, dir });
  }
  if (!out.length || out[0].kind !== PartKind.Seat) out.unshift({ x: 0, y: 0, z: 0, kind: PartKind.Seat, dir: Dir.PZ });
  return out;
}

export function partAt(design: Design, x: number, y: number, z: number): number {
  for (let i = 0; i < design.length; i++) {
    const p = design[i];
    if (p.x === x && p.y === y && p.z === z) return i;
  }
  return -1;
}

export type PlaceProblem = 'full' | 'taken' | 'too far' | 'leaf' | null;

/** Why a part can't go in a cell next to `onto` (an index into the design), or null if it can. */
export function placeProblem(design: Design, onto: number, x: number, y: number, z: number): PlaceProblem {
  if (onto < 0 || onto >= design.length) return 'too far';
  if (PARTS[design[onto].kind].leaf) return 'leaf';
  if (design.length >= MAX_PARTS) return 'full';
  if (Math.abs(x) > EXTENT.x || Math.abs(y) > EXTENT.y || z < EXTENT.z[0] || z > EXTENT.z[1]) return 'too far';
  if (partAt(design, x, y, z) >= 0) return 'taken';
  return null;
}

export const PROBLEM_TEXT: Record<Exclude<PlaceProblem, null>, string> = {
  full: `A racer can only have ${MAX_PARTS} parts`,
  taken: 'Something is already there',
  'too far': 'Too far from the seat',
  leaf: "Nothing sticks to that part",
};

/** A design with a part added against a face of part `onto`, or null if it can't go there. */
export function withPart(design: Design, onto: number, dir: Dir, kind: PartKind): Design | null {
  if (kind === PartKind.Seat || !design[onto]) return null;
  const [dx, dy, dz] = DIRS[dir];
  const base = design[onto];
  const x = base.x + dx;
  const y = base.y + dy;
  const z = base.z + dz;
  if (placeProblem(design, onto, x, y, z)) return null;
  return [...design, { x, y, z, kind, dir }];
}

/**
 * A design without a part, and without anything that was only attached through it. The seat stays.
 * `removed` gets the indices (into the old design) that went.
 */
export function withoutPart(design: Design, index: number, removed: number[] = []): Design | null {
  if (index <= 0 || index >= design.length) return null;
  const gone = new Set([index]);
  const attached = connected(design, gone);
  const out: Design = [];
  design.forEach((p, i) => {
    if (attached[i]) out.push(p);
    else removed.push(i);
  });
  return out;
}

/**
 * Which parts still hang together with the seat, ignoring `missing` ones. Parts join face to face, but
 * nothing joins through a leaf (a wheel doesn't hold up what's beyond it).
 */
export function connected(design: Design, missing: ReadonlySet<number> | ((i: number) => boolean)): boolean[] {
  const isMissing = typeof missing === 'function' ? missing : (i: number) => missing.has(i);
  const n = design.length;
  const ok = new Array<boolean>(n).fill(false);
  if (!n || isMissing(0)) return ok;
  const index = new Map<number, number>();
  const key = (x: number, y: number, z: number) => ((x + 64) * 128 + (y + 64)) * 128 + (z + 64);
  design.forEach((p, i) => {
    if (!isMissing(i)) index.set(key(p.x, p.y, p.z), i);
  });
  ok[0] = true;
  const stack = [0];
  while (stack.length) {
    const i = stack.pop()!;
    const p = design[i];
    if (PARTS[p.kind].leaf) continue;
    for (const [dx, dy, dz] of DIRS) {
      const j = index.get(key(p.x + dx, p.y + dy, p.z + dz));
      if (j === undefined || ok[j]) continue;
      ok[j] = true;
      stack.push(j);
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Broken parts: a bit per part, replicated alongside the design
// ---------------------------------------------------------------------------

export const NO_BROKEN = new Uint8Array(0);

export function isBroken(mask: Uint8Array, i: number): boolean {
  return ((mask[i >> 3] ?? 0) & (1 << (i & 7))) !== 0;
}

/** A new mask with more parts broken. */
export function withBroken(mask: Uint8Array, parts: Iterable<number>): Uint8Array {
  const out = new Uint8Array(MAX_PARTS / 8);
  out.set(mask.subarray(0, out.length));
  for (const i of parts) if (i >= 0 && i < MAX_PARTS) out[i >> 3] |= 1 << (i & 7);
  return out;
}

/** Which parts are still on the racer: not broken, and still attached to the seat through parts that aren't. */
export function intact(design: Design, broken: Uint8Array): boolean[] {
  return connected(design, (i) => isBroken(broken, i));
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** Where a part's cell is in racer space. */
export function cellCenter(p: Part, out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
  out.x = p.x * CELL;
  out.y = p.y * CELL;
  out.z = p.z * CELL;
  return out;
}

export interface Stats {
  parts: number;
  mass: number;
  wheels: number;
  rockets: number;
  /** How far below the seat's middle the racer reaches, when resting on its wheels or its bottom. */
  bottom: number;
}

/** A wheel's middle hangs this far below its cell's middle, on its suspension. */
export const WHEEL_DROP = 0.15;

export function designStats(design: Design, keep: boolean[] | null = null): Stats {
  let mass = 0;
  let wheels = 0;
  let rockets = 0;
  let bottom = 0;
  let parts = 0;
  design.forEach((p, i) => {
    if (keep && !keep[i]) return;
    const spec = PARTS[p.kind];
    parts++;
    mass += spec.mass;
    if (spec.wheel) wheels++;
    if (spec.thrust) rockets++;
    const low = p.z * CELL - (spec.wheel ? WHEEL_DROP + spec.wheel.radius : CELL / 2);
    bottom = Math.min(bottom, low);
  });
  return { parts, mass, wheels, rockets, bottom };
}
