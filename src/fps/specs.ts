import type { HumanLook } from '../crossplay/models';
import { CarKind } from './defs';

/** Physical dimensions shared by simulation and rendering. Meters; car-local x forward, y up, z right. */
export interface CarSpec {
  length: number;
  width: number;
  floor: number;
  /** Top of the doors and hood. */
  belt: number;
  roof: number;
  cabinRear: number;
  cabinFront: number;
  /** Vans: everything behind the cabin is a closed cargo box up to the roof. */
  cargo: boolean;
  wheelR: number;
  maxSpeed: number;
  /** Driver's eye position. */
  eye: [number, number, number];
}

const SEDAN: CarSpec = {
  length: 4.6,
  width: 1.9,
  floor: 0.3,
  belt: 1.0,
  roof: 1.5,
  cabinRear: -1.25,
  cabinFront: 0.75,
  cargo: false,
  wheelR: 0.34,
  maxSpeed: 30,
  eye: [-0.35, 1.28, -0.4],
};

const SPECS: CarSpec[] = [];
SPECS[CarKind.Sedan] = SEDAN;
SPECS[CarKind.Taxi] = SEDAN;
SPECS[CarKind.Police] = { ...SEDAN, length: 4.8, width: 1.95, maxSpeed: 34 };
SPECS[CarKind.Sport] = {
  length: 4.4,
  width: 1.9,
  floor: 0.25,
  belt: 0.82,
  roof: 1.22,
  cabinRear: -1.15,
  cabinFront: 0.45,
  cargo: false,
  wheelR: 0.33,
  maxSpeed: 38,
  eye: [-0.55, 1.06, -0.4],
};
SPECS[CarKind.Van] = {
  length: 5.2,
  width: 2.1,
  floor: 0.35,
  belt: 1.15,
  roof: 2.2,
  cabinRear: 0.1,
  cabinFront: 1.45,
  cargo: true,
  wheelR: 0.38,
  maxSpeed: 24,
  eye: [0.75, 1.75, -0.45],
};

export function carSpec(kind: number): CarSpec {
  return SPECS[kind] ?? SEDAN;
}

/** Collision half-extents of a car's footprint. */
export function carExtents(kind: number): { hl: number; hw: number } {
  const s = carSpec(kind);
  return { hl: s.length / 2 - 0.1, hw: s.width / 2 - 0.05 };
}

export const CAR_COLORS = [0xc0392b, 0x2e86de, 0x27ae60, 0x8e44ad, 0xecf0f1, 0x34495e, 0xe67e22, 0x16a085];

const SHIRTS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xecf0f1, 0x1abc9c, 0xe67e22, 0x34495e, 0xff6b81];
const PANTS = [0x2c3e50, 0x3b3b44, 0x5d4037, 0x1f2a44, 0x6d6d6d, 0x8d7b5a];
const SKIN_TONES = [0xf5d0a9, 0xe0ac69, 0xc68642, 0x8d5524, 0x5c3a1e];
const HAIR = [0x2c1b0e, 0x6b4423, 0xd4a017, 0x1a1a1a, 0xa52a2a, 0xbbbbbb];
export const PED_SKINS = 30;
export const COP_SKINS = 6;

export function humanLook(skin: number, cop: boolean): HumanLook {
  return {
    shirt: cop ? 0x23346e : SHIRTS[skin % SHIRTS.length],
    pants: cop ? 0x151c33 : PANTS[(skin * 5) % PANTS.length],
    skin: SKIN_TONES[(skin * 7) % SKIN_TONES.length],
    hair: HAIR[(skin * 3) % HAIR.length],
    ...(cop ? { hat: 0x1f2a52, badge: 0xffd54a } : {}),
  };
}
