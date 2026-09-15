import type { AssetName } from './assets';
import type { SoundName } from './sfx';

/** Weapons, in slot order (number keys 1-5). Replicated as a uint8 on players, pickups and shots. */
export const enum Weapon {
  Pistol = 0,
  Smg = 1,
  Shotgun = 2,
  Rifle = 3,
  Sniper = 4,
}

export interface WeaponSpec {
  name: string;
  asset: AssetName;
  /** Which way the barrel points down the model's Z axis once exported to glTF. */
  barrel: 1 | -1;
  /** Overall length in meters. */
  length: number;
  /** Where the hand holds it: the muzzle is this far forward and up of the grip, in meters. */
  muzzle: { forward: number; up: number };
  fireMs: number;
  range: number;
  body: number;
  head: number;
  car: number;
  /** Bullets per shot, fanned out within `spread` radians. */
  pellets: number;
  spread: number;
  /** Rounds in a pickup, and the most you can carry. Pistol ammo is unlimited. */
  ammo: number;
  maxAmmo: number;
  /** Recoil strength, 1 = pistol. */
  kick: number;
  sound: SoundName;
  /** Pickup glow and minimap colour. */
  color: number;
}

export const WEAPONS: readonly WeaponSpec[] = [
  {
    name: 'Pistol',
    asset: 'pistol',
    barrel: 1,
    length: 0.2,
    muzzle: { forward: 0.2, up: 0.025 },
    fireMs: 160,
    range: 160,
    body: 22,
    head: 60,
    car: 8,
    pellets: 1,
    spread: 0,
    ammo: 0,
    maxAmmo: 0,
    kick: 1,
    sound: 'shot',
    color: 0xffffff,
  },
  {
    name: 'SMG',
    asset: 'smg',
    barrel: -1,
    length: 0.62,
    muzzle: { forward: 0.36, up: 0.04 },
    fireMs: 80,
    range: 110,
    body: 14,
    head: 35,
    car: 5,
    pellets: 1,
    spread: 0.035,
    ammo: 120,
    maxAmmo: 360,
    kick: 0.6,
    sound: 'rifle',
    color: 0x4fc3ff,
  },
  {
    name: 'Shotgun',
    asset: 'shotgun',
    barrel: -1,
    length: 0.75,
    muzzle: { forward: 0.55, up: 0.05 },
    fireMs: 850,
    range: 45,
    body: 14,
    head: 30,
    car: 5,
    pellets: 8,
    spread: 0.09,
    ammo: 16,
    maxAmmo: 48,
    kick: 2.2,
    sound: 'shotgun',
    color: 0xff9f43,
  },
  {
    name: 'Assault Rifle',
    asset: 'rifle',
    barrel: -1,
    length: 0.88,
    muzzle: { forward: 0.62, up: 0.05 },
    fireMs: 110,
    range: 200,
    body: 26,
    head: 70,
    car: 10,
    pellets: 1,
    spread: 0.012,
    ammo: 90,
    maxAmmo: 270,
    kick: 0.9,
    sound: 'rifle',
    color: 0xff5252,
  },
  {
    name: 'Sniper Rifle',
    asset: 'sniper',
    barrel: -1,
    length: 1.1,
    muzzle: { forward: 0.78, up: 0.05 },
    fireMs: 1200,
    range: 400,
    body: 90,
    head: 250,
    car: 35,
    pellets: 1,
    spread: 0,
    ammo: 10,
    maxAmmo: 30,
    kick: 2.5,
    sound: 'sniper',
    color: 0xb388ff,
  },
];

export function weaponSpec(w: number): WeaponSpec {
  return WEAPONS[w] ?? WEAPONS[Weapon.Pistol];
}

/** The guns a player is carrying and their ammo. The pistol is always there and never runs dry. */
export class Inventory {
  current: Weapon = Weapon.Pistol;
  private readonly rounds = new Map<Weapon, number>();

  has(w: Weapon): boolean {
    return w === Weapon.Pistol || this.rounds.has(w);
  }

  ammo(w: Weapon = this.current): number {
    return w === Weapon.Pistol ? Infinity : (this.rounds.get(w) ?? 0);
  }

  /** Whether picking up this gun would add anything. */
  wants(w: Weapon): boolean {
    return w !== Weapon.Pistol && !!WEAPONS[w] && (this.rounds.get(w) ?? 0) < WEAPONS[w].maxAmmo;
  }

  /** Picks up a gun or its ammo, switching to it if it's new. Returns the rounds actually added (0 when full). */
  add(w: Weapon, ammo: number): number {
    if (!this.wants(w) || ammo <= 0) return 0;
    const had = this.rounds.get(w);
    const total = Math.min(WEAPONS[w].maxAmmo, (had ?? 0) + ammo);
    this.rounds.set(w, total);
    if (had === undefined) this.current = w;
    return total - (had ?? 0);
  }

  /** Uses one round. A gun that runs dry is dropped for the pistol. */
  consume(): void {
    const w = this.current;
    if (w === Weapon.Pistol) return;
    const left = this.ammo(w) - 1;
    if (left > 0) {
      this.rounds.set(w, left);
      return;
    }
    this.rounds.delete(w);
    this.current = Weapon.Pistol;
  }

  select(w: Weapon): boolean {
    if (!this.has(w)) return false;
    this.current = w;
    return true;
  }

  /** Switch to the next (+1) or previous (-1) gun carried. */
  cycle(dir: 1 | -1): Weapon {
    const n = WEAPONS.length;
    for (let i = 1; i < n; i++) {
      const w = (((this.current + dir * i) % n) + n) % n;
      if (this.has(w)) return (this.current = w);
    }
    return this.current;
  }

  /** Takes the current gun out of the inventory with its ammo, e.g. to drop it. Null for the pistol. */
  takeCurrent(): { weapon: Weapon; ammo: number } | null {
    const w = this.current;
    if (w === Weapon.Pistol) return null;
    const ammo = this.ammo(w);
    this.rounds.delete(w);
    this.current = Weapon.Pistol;
    return { weapon: w, ammo };
  }

  clear(): void {
    this.rounds.clear();
    this.current = Weapon.Pistol;
  }
}
