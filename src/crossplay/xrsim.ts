import * as THREE from 'three';
import { clamp } from './math';
import type { DesktopInput } from './input';
import { Btn, type Rig, type XrPoseSource } from './rig';

const v = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
/** Simulated right-hand positions relative to the head: held out, at the hip, over the shoulder. */
const REST = [0.2, -0.3, -0.35] as const;
const HIP = [0.22, -0.68, -0.05] as const;
const SHOULDER = [0.2, -0.12, 0.25] as const;

/**
 * A headset faked from the keyboard and mouse (?xrsim), so the VR frontend can be tried without one.
 * Mouse turns the head, arrow keys walk around a 3×3m room, C crouches. Controllers: WASD left stick,
 * Q/E right stick, left/right mouse the triggers, F = A, H = B, R = Y, X = right stick click, Space =
 * right grip, Shift = left grip. Hold G or B to reach the right hand down to your hip or back over your
 * shoulder, to try the holsters.
 */
export class SimulatedXr implements XrPoseSource {
  readonly mode = 'sim';
  private yaw = 0;
  private pitch = 0;

  constructor(private readonly input: DesktopInput) {}

  read(rig: Rig, dt: number): void {
    const { input } = this;
    const [mx, my] = input.consumeMouse();
    this.yaw -= mx * 0.0025;
    this.pitch = clamp(this.pitch - my * 0.0025, -1.4, 1.4);
    rig.headQuat.setFromEuler(euler.set(this.pitch, this.yaw, 0));
    const fwd = (input.down('ArrowUp') ? 1 : 0) - (input.down('ArrowDown') ? 1 : 0);
    const str = (input.down('ArrowRight') ? 1 : 0) - (input.down('ArrowLeft') ? 1 : 0);
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const head = rig.headLocal;
    head.x = clamp(head.x + (-s * fwd + c * str) * 1.2 * dt, -1.5, 1.5);
    head.z = clamp(head.z + (-c * fwd - s * str) * 1.2 * dt, -1.5, 1.5);
    head.y += ((input.down('KeyC') ? 1.0 : 1.65) - head.y) * Math.min(1, dt * 8);
    rig.camera.position.copy(head);
    rig.camera.quaternion.copy(rig.headQuat);

    const r = rig.right.object;
    const [rx, ry, rz] = input.down('KeyG') ? HIP : input.down('KeyB') ? SHOULDER : REST;
    r.position.copy(head).add(v.set(rx, ry, rz).applyEuler(euler.set(0, this.yaw, 0)));
    r.quaternion.copy(rig.headQuat);
    const l = rig.left.object;
    l.position.copy(head).add(v.set(-0.2, -0.4, -0.3).applyEuler(euler.set(0, this.yaw, 0)));
    l.quaternion.setFromEuler(euler.set(0.9, this.yaw, 0));

    const key = (code: string) => (input.down(code) ? 1 : 0);
    const { left, right } = rig;
    left.stickX = key('KeyD') - key('KeyA');
    left.stickY = key('KeyS') - key('KeyW');
    right.stickX = key('KeyE') - key('KeyQ');
    right.stickY = 0;
    right.trigger = input.mouse(0) ? 1 : 0;
    left.trigger = input.mouse(2) ? 1 : 0;
    right.squeeze = key('Space');
    left.squeeze = key('ShiftLeft');
    right.setButtons((right.trigger << Btn.Trigger) | (key('KeyX') << Btn.Stick) | (key('KeyF') << Btn.A) | (key('KeyH') << Btn.B));
    left.setButtons((left.trigger << Btn.Trigger) | (key('KeyR') << Btn.B));
  }
}
