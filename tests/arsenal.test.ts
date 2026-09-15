import { describe, expect, it } from 'vitest';
import { Inventory, WEAPONS, Weapon } from '../src/fps/arsenal';

describe('Inventory', () => {
  it('starts with a pistol that never runs dry', () => {
    const inv = new Inventory();
    expect(inv.current).toBe(Weapon.Pistol);
    for (let i = 0; i < 1000; i++) inv.consume();
    expect(inv.current).toBe(Weapon.Pistol);
    expect(inv.ammo()).toBe(Infinity);
  });

  it('switches to a new gun, but not to more ammo for one already carried', () => {
    const inv = new Inventory();
    expect(inv.add(Weapon.Smg, 50)).toBe(50);
    expect(inv.current).toBe(Weapon.Smg);
    inv.select(Weapon.Pistol);
    expect(inv.add(Weapon.Smg, 50)).toBe(50);
    expect(inv.current).toBe(Weapon.Pistol);
    expect(inv.ammo(Weapon.Smg)).toBe(100);
  });

  it('caps ammo and turns down pickups once full', () => {
    const inv = new Inventory();
    const max = WEAPONS[Weapon.Sniper].maxAmmo;
    inv.add(Weapon.Sniper, max - 2);
    expect(inv.add(Weapon.Sniper, 10)).toBe(2);
    expect(inv.ammo(Weapon.Sniper)).toBe(max);
    expect(inv.wants(Weapon.Sniper)).toBe(false);
    expect(inv.add(Weapon.Sniper, 1)).toBe(0);
    expect(inv.wants(Weapon.Pistol)).toBe(false);
  });

  it('drops an empty gun for the pistol', () => {
    const inv = new Inventory();
    inv.add(Weapon.Shotgun, 2);
    inv.consume();
    expect(inv.current).toBe(Weapon.Shotgun);
    inv.consume();
    expect(inv.current).toBe(Weapon.Pistol);
    expect(inv.has(Weapon.Shotgun)).toBe(false);
  });

  it('cycles through carried guns in both directions', () => {
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

  it('hands over the current gun to drop', () => {
    const inv = new Inventory();
    expect(inv.takeCurrent()).toBeNull();
    inv.add(Weapon.Rifle, 30);
    expect(inv.takeCurrent()).toEqual({ weapon: Weapon.Rifle, ammo: 30 });
    expect(inv.current).toBe(Weapon.Pistol);
    expect(inv.has(Weapon.Rifle)).toBe(false);
  });
});
