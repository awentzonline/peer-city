import * as THREE from 'three';
import { clamp, headingToYaw, yawToHeading, type Vec3 } from './context';
import type { DesktopInput } from './input';

/**
 * - desktop: mouse-look camera, positioned from the player's state each frame.
 * - vr: a WebXR headset drives the camera and controllers.
 * - sim: desktop stand-in for a headset (?xrsim), for testing room-scale logic without one.
 */
export type RigMode = 'desktop' | 'vr' | 'sim';

/** xr-standard gamepad button indices. */
export const enum Btn {
  Trigger = 0,
  Squeeze = 1,
  Stick = 3,
  A = 4, // X on the left controller
  B = 5, // Y on the left controller
}

export class XRHand {
  /** Target-ray pose in rig space (-Z points where the controller points). */
  readonly object = new THREE.Group();
  connected = false;
  trigger = 0;
  squeeze = 0;
  stickX = 0;
  stickY = 0;
  source: XRInputSource | null = null;
  private buttons = 0;
  private prevButtons = 0;

  constructor(readonly handedness: 'left' | 'right') {}

  setButtons(mask: number): void {
    this.prevButtons = this.buttons;
    this.buttons = mask;
  }

  down(b: number): boolean {
    return (this.buttons & (1 << b)) !== 0;
  }

  pressed(b: number): boolean {
    return (this.buttons & ~this.prevButtons & (1 << b)) !== 0;
  }

  pulse(intensity: number, ms: number): void {
    const gp = this.source?.gamepad as (Gamepad & { hapticActuators?: { pulse?: (v: number, ms: number) => void }[] }) | undefined;
    try {
      gp?.hapticActuators?.[0]?.pulse?.(intensity, ms);
    } catch {
      /* haptics unsupported */
    }
  }
}

const v = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const FORWARD = new THREE.Vector3(0, 0, -1);
/** Simulated right-hand positions relative to the head: held out, at the hip, over the shoulder. */
const SIM_REST = [0.2, -0.3, -0.35] as const;
const SIM_HIP = [0.22, -0.68, -0.05] as const;
const SIM_SHOULDER = [0.2, -0.12, 0.25] as const;

/**
 * The player's physical frame of reference. `root` is the play-space origin in
 * the world (the floor of your room); the headset and controllers move inside
 * it. Room-scale walking moves the head within the root, and game code keeps
 * the head out of walls by shifting the root back (see PlayerController).
 */
export class Rig {
  readonly root = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  readonly left = new XRHand('left');
  readonly right = new XRHand('right');
  mode: RigMode = 'desktop';
  /** Head pose in rig space. */
  readonly headLocal = new THREE.Vector3(0, 1.65, 0);
  readonly headQuat = new THREE.Quaternion();
  /** Root height while on foot; raised when the headset only offers a 'local' (non-floor) space. */
  floorY = 0;
  private seat: { yaw: number; x: number; y: number; z: number } | null = null;
  private shakeAmt = 0;
  private readonly overlay: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private overlayBase = 0;
  private simYaw = 0;
  private simPitch = 0;

  constructor(scene: THREE.Scene, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(72, aspect, 0.05, 1500);
    this.camera.rotation.order = 'YXZ';
    this.root.add(this.camera, this.left.object, this.right.object);
    scene.add(this.root);
    // Full-view colour wash for damage and death; works in a headset where CSS can't.
    this.overlay = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false }),
    );
    this.overlay.renderOrder = 1000;
    this.overlay.frustumCulled = false;
    this.overlay.visible = false;
    this.camera.add(this.overlay);
  }

  get xr(): boolean {
    return this.mode !== 'desktop';
  }

  setMode(mode: RigMode): void {
    this.mode = mode;
    this.seat = null;
    this.root.position.set(0, mode === 'desktop' ? 0 : this.floorY, 0);
    this.root.rotation.set(0, 0, 0);
    this.camera.position.set(0, 1.65, 0);
    this.camera.quaternion.identity();
    this.left.connected = this.right.connected = mode === 'sim';
    if (mode === 'sim') {
      this.headLocal.set(0, 1.65, 0);
      this.simYaw = this.simPitch = 0;
    }
  }

  /** Read headset and controller poses for this XR frame. */
  readXR(frame: XRFrame, space: XRReferenceSpace): void {
    const pose = frame.getViewerPose(space);
    if (pose) {
      const p = pose.transform.position;
      const o = pose.transform.orientation;
      this.headLocal.set(p.x, p.y, p.z);
      this.headQuat.set(o.x, o.y, o.z, o.w);
    }
    this.left.connected = this.right.connected = false;
    const sources = frame.session.inputSources;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const hand = source.handedness === 'left' ? this.left : source.handedness === 'right' ? this.right : null;
      if (!hand) continue;
      hand.source = source;
      const rp = frame.getPose(source.targetRaySpace, space);
      if (rp) {
        hand.connected = true;
        hand.object.matrix.fromArray(rp.transform.matrix);
        hand.object.matrix.decompose(hand.object.position, hand.object.quaternion, hand.object.scale);
      }
      const gp = source.gamepad;
      if (!gp) continue;
      hand.trigger = gp.buttons[Btn.Trigger]?.value ?? 0;
      hand.squeeze = gp.buttons[Btn.Squeeze]?.value ?? 0;
      const ax = gp.axes.length >= 4 ? 2 : 0;
      hand.stickX = gp.axes[ax] ?? 0;
      hand.stickY = gp.axes[ax + 1] ?? 0;
      let mask = 0;
      for (let b = 0; b < gp.buttons.length && b < 8; b++) if (gp.buttons[b].pressed) mask |= 1 << b;
      hand.setButtons(mask);
    }
  }

  /**
   * Simulated headset: mouse turns the head, arrow keys walk around a 3×3m
   * room, C crouches. Controllers: WASD left stick, Q/E right stick, left/right
   * mouse the triggers, F = A, H = B, R = Y, X = right stick click, Space = right grip,
   * Shift = left grip. Hold G or B to reach the right hand down to your hip or back
   * over your shoulder, to try the holsters.
   */
  readSim(input: DesktopInput, dt: number): void {
    const [mx, my] = input.consumeMouse();
    this.simYaw -= mx * 0.0025;
    this.simPitch = clamp(this.simPitch - my * 0.0025, -1.4, 1.4);
    this.headQuat.setFromEuler(euler.set(this.simPitch, this.simYaw, 0));
    const fwd = (input.down('ArrowUp') ? 1 : 0) - (input.down('ArrowDown') ? 1 : 0);
    const str = (input.down('ArrowRight') ? 1 : 0) - (input.down('ArrowLeft') ? 1 : 0);
    const c = Math.cos(this.simYaw);
    const s = Math.sin(this.simYaw);
    this.headLocal.x = clamp(this.headLocal.x + (-s * fwd + c * str) * 1.2 * dt, -1.5, 1.5);
    this.headLocal.z = clamp(this.headLocal.z + (-c * fwd - s * str) * 1.2 * dt, -1.5, 1.5);
    this.headLocal.y += ((input.down('KeyC') ? 1.0 : 1.65) - this.headLocal.y) * Math.min(1, dt * 8);
    this.camera.position.copy(this.headLocal);
    this.camera.quaternion.copy(this.headQuat);

    const r = this.right.object;
    const [rx, ry, rz] = input.down('KeyG') ? SIM_HIP : input.down('KeyB') ? SIM_SHOULDER : SIM_REST;
    r.position.copy(this.headLocal).add(v.set(rx, ry, rz).applyEuler(euler.set(0, this.simYaw, 0)));
    r.quaternion.copy(this.headQuat);
    const l = this.left.object;
    l.position.copy(this.headLocal).add(v.set(-0.2, -0.4, -0.3).applyEuler(euler.set(0, this.simYaw, 0)));
    l.quaternion.setFromEuler(euler.set(0.9, this.simYaw, 0));

    const key = (code: string) => (input.down(code) ? 1 : 0);
    this.left.stickX = key('KeyD') - key('KeyA');
    this.left.stickY = key('KeyS') - key('KeyW');
    this.right.stickX = key('KeyE') - key('KeyQ');
    this.right.stickY = 0;
    this.right.trigger = input.mouse(0) ? 1 : 0;
    this.left.trigger = input.mouse(2) ? 1 : 0;
    this.right.squeeze = key('Space');
    this.left.squeeze = key('ShiftLeft');
    this.right.setButtons((this.right.trigger << Btn.Trigger) | (key('KeyX') << Btn.Stick) | (key('KeyF') << Btn.A) | (key('KeyH') << Btn.B));
    this.left.setButtons((this.left.trigger << Btn.Trigger) | (key('KeyR') << Btn.B));
  }

  /** Head position in world axes. */
  head(out: Vec3): Vec3 {
    if (this.mode === 'desktop') {
      v.copy(this.camera.position);
    } else {
      this.root.updateMatrixWorld();
      v.copy(this.headLocal).applyMatrix4(this.root.matrixWorld);
    }
    out.x = v.x;
    out.y = v.z;
    out.z = v.y;
    return out;
  }

  /** Yaw of the headset within the play space. */
  headLocalYaw(): number {
    v.copy(FORWARD).applyQuaternion(this.headQuat);
    return Math.atan2(-v.x, -v.z);
  }

  /** Ground heading the headset faces. */
  headHeading(): number {
    return yawToHeading(this.root.rotation.y + this.headLocalYaw());
  }

  headPitch(): number {
    v.copy(FORWARD).applyQuaternion(this.headQuat);
    return Math.asin(clamp(v.y, -1, 1));
  }

  /** World position of a point in a controller's space, and the controller's pointing direction. */
  handPose(hand: XRHand, local: THREE.Vector3, pos: Vec3, dir: Vec3): void {
    this.root.updateMatrixWorld();
    const m = hand.object.matrixWorld;
    v.copy(local).applyMatrix4(m);
    pos.x = v.x;
    pos.y = v.z;
    pos.z = v.y;
    v.copy(FORWARD).transformDirection(m);
    dir.x = v.x;
    dir.y = v.z;
    dir.z = v.y;
  }

  /** Move the play space so the head is above (x, y). */
  placeHeadAt(x: number, y: number): void {
    const h = this.head({ x: 0, y: 0, z: 0 });
    this.root.position.x += x - h.x;
    this.root.position.z += y - h.y;
  }

  shift(dx: number, dy: number): void {
    this.root.position.x += dx;
    this.root.position.z += dy;
  }

  /** Snap turn: spin the play space about the head so the head stays put. */
  rotateAroundHead(delta: number): void {
    const h = this.head({ x: 0, y: 0, z: 0 });
    const px = this.root.position.x - h.x;
    const pz = this.root.position.z - h.y;
    const c = Math.cos(delta);
    const s = Math.sin(delta);
    this.root.rotation.y += delta;
    this.root.position.x = h.x + px * c + pz * s;
    this.root.position.z = h.y - px * s + pz * c;
  }

  /**
   * Seat a headset in a car: the head pose at the moment you sit down becomes
   * the driver's eye, facing forward, whatever your real height and room
   * position. `recenter()` recalibrates from the current pose.
   */
  seatIn(x: number, y: number, eyeZ: number, heading: number): void {
    this.seat ??= { yaw: this.headLocalYaw(), x: this.headLocal.x, y: this.headLocal.y, z: this.headLocal.z };
    const seat = this.seat;
    const yaw = headingToYaw(heading) - seat.yaw;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    this.root.rotation.set(0, yaw, 0);
    this.root.position.set(x - (seat.x * c + seat.z * s), eyeZ - seat.y, y - (-seat.x * s + seat.z * c));
  }

  recenter(): void {
    this.seat = null;
  }

  leaveSeat(): void {
    this.seat = null;
    this.root.position.y = this.floorY;
  }

  /** Desktop first-person camera. */
  setDesktopView(x: number, y: number, z: number, heading: number, pitch: number): void {
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    const j = this.shakeAmt;
    this.camera.position.set(x + (Math.random() - 0.5) * j, z + (Math.random() - 0.5) * j, y + (Math.random() - 0.5) * j);
    this.camera.rotation.set(pitch, headingToYaw(heading), 0);
  }

  /** Desktop third-person camera. */
  setDesktopChase(from: Vec3, to: Vec3): void {
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.camera.position.set(from.x, from.z, from.y);
    this.camera.lookAt(to.x, to.z, to.y);
  }

  flash(color: number, alpha: number): void {
    this.overlay.material.color.setHex(color);
    this.overlay.material.opacity = Math.max(this.overlay.material.opacity, alpha);
  }

  /** A persistent wash (e.g. while dead). */
  setTint(color: number, alpha: number): void {
    if (alpha > 0) this.overlay.material.color.setHex(color);
    this.overlayBase = alpha;
  }

  /** Camera shake. Desktop only: moving the view against your head's will is nauseating in VR. */
  shake(amount: number): void {
    if (this.mode === 'desktop') this.shakeAmt = Math.max(this.shakeAmt, amount);
  }

  update(dt: number): void {
    const m = this.overlay.material;
    m.opacity = this.overlayBase + (m.opacity - this.overlayBase) * Math.exp(-dt * 4);
    this.overlay.visible = m.opacity > 0.01;
    this.shakeAmt *= Math.exp(-dt * 8);
  }
}
