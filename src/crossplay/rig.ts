import * as THREE from 'three';
import { clamp, headingToYaw, yawToHeading, type Vec3 } from './math';

/**
 * - desktop: mouse-look camera, positioned from the player's state each frame.
 * - vr: a WebXR headset drives the camera and controllers.
 * - sim: desktop stand-in for a headset (?xrsim, see xrsim.ts), for testing room-scale logic without one.
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

/** Fills in a rig's head and controller poses each frame, from a headset or something standing in for one. */
export interface XrPoseSource {
  readonly mode: Exclude<RigMode, 'desktop'>;
  read(rig: Rig, dt: number): void;
}

/** A WebXR headset, read from the frame three.js is rendering. */
export class WebXrPoses implements XrPoseSource {
  readonly mode = 'vr';

  constructor(private readonly xr: THREE.WebXRManager) {}

  read(rig: Rig): void {
    // three.js only has a frame inside the session's animation callback, so background steps read nothing
    const frame = this.xr.getFrame();
    const space = this.xr.getReferenceSpace();
    if (frame && space) rig.readXR(frame, space);
  }
}

const v = new THREE.Vector3();
const FORWARD = new THREE.Vector3(0, 0, -1);

/**
 * The player's physical frame of reference. `root` is the play-space origin in
 * the world (the floor of your room); the headset and controllers move inside
 * it. Room-scale walking moves the head within the root, and game code keeps
 * the head out of walls by shifting the root back (see AvatarSim and VrAvatar).
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
    if (mode === 'sim') this.headLocal.set(0, 1.65, 0);
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

  /** World position of a point in a controller's space, and of a direction in it: by default, where the controller points. */
  handPose(hand: XRHand, local: THREE.Vector3, pos: Vec3, dir: Vec3, forward: THREE.Vector3 = FORWARD): void {
    this.root.updateMatrixWorld();
    const m = hand.object.matrixWorld;
    v.copy(local).applyMatrix4(m);
    pos.x = v.x;
    pos.y = v.z;
    pos.z = v.y;
    v.copy(forward).transformDirection(m);
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
