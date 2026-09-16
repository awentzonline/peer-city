import { describe, expect, it } from 'vitest';
import { FIRE, TOUCH_TUNING, TouchInput } from '../src/crossplay/touch';

const R = TOUCH_TUNING.stickRadius;

/** A finger that goes down, drags, and lifts. Times are milliseconds, as the pointer events give them. */
function walk(t: TouchInput, dx: number, dy: number, id = 1): void {
  t.pointerDown(id, 100, 300, 'stick', 0);
  t.pointerMove(id, 100 + dx, 300 + dy);
}

describe('touch walk stick', () => {
  it('walks in the direction the thumb pushes, forward being up the screen', () => {
    const t = new TouchInput();
    walk(t, 0, -R);
    expect(t.stick.y).toBeCloseTo(1, 5);
    expect(t.stick.x).toBeCloseTo(0, 5);
    const t2 = new TouchInput();
    walk(t2, R, 0);
    expect(t2.stick.x).toBeCloseTo(1, 5);
  });

  it('ignores a thumb that barely moves, and runs when it is pushed to the edge', () => {
    const t = new TouchInput();
    walk(t, 0, -R * TOUCH_TUNING.deadzone * 0.9);
    expect(t.stick.y).toBe(0);
    expect(t.run).toBe(false);
    t.pointerMove(1, 100, 300 - R);
    expect(t.run).toBe(true);
  });

  it('never walks faster than full throw, and the origin follows a thumb dragged past it', () => {
    const t = new TouchInput();
    walk(t, 0, -R * 3);
    expect(Math.hypot(t.stick.x, t.stick.y)).toBeCloseTo(1, 5);
    // Easing back by the throw from where the thumb is now stops the stick, rather than still walking.
    t.pointerMove(1, 100, 300 - R * 3 + R);
    expect(t.stick.y).toBeCloseTo(0, 5);
  });

  it('lets go of a touch the phone took away without ending it', () => {
    const t = new TouchInput();
    walk(t, 0, -R);
    expect(t.stick.y).toBeCloseTo(1, 5);
    // The same id comes back as a new finger, which means the old one is gone however it went.
    t.pointerDown(1, 400, 300, 'stick', 100);
    expect(t.stick.y).toBe(0);
    t.pointerMove(1, 400, 300 - R);
    expect(t.stick.y).toBeCloseTo(1, 5);
  });

  it('stops when the thumb lifts, and hands over to a thumb already down', () => {
    const t = new TouchInput();
    walk(t, 0, -R);
    t.pointerDown(2, 200, 320, 'stick', 10);
    t.pointerUp(1, 20);
    expect(t.stick.y).toBeCloseTo(0, 5); // the second thumb hasn't pushed anywhere yet
    t.pointerMove(2, 200, 320 - R);
    expect(t.stick.y).toBeCloseTo(1, 5);
    t.pointerUp(2, 30);
    expect(t.stick.y).toBe(0);
    expect(t.stickPose.active).toBe(false);
  });
});

describe('touch look and fire', () => {
  it('turns by how far the thumb dragged, once', () => {
    const t = new TouchInput();
    t.pointerDown(1, 500, 200, 'look', 0);
    t.pointerMove(1, 540, 180);
    expect(t.consumeLook()).toEqual([40, -20]);
    expect(t.consumeLook()).toEqual([0, 0]);
  });

  it('fires on a quick tap, but not on a drag or a long hold', () => {
    const t = new TouchInput();
    t.pointerDown(1, 500, 200, 'look', 0);
    t.pointerUp(1, 100);
    expect(t.pressed(FIRE)).toBe(true);
    t.endFrame();
    expect(t.pressed(FIRE)).toBe(false);

    t.pointerDown(2, 500, 200, 'look', 0);
    t.pointerMove(2, 560, 200);
    t.pointerUp(2, 100);
    expect(t.pressed(FIRE)).toBe(false);

    t.pointerDown(3, 500, 200, 'look', 0);
    t.pointerUp(3, 1000);
    expect(t.pressed(FIRE)).toBe(false);
  });

  it('lets a second finger tap to fire while the first keeps aiming', () => {
    const t = new TouchInput();
    t.pointerDown(1, 500, 200, 'look', 0);
    t.pointerDown(2, 600, 300, 'look', 10);
    t.pointerUp(2, 60);
    expect(t.pressed(FIRE)).toBe(true);
    t.pointerMove(1, 520, 200);
    expect(t.consumeLook()).toEqual([20, 0]);
  });

  it('a second finger does not turn the view', () => {
    const t = new TouchInput();
    t.pointerDown(1, 500, 200, 'look', 0);
    t.pointerDown(2, 600, 300, 'look', 10);
    t.pointerMove(2, 700, 300);
    expect(t.consumeLook()).toEqual([0, 0]);
  });
});

describe('touch buttons', () => {
  it('are held down until released, and press once per frame', () => {
    const t = new TouchInput();
    t.press('jump');
    expect(t.pressed('jump')).toBe(true);
    expect(t.down('jump')).toBe(true);
    t.endFrame();
    expect(t.pressed('jump')).toBe(false);
    expect(t.down('jump')).toBe(true);
    t.release('jump');
    expect(t.down('jump')).toBe(false);
  });

  it('let go of everything when the page does', () => {
    const t = new TouchInput();
    t.press(FIRE);
    walk(t, 0, -R, 3);
    t.clear();
    expect(t.down(FIRE)).toBe(false);
    expect(t.stick.y).toBe(0);
  });
});
