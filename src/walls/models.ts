import { buildHuman, type HumanRig } from '../crossplay/models';

const HOODIES = [0x2d3436, 0xe17055, 0x0984e3, 0x6c5ce7, 0x00b894, 0xfdcb6e, 0xd63031, 0x636e72, 0xe84393, 0x55efc4];
const PANTS = [0x2d3436, 0x34495e, 0x4a4238, 0x3d5a80];
const SKINS = [0xf5d0a9, 0xe0ac69, 0xc68642, 0x8d5524, 0x5c3a1e];
const HAIR = [0x2c1b0e, 0x6b4423, 0xd4a017, 0x1a1a1a, 0xa52a2a, 0xbbbbbb];

/** A painter: a hoodie, and a beanie on every third. */
export function painterRig(skin: number): HumanRig {
  return buildHuman({
    shirt: HOODIES[skin % HOODIES.length],
    pants: PANTS[(skin * 5) % PANTS.length],
    skin: SKINS[(skin * 7) % SKINS.length],
    hair: HAIR[(skin * 3) % HAIR.length],
    hat: skin % 3 === 0 ? HOODIES[(skin + 4) % HOODIES.length] : undefined,
  });
}
