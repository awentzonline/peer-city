import { describe, expect, it } from 'vitest';
import { Inventory, MAX_OF_A_KIND, WEAPONS, Weapon } from '../src/fps/arsenal';

describe('Inventory', () => {
  it('starts with a pair of pistols that never run dry', () => {
    const inv = new Inventory();
    expect(inv.current).toBe(Weapon.Pistol);
    expect(inv.count(Weapon.Pistol)).toBe(2);
    for (let i = 0; i < 1000; i++) inv.consume();
    expect(inv.current).toBe(Weapon.Pistol);
    expect(inv.ammo()).toBe(Infinity);
    expect(inv.wants(Weapon.Pistol)).toBe(false);
  });

  it('switches to a new kind of gun, but not to a second one', () => {
    const inv = new Inventory();
    expect(inv.add(Weapon.Smg, 50)).toEqual({ gun: true, rounds: 50 });
    expect(inv.current).toBe(Weapon.Smg);
    inv.select(Weapon.Pistol);
    expect(inv.add(Weapon.Smg, 50)).toEqual({ gun: true, rounds: 50 });
    expect(inv.current).toBe(Weapon.Pistol);
    expect(inv.count(Weapon.Smg)).toBe(2);
    expect(inv.ammo(Weapon.Smg)).toBe(100);
  });

  it('carries two of a kind, then only takes their ammo until full', () => {
    const inv = new Inventory();
    const max = WEAPONS[Weapon.Sniper].maxAmmo;
    inv.add(Weapon.Sniper, 5);
    inv.add(Weapon.Sniper, 5);
    expect(inv.count(Weapon.Sniper)).toBe(MAX_OF_A_KIND);
    expect(inv.add(Weapon.Sniper, max)).toEqual({ gun: false, rounds: max - 10 });
    expect(inv.ammo(Weapon.Sniper)).toBe(max);
    expect(inv.wants(Weapon.Sniper)).toBe(false);
    expect(inv.add(Weapon.Sniper, 1)).toEqual({ gun: false, rounds: 0 });
  });

  it('still wants a second gun when the ammo is already full', () => {
    const inv = new Inventory();
    inv.add(Weapon.Rifle, 1000);
    expect(inv.wants(Weapon.Rifle)).toBe(true);
    expect(inv.add(Weapon.Rifle, 30)).toEqual({ gun: true, rounds: 0 });
  });

  it('loses every gun of a kind when their shared ammo runs out', () => {
    const inv = new Inventory();
    inv.add(Weapon.Shotgun, 1);
    inv.add(Weapon.Shotgun, 1);
    inv.consume(Weapon.Shotgun);
    expect(inv.count(Weapon.Shotgun)).toBe(2);
    inv.consume(Weapon.Shotgun);
    expect(inv.has(Weapon.Shotgun)).toBe(false);
    expect(inv.current).toBe(Weapon.Pistol);
  });

  it('spends ammo from a gun that is not the current one', () => {
    const inv = new Inventory();
    inv.add(Weapon.Smg, 1);
    inv.select(Weapon.Pistol);
    inv.consume(Weapon.Smg);
    expect(inv.has(Weapon.Smg)).toBe(false);
    expect(inv.current).toBe(Weapon.Pistol);
  });

  it('cycles through carried kinds in both directions', () => {
    const inv = new Inventory();
    inv.add(Weapon.Rifle, 10);
    inv.add(Weapon.Smg, 10);
    inv.select(Weapon.Pistol);
    expect(inv.cycle(1)).toBe(Weapon.Smg);
    expect(inv.cycle(1)).toBe(Weapon.Rifle);
    expect(inv.cycle(1)).toBe(Weapon.Pistol);
    expect(inv.cycle(-1)).toBe(Weapon.Rifle);
    expect(inv.select(Weapon.Sniper)).toBe(false);
  });

  it('hands over the current kind and its ammo to drop', () => {
    const inv = new Inventory();
    expect(inv.takeCurrent()).toBeNull();
    inv.add(Weapon.Rifle, 30);
    inv.add(Weapon.Rifle, 30);
    expect(inv.takeCurrent()).toEqual({ weapon: Weapon.Rifle, ammo: 60 });
    expect(inv.current).toBe(Weapon.Pistol);
    expect(inv.has(Weapon.Rifle)).toBe(false);
  });
});
