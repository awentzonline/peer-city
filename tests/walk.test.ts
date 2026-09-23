import { describe, expect, it } from 'vitest';
import { FlowPaths, keepApart, spotNear, turnToward, walkMemory, walkToward, type WalkGrid } from '../src/engine/index';

/** A 16x16 room with a wall down the middle, open at the bottom. */
const SIZE = 16;
const grid: WalkGrid = {
  size: SIZE,
  open: (i, j) => i > 0 && j > 0 && i < SIZE - 1 && j < SIZE - 1 && !(i === 8 && j < SIZE - 3),
  nearestOpen: (x, y) => {
    const i = Math.min(SIZE - 2, Math.max(1, Math.floor(x)));
    const j = Math.min(SIZE - 2, Math.max(1, Math.floor(y)));
    return { x: (i === 8 ? 9 : i) + 0.5, y: j + 0.5 };
  },
};

/** Slide a point, stopping at anything solid. */
function move(p: { x: number; y: number }, dx: number, dy: number): boolean {
  const nx = p.x + dx;
  const ny = p.y + dy;
  if (grid.open(Math.floor(nx), Math.floor(ny))) {
    p.x = nx;
    p.y = ny;
    return false;
  }
  return true;
}

describe('FlowPaths', () => {
  it('counts walking steps round the wall, and marks what can never be reached', () => {
    const paths = new FlowPaths(grid);
    const field = paths.field(2.5, 2.5);
    expect(field[2 * SIZE + 2]).toBe(0);
    expect(field[2 * SIZE + 3]).toBe(1);
    // the other side of the wall is reached by going under it
    expect(field[2 * SIZE + 13]).toBe(11 + 11 + 11);
    expect(field[0]).toBe(0xffff);
    expect(field[5 * SIZE + 8]).toBe(0xffff);
  });

  it('walks a body from one side of the wall to the other', () => {
    const paths = new FlowPaths(grid, { maxAgeMs: 700 });
    const p = { x: 2.5, y: 2.5, angle: 0 };
    const mem = walkMemory();
    const ground = { paths, move, turnRate: 8 };
    let arrived = false;
    for (let i = 0; i < 2000 && !arrived; i++) {
      walkToward(ground, p, mem, 13.5, 2.5, 0.3, 2, 0.05, i * 50, true);
      arrived = Math.hypot(13.5 - p.x, 2.5 - p.y) < 0.3;
    }
    expect(arrived).toBe(true);
    expect(paths.next(2.5, 2.5, 2.5, 8.5, 0.3)).toEqual({ x: 2.5, y: 8.5 });
    expect(paths.clearWalk(2.5, 2.5, 13.5, 2.5, 0.3)).toBe(false);
  });

  it('remakes a stale field when the grid changes, and keeps a field on one that never does', () => {
    let blocked = false;
    const changing: WalkGrid = { ...grid, open: (i, j) => grid.open(i, j) && !(blocked && j >= SIZE - 3) };
    const paths = new FlowPaths(changing, { maxAgeMs: 100 });
    expect(paths.field(2.5, 2.5, 0)[2 * SIZE + 13]).not.toBe(0xffff);
    blocked = true;
    expect(paths.field(2.5, 2.5, 50)[2 * SIZE + 13]).not.toBe(0xffff);
    expect(paths.field(2.5, 2.5, 200)[2 * SIZE + 13]).toBe(0xffff);
    const fixed = new FlowPaths(grid);
    expect(fixed.field(2.5, 2.5)).toBe(fixed.field(2.5, 2.5, 1e9));
  });
});

describe('Walking', () => {
  it('turns the short way round', () => {
    const p = { x: 0, y: 0, angle: 0.1 };
    turnToward(p, -0.1, 1, 1);
    expect(p.angle).toBeCloseTo(-0.1);
    p.angle = Math.PI - 0.1;
    turnToward(p, -Math.PI + 0.1, 1, 1);
    expect(p.angle).toBeCloseTo(Math.PI + 0.1);
  });

  it('picks a spot nearby that passes, or gives up', () => {
    const spot = spotNear(5.5, 5.5, 3, (x, y) => grid.open(Math.floor(x), Math.floor(y)));
    expect(spot && Math.hypot(spot.x - 5.5, spot.y - 5.5)).toBeLessThan(6);
    expect(spotNear(5.5, 5.5, 3, () => false)).toBeNull();
  });

  it('pushes overlapping bodies apart, leaving the fallen where they lie', () => {
    const bodies = [
      { x: 5, y: 5, state: { x: 5, y: 5, angle: 0 }, up: true },
      { x: 5.2, y: 5, state: { x: 5.2, y: 5, angle: 0 }, up: true },
      { x: 5.1, y: 5.1, state: { x: 5.1, y: 5.1, angle: 0 }, up: false },
    ];
    keepApart(
      { move },
      bodies,
      () => bodies,
      () => 0.3,
      (b) => b.up,
    );
    expect(bodies[0].state.x).toBeLessThan(5);
    expect(bodies[1].state.x).toBeGreaterThan(5.2);
    expect(bodies[2].state).toEqual({ x: 5.1, y: 5.1, angle: 0 });
  });
});
