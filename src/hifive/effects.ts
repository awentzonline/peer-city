import * as THREE from 'three';
import { ParticleLayer, rand, type Rgba } from '../crossplay/particles';

/** A word that pops out of a five and floats up, fading. */
interface Pop {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  z: number;
}

const POP_LIFE = 1.3;

/**
 * High Five with Friends' local visual effects: a burst of sparks and confetti where hands meet, and the word for how
 * it went ("PERFECT!", "TOO SLOW!") popping out of it. World axes.
 */
export class Effects {
  private readonly sparks = new ParticleLayer(900, true);
  private readonly confetti = new ParticleLayer(900, false);
  private readonly pops: Pop[] = [];

  constructor(private readonly scene: THREE.Scene) {
    scene.add(this.sparks.mesh, this.confetti.mesh);
  }

  /** Sparks out of a meeting of hands at (x, y, z): more, and in more colours, the better it went. */
  burst(x: number, y: number, z: number, color: number, amount: number, confetti: boolean): void {
    const c = rgba(color, 1);
    const n = Math.round(10 + amount * 26);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = rand(-0.6, 1);
      const s = rand(1.2, 3.2) * (0.6 + amount * 0.6);
      this.sparks.emit({
        x,
        y,
        z,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        vz: up * s,
        life: rand(0.25, 0.5),
        s0: rand(0.05, 0.09),
        s1: 0.01,
        c0: c,
        c1: [c[0], c[1], c[2], 0],
        gravity: 3,
        drag: 4,
      });
    }
    if (!confetti) return;
    for (let i = 0; i < 40; i++) {
      const hue = CONFETTI[i % CONFETTI.length];
      this.confetti.emit({
        x: x + rand(-0.1, 0.1),
        y: y + rand(-0.1, 0.1),
        z,
        vx: rand(-1.6, 1.6),
        vy: rand(-1.6, 1.6),
        vz: rand(1.5, 3.5),
        life: rand(1.2, 2),
        s0: 0.045,
        s1: 0.04,
        c0: rgba(hue, 1),
        c1: rgba(hue, 0),
        gravity: 3.5,
        drag: 2.5,
      });
    }
  }

  /** A word popping up at (x, y, z) in `color`, `big` for the best ones, `scale` smaller for one right in front of you. */
  pop(text: string, x: number, y: number, z: number, color: string, big = false, scale = 1): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.font = `900 ${big ? 86 : 70}px Trebuchet MS, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#1a1026';
    ctx.strokeText(text, 256, 66, 496);
    ctx.fillStyle = color;
    ctx.fillText(text, 256, 66, 496);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false }));
    sprite.renderOrder = 20;
    const k = (big ? 1.1 : 0.85) * scale;
    sprite.scale.set(k, k / 4, 1);
    sprite.position.set(x, z + 0.25, y);
    this.scene.add(sprite);
    this.pops.push({ sprite, age: 0, life: POP_LIFE, z: z + 0.25 });
  }

  update(dt: number): void {
    this.sparks.update(dt);
    this.confetti.update(dt);
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) {
        this.scene.remove(p.sprite);
        p.sprite.material.map?.dispose();
        p.sprite.material.dispose();
        this.pops.splice(i, 1);
        continue;
      }
      // a quick bounce up to size, then drift up and fade
      const grow = t < 0.12 ? 0.6 + (t / 0.12) * 0.55 : t < 0.2 ? 1.15 - ((t - 0.12) / 0.08) * 0.15 : 1;
      p.sprite.position.y = p.z + t * 0.5;
      p.sprite.material.opacity = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      const base = p.sprite.userData.base ?? (p.sprite.userData.base = p.sprite.scale.x);
      p.sprite.scale.set(base * grow, (base * grow) / 4, 1);
    }
  }
}

const CONFETTI = [0xff4d6d, 0xffd23f, 0x3bceac, 0x3a86ff, 0xb388ff, 0xff9f1c];

function rgba(rgb: number, a: number): Rgba {
  return [((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255, a];
}
