import { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { PISTOL, RIFLE, SHOTGUN, SMG, SNIPER, TOOLS } from '../src/fps/arsenal';
import { Inventory } from '../src/fps/inventory';
import { Tool, Toolbox } from '../src/fps/tool';

const inventory = () => new Inventory(TOOLS);

describe('Inventory', () => {
  it('starts with a pair of pistols that never run dry', () => {
    const inv = inventory();
    expect(inv.current).toBe(PISTOL);
    expect(inv.count(PISTOL)).toBe(2);
    for (let i = 0; i < 1000; i++) inv.spend(PISTOL);
    expect(inv.current).toBe(PISTOL);
    expect(inv.charges()).toBe(Infinity);
    expect(inv.wants(PISTOL)).toBe(false);
  });

  it('switches to a new kind of tool, but not to a second one', () => {
    const inv = inventory();
    expect(inv.add(SMG, 50)).toEqual({ kept: true, count: 1, charges: 50 });
    expect(inv.current).toBe(SMG);
    inv.select(PISTOL);
    expect(inv.add(SMG, 50)).toEqual({ kept: true, count: 2, charges: 50 });
    expect(inv.current).toBe(PISTOL);
    expect(inv.count(SMG)).toBe(2);
    expect(inv.charges(SMG)).toBe(100);
  });

  it('carries two of a kind, then only takes their charges until full', () => {
    const inv = inventory();
    const max = SNIPER.charges!.max;
    inv.add(SNIPER, 5);
    inv.add(SNIPER, 5);
    expect(inv.count(SNIPER)).toBe(SNIPER.max);
    expect(inv.add(SNIPER, max)).toEqual({ kept: false, count: 2, charges: max - 10 });
    expect(inv.charges(SNIPER)).toBe(max);
    expect(inv.wants(SNIPER)).toBe(false);
    expect(inv.add(SNIPER, 1)).toEqual({ kept: false, count: 2, charges: 0 });
  });

  it('still wants a second gun when the ammo is already full', () => {
    const inv = inventory();
    inv.add(RIFLE, 1000);
    expect(inv.wants(RIFLE)).toBe(true);
    expect(inv.add(RIFLE, 30)).toEqual({ kept: true, count: 2, charges: 0 });
  });

  it('loses every tool of a kind when their shared charges run out', () => {
    const inv = inventory();
    inv.add(SHOTGUN, 1);
    inv.add(SHOTGUN, 1);
    expect(inv.spend(SHOTGUN)).toBe(false);
    expect(inv.count(SHOTGUN)).toBe(2);
    expect(inv.spend(SHOTGUN)).toBe(true);
    expect(inv.has(SHOTGUN)).toBe(false);
    expect(inv.current).toBe(PISTOL);
  });

  it('spends charges of a tool that is not the current one', () => {
    const inv = inventory();
    inv.add(SMG, 1);
    inv.select(PISTOL);
    inv.spend(SMG);
    expect(inv.has(SMG)).toBe(false);
    expect(inv.current).toBe(PISTOL);
  });

  it('cycles through carried kinds in both directions', () => {
    const inv = inventory();
    inv.add(RIFLE, 10);
    inv.add(SMG, 10);
    inv.select(PISTOL);
    expect(inv.cycle(1)).toBe(SMG);
    expect(inv.cycle(1)).toBe(RIFLE);
    expect(inv.cycle(1)).toBe(PISTOL);
    expect(inv.cycle(-1)).toBe(RIFLE);
    expect(inv.select(SNIPER)).toBe(false);
  });

  it('hands over the current kind and its charges to drop, and everything else when cleared', () => {
    const inv = inventory();
    expect(inv.takeCurrent()).toBeNull();
    inv.add(RIFLE, 30);
    inv.add(RIFLE, 30);
    expect(inv.takeCurrent()).toEqual({ tool: RIFLE, charges: 60 });
    expect(inv.current).toBe(PISTOL);
    expect(inv.has(RIFLE)).toBe(false);

    inv.add(SMG, 10);
    inv.add(SNIPER, 5);
    expect(inv.clear()).toEqual([
      { tool: SMG, charges: 10 },
      { tool: SNIPER, charges: 5 },
    ]);
    expect(inv.current).toBe(PISTOL);
  });

  it('works without issued tools, and with tools that never run out', () => {
    const wand = new Tool({ name: 'Wand', model: { build: () => new BufferGeometry(), length: 0.3 }, grip: { tip: [0, 0, -0.3] }, color: 0 });
    const inv = new Inventory(new Toolbox([wand]));
    expect(inv.current).toBeNull();
    expect(inv.charges()).toBe(0);
    expect(inv.cycle(1)).toBeNull();
    expect(inv.add(wand, 0)).toEqual({ kept: true, count: 1, charges: 0 });
    expect(inv.current).toBe(wand);
    expect(inv.charges()).toBe(Infinity);
    expect(inv.spend(wand)).toBe(false);
    inv.add(wand, 0);
    expect(inv.wants(wand)).toBe(false);
    expect(inv.takeCurrent()).toEqual({ tool: wand, charges: 0 });
    expect(inv.current).toBeNull();
  });
});
