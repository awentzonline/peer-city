import * as THREE from 'three';
import type { EntityViews } from '@engine/index';
import { aimArm, bodyView, poseBody, stride, type BodyView } from '../crossplay/avatarView';
import { headingToYaw } from '../crossplay/math';
import { SOLID, disposeLabel, setLabel, type HumanRig } from '../crossplay/models';
import type { FiveEvent, SlapEvent, Shows } from './actions';
import type { BuddyEntity, HiContext, Vec3 } from './context';
import { Buddy, BuddyMode, Pal } from './defs';
import { FIELD } from './field';
import { GRADE_COLORS } from './hud';
import { BUDDY_SKIN, buddyRig, fistGeometry, handprintGeometry, palRig, palmGeometry, skinTone } from './models';
import { GRADE_NAMES, Grade, MOVE_NAMES, Move, clean, offerPose, posePoint, type HandPose } from './moves';
import type { PalRole } from './pal';
import { BUDDY_EYE, BUDDY_NAMES, offerPoint, palPartner, partnerButt, partnerById } from './partners';
import type { Scenery } from './scenery';

/** What the views need from the local player's frontend. */
export interface LocalView {
  /** Draw your own pal, e.g. from a chase camera. */
  showSelf(): boolean;
}

/** A body's two hands: an open palm and a fist each, one of them showing while the hand's out. */
interface Hands {
  palms: [THREE.Mesh, THREE.Mesh];
  fists: [THREE.Mesh, THREE.Mesh];
}

interface PalView extends BodyView, Hands {
  name: string;
  bubble: Bubble;
  print: THREE.Mesh;
}

interface BuddyView extends BodyView, Hands {
  mode: BuddyMode;
  since: number;
  bubble: Bubble;
  print: THREE.Mesh;
}

const HANDPRINT_MS = 25_000;
const rel = new THREE.Vector3();
const p1: Vec3 = { x: 0, y: 0, z: 0 };
const p2: Vec3 = { x: 0, y: 0, z: 0 };
const pose: HandPose = { f: 0, s: 0, z: 0 };

/**
 * Pals and buddies as everyone sees them, and every five and slap as it lands: the sparks, the word, the sound, and
 * the red handprint left on the seat of someone's shorts.
 */
export function registerViews(ctx: HiContext, views: EntityViews, scene: THREE.Scene, local: LocalView, scenery: Scenery, role: PalRole): { update(dt: number): void; shows: Shows } {
  const prints = new Map<number, number>();

  views.register(Pal, {
    create: (e): PalView => {
      const rig = palRig(e.state.skin);
      scene.add(rig.root);
      const skin = skinTone(e.state.skin);
      return { ...bodyView(rig, e.x, e.y), ...hands(rig, skin), name: '', bubble: new Bubble(rig.root, 2.85), print: handprint(rig) };
    },
    update: (view, e, dt) => {
      const s = e.render;
      const r = view.rig;
      const isMe = e === ctx.me;
      if (view.name !== s.name) {
        view.name = s.name;
        setLabel(r.label, s.name);
      }
      r.root.visible = !isMe || local.showSelf();
      r.label.visible = !isMe && !close(ctx, e.x, e.y);
      r.root.position.set(e.x, s.z, e.y);
      r.shadow.position.y = 0.04 - s.z;
      poseBody(view, s, e.x, e.y, dt, role.inventory.tools);
      // a flat player's arms reach wherever the rules put their hands (a headset's always do, in poseBody)
      const p = palPartner(e);
      for (const side of [0, 1] as const) {
        const out = !!(p.reach & (1 << side));
        const x = side ? s.lhx : s.hx;
        const y = side ? s.lhy : s.hy;
        const z = side ? s.lhz : s.hz;
        if (out) aimArm(r, s.yaw, rel.set(x, z, y), side === 1);
        showHand(view, side, out, !!(p.fists & (1 << side)), rel.set(x, z, y), s.yaw, z < p.eye * 0.6);
      }
      view.bubble.fresh(s.offer || s.yank);
      view.bubble.show(bubbleText(s.offer, s.yank));
      view.print.visible = ctx.now < (prints.get(e.id) ?? 0);
    },
    destroy: (view) => {
      scene.remove(view.rig.root);
      disposeLabel(view.rig.label);
      view.bubble.dispose();
    },
  });

  views.register(Buddy, {
    create: (e): BuddyView => {
      const rig = buddyRig(e.state.slot);
      scene.add(rig.root);
      setLabel(rig.label, BUDDY_NAMES[e.state.slot]);
      return { ...bodyView(rig, e.x, e.y), ...hands(rig, BUDDY_SKIN[e.state.slot]), mode: e.state.mode, since: ctx.now, bubble: new Bubble(rig.root, 2.85), print: handprint(rig) };
    },
    update: (view, e, dt) => {
      const s = e.render;
      const r = view.rig;
      if (s.mode !== view.mode) {
        view.mode = s.mode;
        view.since = ctx.now;
      }
      r.root.position.set(e.x, 0, e.y);
      r.label.visible = !close(ctx, e.x, e.y);
      const slapped = ctx.now < (prints.get(e.id) ?? 0);
      poseBuddy(ctx, view, e, dt, slapped);
      view.bubble.fresh(s.mode === BuddyMode.Offer ? s.offer : 0);
      view.bubble.show(s.mode === BuddyMode.Offer ? bubbleText(s.offer, Move.None) : s.mode === BuddyMode.Sneak ? '🤫' : '');
      view.print.visible = slapped;
    },
    destroy: (view) => {
      scene.remove(view.rig.root);
      disposeLabel(view.rig.label);
      view.bubble.dispose();
    },
  });

  const shows: Shows = {
    five: (e: FiveEvent) => {
      const { fx, sfx } = ctx;
      // the two in it have their banner; the word pops up for everyone watching
      const watching = !ctx.me || (ctx.me.id !== e.a && ctx.me.id !== e.b);
      const at = { x: e.x, y: e.y, z: e.z };
      const good = clean(e.grade);
      const color = GRADE_COLORS[e.grade];
      if (good) {
        fx.burst(e.x, e.y, e.z, parseInt(color.slice(1), 16), e.grade === Grade.Perfect ? 1 : e.grade === Grade.Great ? 0.6 : 0.3, e.grade === Grade.Perfect || e.streak >= 3);
        const pitch = 1 + Math.min(8, e.streak) * 0.06;
        if (e.move === Move.Fist) sfx.play('bump', at);
        else sfx.play(e.grade === Grade.Perfect ? 'perfect' : 'smack', at, 1, pitch);
        if (e.streak > 1) sfx.play('combo', at, 0.6, pitch);
        if (e.grade === Grade.Perfect && e.streak >= 3 && e.y > FIELD.y0) sfx.play('cheer', at);
        const word = e.move === Move.Fist && e.grade === Grade.Perfect ? 'BOOM!' : GRADE_NAMES[e.grade];
        if (watching) fx.pop(e.streak > 1 ? `${word} ×${e.streak}` : word, e.x, e.y, e.z, color, e.grade === Grade.Perfect, near(ctx, at));
      } else {
        sfx.play(e.grade === Grade.TooSlow ? 'tooslow' : e.grade === Grade.Awkward ? 'awkward' : 'whoosh', at);
        if (watching && e.grade !== Grade.Whiff) fx.pop(GRADE_NAMES[e.grade], e.x, e.y, e.z, color, e.grade === Grade.TooSlow, near(ctx, at));
      }
      const a = partnerById(ctx.world, e.a)?.name ?? 'Someone';
      const b = partnerById(ctx.world, e.b)?.name ?? 'someone';
      if (good) scenery.showFive(`${a} ✋ ${b}: ${MOVE_NAMES[e.move].toLowerCase()}, ${GRADE_NAMES[e.grade].toLowerCase()}${e.streak > 1 ? ` ×${e.streak}` : ''}`);
      else if (e.grade === Grade.TooSlow) scenery.showFive(`${b} left ${a} hanging. TOO SLOW!`);
    },
    slap: (e: SlapEvent) => {
      const at = { x: e.x, y: e.y, z: e.z };
      const watching = !ctx.me || (ctx.me.id !== e.a && ctx.me.id !== e.b);
      if (e.denied) {
        ctx.sfx.play('denied', at);
        if (watching) ctx.fx.pop('DENIED!', e.x, e.y, e.z + 0.6, '#6ab8ff', true, near(ctx, at));
        return;
      }
      ctx.sfx.play('slap', at);
      ctx.fx.burst(e.x, e.y, e.z, 0xff7ab8, 0.5, false);
      if (watching) ctx.fx.pop('SLAP!', e.x, e.y, e.z + 0.3, '#ff7ab8', true, near(ctx, at));
      prints.set(e.b, ctx.now + HANDPRINT_MS);
      const a = partnerById(ctx.world, e.a)?.name ?? 'Someone';
      const b = partnerById(ctx.world, e.b)?.name ?? 'someone';
      scenery.showFive(`${a} slapped ${b}'s backside!`);
    },
  };

  return {
    shows,
    update: (dt) => {
      ctx.fx.update(dt);
    },
  };
}

/** How big to pop a word at `at`: full size across the field, smaller in your face (your own banner says it too). */
function near(ctx: HiContext, at: Vec3): number {
  const ears = ctx.sfx.listenerAt;
  return Math.max(0.3, Math.min(1, Math.hypot(at.x - ears.x, at.y - ears.y, at.z - ears.z) / 4));
}

/** Near enough that a name tag over someone's head would fill the view (the HUD names whoever you're facing). */
function close(ctx: HiContext, x: number, y: number): boolean {
  const ears = ctx.sfx.listenerAt;
  return Math.hypot(x - ears.x, y - ears.y) < 2.6;
}

function hands(rig: HumanRig, skin: number): Hands {
  const mesh = (g: THREE.BufferGeometry) => {
    const m = new THREE.Mesh(g, SOLID);
    m.rotation.order = 'YXZ';
    m.visible = false;
    rig.root.add(m);
    return m;
  };
  return { palms: [mesh(palmGeometry(skin)), mesh(palmGeometry(skin))], fists: [mesh(fistGeometry(skin)), mesh(fistGeometry(skin))] };
}

/** The red handprint on the seat of someone's shorts, hidden until they're slapped. */
function handprint(rig: HumanRig): THREE.Mesh {
  const m = new THREE.Mesh(handprintGeometry(), SOLID);
  m.position.set(-0.126, 0.97, Math.random() < 0.5 ? -0.09 : 0.09);
  m.scale.setScalar(1.5);
  m.visible = false;
  rig.body.add(m);
  return m;
}

/**
 * Show one hand at `at` (root space, scene axes): a fist or an open palm facing the way they face, upright, or
 * palm up when it's held low.
 */
function showHand(h: Hands, side: 0 | 1, out: boolean, fist: boolean, at: THREE.Vector3, heading: number, low: boolean): void {
  const palm = h.palms[side];
  const knuckles = h.fists[side];
  palm.visible = out && !fist;
  knuckles.visible = out && fist;
  if (!out) return;
  const m = fist ? knuckles : palm;
  m.position.copy(at);
  const yaw = headingToYaw(heading);
  if (low && !fist) m.rotation.set(Math.PI / 2, yaw + Math.PI, 0);
  else m.rotation.set(0, yaw, 0);
  m.scale.x = side ? -1 : 1;
}

/** A buddy's body and arms, by what it's doing and how long it's been at it. */
function poseBuddy(ctx: HiContext, v: BuddyView, e: BuddyEntity, dt: number, slapped: boolean): void {
  const s = e.render;
  const r = v.rig;
  const t = ctx.now - v.since;
  const eye = BUDDY_EYE[s.slot];
  r.body.rotation.set(0, -s.angle, 0);
  r.body.scale.y = s.mode === BuddyMode.Sneak ? 0.82 : 1;
  const swing = stride(v, e.x, e.y, dt);
  r.legL.rotation.z = swing;
  r.legR.rotation.z = -swing;
  r.armL.rotation.set(0, 0, -swing * 0.8);
  r.armR.rotation.set(0, 0, swing * 0.8);
  r.head.rotation.set(0, 0, 0);
  let right: Vec3 | null = null;
  let left: Vec3 | null = null;
  let fist = false;
  switch (s.mode) {
    case BuddyMode.Offer:
      offerPose(s.offer, eye, pose);
      right = posePoint(e.x, e.y, 0, s.angle, pose, false, p1);
      if (s.offer === Move.Double) left = posePoint(e.x, e.y, 0, s.angle, pose, true, p2);
      fist = s.offer === Move.Fist;
      break;
    case BuddyMode.Swing: {
      const target = partnerById(ctx.world, s.target);
      const k = Math.min(1, t / 380);
      const back = posePoint(e.x, e.y, 0, s.angle, { f: -0.05, s: 0.36, z: eye + 0.2 }, false, p1);
      if (target && target.offer !== Move.None) {
        const to = offerPoint(target, p2);
        fist = target.offer === Move.Fist;
        right = k < 0.5 ? back : lerp(back, to, (k - 0.5) * 2, p1);
      } else right = back;
      break;
    }
    case BuddyMode.Slap: {
      const target = partnerById(ctx.world, s.target);
      const k = Math.min(1, t / 700);
      const back = posePoint(e.x, e.y, 0, s.angle, { f: -0.25, s: 0.42, z: 1.5 }, false, p1);
      right = target && k > 0.6 ? lerp(back, partnerButt(target, p2), (k - 0.6) / 0.4, p1) : back;
      break;
    }
    case BuddyMode.React:
      // arms up to celebrate (unless it's rubbing a slapped backside)
      if (s.target && t < 900 && !slapped) {
        right = posePoint(e.x, e.y, 0, s.angle, { f: 0.1, s: 0.3, z: eye + 0.45 }, false, p1);
        left = posePoint(e.x, e.y, 0, s.angle, { f: 0.1, s: 0.3, z: eye + 0.45 }, true, p2);
      }
      break;
    default:
      break;
  }
  const place = (side: 0 | 1, p: Vec3 | null) => {
    const out = !!p;
    if (p) {
      rel.set(p.x - e.x, p.z, p.y - e.y);
      aimArm(r, s.angle, rel, side === 1);
    }
    showHand(v, side, out, fist, rel, s.angle, !!p && p.z < eye * 0.6);
  };
  place(0, right);
  place(1, left);
}

function lerp(a: Vec3, b: Vec3, t: number, out: Vec3): Vec3 {
  const k = t * t * (3 - 2 * t);
  out.x = a.x + (b.x - a.x) * k;
  out.y = a.y + (b.y - a.y) * k;
  out.z = a.z + (b.z - a.z) * k;
  return out;
}

function bubbleText(offer: Move, yank: Move): string {
  if (offer !== Move.None) return offer === Move.Double ? '🙌' : offer === Move.Fist ? '👊' : offer === Move.Low ? '🫴' : '✋';
  if (yank !== Move.None) return '😜';
  return '';
}

/** A speech bubble over someone's head with an emoji in it: what they're holding out. */
class Bubble {
  private readonly sprite: THREE.Sprite;
  private text = '';
  private last = 0;
  private bornAt = 0;

  constructor(parent: THREE.Object3D, height: number) {
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, fog: false }));
    this.sprite.scale.set(0.42, 0.42, 1);
    this.sprite.position.y = height;
    this.sprite.visible = false;
    parent.add(this.sprite);
  }

  /** Whether `key` just changed, for a pop as it appears. */
  fresh(key: number): boolean {
    if (key === this.last) return false;
    this.last = key;
    this.bornAt = performance.now();
    return true;
  }

  show(text: string): void {
    if (text !== this.text) {
      this.text = text;
      const mat = this.sprite.material;
      mat.map?.dispose();
      mat.map = text ? emojiTexture(text) : null;
      mat.needsUpdate = true;
    }
    this.sprite.visible = !!text;
    if (!text) return;
    const t = (performance.now() - this.bornAt) / 1000;
    const k = t < 0.15 ? 0.4 + (t / 0.15) * 0.25 : 0.65 - Math.min(0.23, (t - 0.15) * 2) + Math.sin(t * 5) * 0.02;
    this.sprite.scale.set(k, k, 1);
  }

  dispose(): void {
    this.sprite.material.map?.dispose();
    this.sprite.material.dispose();
    this.sprite.removeFromParent();
  }
}

function emojiTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.beginPath();
  g.arc(64, 58, 52, 0, Math.PI * 2);
  g.moveTo(52, 104);
  g.lineTo(64, 124);
  g.lineTo(76, 104);
  g.fill();
  g.font = '64px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 62);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
