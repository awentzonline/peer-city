import * as THREE from 'three';
import type { BodyState } from './avatar';
import { clamp, headingToYaw, signedAngle } from './math';
import { EYE } from './avatar';
import { HUMAN, setToolModel, type HumanRig } from './models';
import { Platform } from './platform';
import { NO_TOOL, type Tool, type Toolbox } from './tool';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const shoulder = new THREE.Vector3();
const reach = new THREE.Vector3();

/** How another peer's avatar (or an NPC) is drawn: a human rig, its walk cycle, and the tools in its hands. */
export interface BodyView {
  rig: HumanRig;
  lastX: number;
  lastY: number;
  phase: number;
  speed: number;
  /** Ids of the tool models currently in the right and left hands. */
  tools: [number, number];
}

export function bodyView(rig: HumanRig, x: number, y: number): BodyView {
  return { rig, lastX: x, lastY: y, phase: Math.random() * 6, speed: 0, tools: [NO_TOOL, NO_TOOL] };
}

/** Walk cycle from how far the rendered position moved; returns the limb swing angle. */
export function stride(v: BodyView, x: number, y: number, dt: number): number {
  const moved = Math.hypot(x - v.lastX, y - v.lastY);
  v.lastX = x;
  v.lastY = y;
  const speed = moved / Math.max(dt, 0.001);
  v.speed += ((speed > 15 ? 0 : speed) - v.speed) * Math.min(1, dt * 8);
  v.phase += v.speed * dt * 2.2;
  return Math.min(v.speed / 4, 1) * 0.65 * Math.sin(v.phase);
}

/** Point an arm from its shoulder at a target given in root space. */
export function aimArm(r: HumanRig, heading: number, target: THREE.Vector3, left = false): void {
  shoulder.set(0, HUMAN.shoulder * r.body.scale.y, left ? -HUMAN.shoulderZ : HUMAN.shoulderZ).applyAxisAngle(UP, -heading);
  reach.copy(target).sub(shoulder).applyAxisAngle(UP, heading);
  if (reach.lengthSq() < 1e-4) return;
  (left ? r.armL : r.armR).quaternion.setFromUnitVectors(DOWN, reach.normalize());
}

/**
 * Put a replicated hand's tool in place and point that arm at it. The hand's pose is replicated, and the
 * model turns in it by the tool's grip. An empty hand only reaches out for headset players, whose hands are
 * really tracked; otherwise the arm is left swinging.
 */
export function holdTool(v: BodyView, heading: number, side: 0 | 1, tool: Tool<any> | null, x: number, y: number, z: number, aimYaw: number, aimPitch: number, tracked: boolean): void {
  const r = v.rig;
  const group = side ? r.toolL : r.tool;
  if (tool && v.tools[side] !== tool.id) {
    v.tools[side] = tool.id;
    setToolModel(group, tool);
  }
  group.visible = !!tool;
  if (!tool && !tracked) return;
  group.position.set(x, z, y);
  group.rotation.set(signedAngle(aimPitch), headingToYaw(aimYaw), 0);
  aimArm(r, heading, group.position, side === 1);
}

/**
 * Pose a standing avatar from its replicated body: crouching, head pitch, the walk cycle, and each hand
 * holding its tool where it's replicated. Place `rig.root` at the feet first; (x, y) is its rendered position.
 */
export function poseBody(v: BodyView, s: BodyState, x: number, y: number, dt: number, tools: Toolbox<any>): void {
  const r = v.rig;
  r.body.rotation.set(0, -s.yaw, 0);
  r.body.position.y = 0;
  r.body.scale.y = clamp(s.head / EYE, 0.55, 1.15); // headset players crouching for real
  r.head.rotation.set(0, 0, clamp(signedAngle(s.pitch), -0.9, 0.9));
  const swing = stride(v, x, y, dt);
  r.legL.rotation.z = swing;
  r.legR.rotation.z = -swing;
  r.armL.rotation.set(0, 0, -swing * 0.8);
  r.armR.rotation.set(0, 0, swing * 0.8);
  r.shadow.visible = true;
  const tracked = s.platform === Platform.Vr;
  holdTool(v, s.yaw, 0, tools.get(s.tool), s.hx, s.hy, s.hz, s.aimYaw, s.aimPitch, tracked);
  holdTool(v, s.yaw, 1, tools.get(s.ltool), s.lhx, s.lhy, s.lhz, s.laimYaw, s.laimPitch, tracked);
}
