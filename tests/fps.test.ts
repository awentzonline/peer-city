import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { City, TILE } from '../src/fps/city';
import { Rig } from '../src/fps/rig';

const TAU = Math.PI * 2;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

describe('City.raycast3D', () => {
  const city = new City(20260914);
  // a building with open ground directly to its west
  const b = city.buildings.find((bd) => bd.height > 8 && city.heightAt(bd.tx - 1, bd.ty) === 0 && !city.isSolidTile(bd.tx - 1, bd.ty))!;
  const oy = (b.ty + 0.5) * TILE;
  const ox = b.tx * TILE - 1.5;

  it('stops at a wall below the roofline', () => {
    expect(city.raycast3D(ox, oy, 1.5, 1, 0, 0, 500)).toBeCloseTo(1.5, 5);
  });

  it('passes over a roof', () => {
    const d = city.raycast3D(ox, oy, b.height + 2, 1, 0, 0, 500);
    expect(d).toBeGreaterThan(1.5 + b.tw * TILE);
  });

  it('hits the roof when shooting down onto it', () => {
    const cx = (b.tx + b.tw / 2) * TILE;
    expect(city.raycast3D(cx, oy, b.height + 10, 0, 0, -1, 500)).toBeCloseTo(10, 5);
  });

  it('hits the ground', () => {
    const k = Math.SQRT1_2;
    // aim down-west, away from the building, from 2m up
    expect(city.raycast3D(ox, oy, 2, -k * 0.05, 0, -Math.sqrt(1 - 0.05 * 0.05 * 0.5), 500)).toBeLessThan(2.1);
  });
});

describe('Rig (room-scale VR)', () => {
  const setup = () => {
    const rig = new Rig(new THREE.Scene(), 1);
    rig.setMode('vr');
    rig.headLocal.set(0.7, 1.7, -0.4);
    rig.headQuat.setFromEuler(new THREE.Euler(0.1, 0.8, 0, 'YXZ'));
    return rig;
  };
  const head = (rig: Rig) => rig.head({ x: 0, y: 0, z: 0 });

  it('places the head over a ground point', () => {
    const rig = setup();
    rig.placeHeadAt(100, 200);
    const h = head(rig);
    expect(h.x).toBeCloseTo(100, 6);
    expect(h.y).toBeCloseTo(200, 6);
    expect(h.z).toBeCloseTo(1.7, 6);
  });

  it('snap turns about the head', () => {
    const rig = setup();
    rig.placeHeadAt(100, 200);
    const before = rig.headHeading();
    rig.rotateAroundHead(0.7);
    const h = head(rig);
    expect(h.x).toBeCloseTo(100, 6);
    expect(h.y).toBeCloseTo(200, 6);
    // a positive three.js yaw turns left, i.e. the ground heading decreases
    expect(wrap(rig.headHeading() - before + 0.7)).toBeCloseTo(0, 6);
  });

  it('seats the calibrated head at the driver eye, facing forward', () => {
    const rig = setup();
    rig.seatIn(50, 60, 1.28, 0.9);
    let h = head(rig);
    expect(h.x).toBeCloseTo(50, 6);
    expect(h.y).toBeCloseTo(60, 6);
    expect(h.z).toBeCloseTo(1.28, 6);
    expect(wrap(rig.headHeading() - 0.9)).toBeCloseTo(0, 6);

    // the car turns and moves; the seat follows while the calibration holds
    rig.seatIn(70, 65, 1.28, 2.1);
    h = head(rig);
    expect(h.x).toBeCloseTo(70, 6);
    expect(h.y).toBeCloseTo(65, 6);
    expect(wrap(rig.headHeading() - 2.1)).toBeCloseTo(0, 6);

    // leaning forward in real life moves the head forward in the car
    rig.headLocal.add(new THREE.Vector3(0, 0, -0.2).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.8, 0))));
    rig.seatIn(70, 65, 1.28, 2.1);
    h = head(rig);
    expect(h.x - 70).toBeCloseTo(Math.cos(2.1) * 0.2, 6);
    expect(h.y - 65).toBeCloseTo(Math.sin(2.1) * 0.2, 6);
  });
});
