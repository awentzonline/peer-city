import * as THREE from 'three';
import { clamp } from '../crossplay/math';
import { Platform } from '../crossplay/platform';
import { Btn, type Rig, type XrPoseSource } from '../crossplay/rig';
import { VrSettings } from '../crossplay/settingsPanel';
import { SnapTurn, deadzone } from '../crossplay/vrControls';
import type { HauntContext, Vec3 } from './context';
import type { HauntFrontend, HauntRole } from './haunt';
import { HauntMarker, hauntUsed } from './hauntDesktop';
import { Power, idleHauntIntent, stillHaunt, type HauntIntent } from './intent';
import { FENCE_MAX, FENCE_MIN, START } from './manor';
import { Wrist } from './wrist';

/** How high over the house you stand, m, and how high you can go. */
const START_HEIGHT = 20;
const MIN_HEIGHT = 8;
const MAX_HEIGHT = 45;
const TRIGGER = 0.6;
const ARM_CYCLE: (Power | 'none')[] = [Power.Shade, Power.Crawler, Power.Brute, Power.Whisper, 'none'];

const LASER_FROM = new THREE.Vector3(0, 0, -0.05);

/**
 * The Haunt in a headset: a giant standing over the house in the night sky, looking down through its open roof and
 * reaching into it with a laser. The left stick walks you over the grounds, the right snap-turns (left and right) and
 * raises or lowers you (up and down). Point the right hand: the trigger uses the armed power there, or picks out a
 * monster, or sends the ones picked out; the grip sends them. A cycles the powers, B picks out all, the left trigger
 * gathers those near where you point, and Y opens the settings. The watch shows your dread.
 */
export class VrHaunt implements HauntFrontend {
  readonly platform = Platform.Vr;
  private readonly intent = idleHauntIntent();
  private readonly turn = new SnapTurn();
  private readonly wrist: Wrist;
  private readonly menu: VrSettings;
  private readonly marker: HauntMarker;
  private readonly laser: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private height = START_HEIGHT;
  private readonly pos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly head: Vec3 = { x: 0, y: 0, z: 0 };
  private refusal = { text: '', until: 0 };
  private placed = false;

  constructor(
    private readonly ctx: HauntContext,
    private readonly role: HauntRole,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
    scene: THREE.Scene,
  ) {
    rig.setMode(source.mode);
    this.wrist = new Wrist(rig, ctx.hud, 'haunt');
    this.menu = new VrSettings(ctx.settings, rig);
    this.marker = new HauntMarker(ctx, scene);
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
    this.laser = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xb46bff, transparent: true, opacity: 0.7, depthWrite: false, fog: false }));
    this.laser.position.copy(LASER_FROM);
    rig.right.object.add(this.laser);
    ctx.hud.message('You loom over the house. Point with your right hand; A picks a power, the trigger uses it.');
  }

  dispose(): void {
    this.wrist.dispose();
    this.menu.dispose();
    this.marker.dispose();
    this.laser.removeFromParent();
    this.laser.geometry.dispose();
    this.laser.material.dispose();
  }

  read(dt: number): HauntIntent {
    const { rig, intent } = this;
    this.source.read(rig, dt);
    stillHaunt(intent);
    const { left, right } = rig;
    if (!this.placed) {
      // over the yard, looking at the house
      this.placed = true;
      rig.placeHeadAt(START.x, START.y - 6);
    }
    if (left.pressed(Btn.B)) this.menu.toggle();
    const onMenu = this.menu.update(this.ctx.now);

    // walking over the grounds, turning, and rising or sinking
    const heading = rig.headHeading();
    const sx = deadzone(left.stickX);
    const sy = -deadzone(left.stickY);
    const speed = (6 + this.height * 0.5) * dt;
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    rig.shift((c * sy - s * sx) * speed, (s * sy + c * sx) * speed);
    this.turn.update(rig, right.stickX);
    this.height = clamp(this.height - deadzone(right.stickY) * 12 * dt, MIN_HEIGHT, MAX_HEIGHT);
    rig.root.position.y = this.height;
    rig.head(this.head);
    const cx = clamp(this.head.x, FENCE_MIN - 10, FENCE_MAX + 10);
    const cy = clamp(this.head.y, FENCE_MIN - 10, FENCE_MAX + 10);
    if (cx !== this.head.x || cy !== this.head.y) rig.shift(cx - this.head.x, cy - this.head.y);

    // where the right hand points on the ground
    let ground: { x: number; y: number } | null = null;
    if (right.connected) {
      rig.handPose(right, LASER_FROM, this.pos, this.dir);
      if (this.dir.z < -0.02) {
        const k = -this.pos.z / this.dir.z;
        ground = { x: this.pos.x + this.dir.x * k, y: this.pos.y + this.dir.y * k };
        this.laser.scale.z = Math.min(200, k);
      } else {
        this.laser.scale.z = 30;
      }
    }
    this.laser.visible = right.connected && !onMenu;
    intent.pointer = ground;
    intent.focus.x = ground?.x ?? cx;
    intent.focus.y = ground?.y ?? cy;
    intent.reach = ground ? 1.4 + Math.hypot(ground.x - this.pos.x, ground.y - this.pos.y, this.pos.z) * 0.03 : 1.5;
    if (onMenu) return intent;

    intent.primary = right.trigger >= TRIGGER && right.pressed(Btn.Trigger);
    intent.secondary = right.pressed(Btn.Squeeze);
    intent.gather = left.pressed(Btn.Trigger);
    intent.selectAll = right.pressed(Btn.B);
    if (right.pressed(Btn.A)) {
      const i = this.role.armed === null ? -1 : ARM_CYCLE.indexOf(this.role.armed);
      const next = ARM_CYCLE[(i + 1) % ARM_CYCLE.length];
      intent.arm = next === 'none' ? 'none' : next;
      this.ctx.sfx.play('arm');
    }
    return intent;
  }

  present(): void {
    const { ctx, role } = this;
    this.marker.update(this.intent.pointer, role);
    const p = this.intent.pointer;
    ctx.sfx.setListener(p ? { x: p.x, y: p.y, z: 1.7 } : this.head, { x: Math.cos(this.rig.headHeading()), y: Math.sin(this.rig.headHeading()), z: 0 });
    ctx.hud.showHaunt(ctx, role, { place: 'Trigger where it should come through', pick: 'Trigger on your monsters', send: 'Grip', bar: '' }, ctx.now < this.refusal.until ? this.refusal.text : '');
    this.wrist.update(ctx);
  }

  used(power: Power): void {
    hauntUsed(this.ctx, power);
    this.rig.right.pulse(0.5, 60);
  }

  refused(reason: string): void {
    this.refusal = { text: reason, until: this.ctx.now + 1800 };
    this.ctx.sfx.play('nope');
    this.rig.right.pulse(0.2, 30);
  }

  ordered(x: number, y: number, attack: boolean): void {
    this.marker.ping(x, y, attack);
    this.rig.right.pulse(0.3, 30);
  }

  glared(by: string): void {
    this.rig.flash(0xffffff, 0.9);
    this.rig.left.pulse(1, 250);
    this.rig.right.pulse(1, 250);
    this.ctx.hud.showBanner('THE LIGHT!', '#fff4c0', 1800);
    this.ctx.hud.message(`${by} drove you back with their light`);
    this.ctx.sfx.play('glare');
  }
}
