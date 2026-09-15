import { Gun } from './gun';
import { Toolbox } from './tool';

const DOWN = -Math.PI / 2;
const UP = Math.PI / 2;
/** For models exported with their barrel pointing +Z. */
const BACKWARDS = [0, Math.PI, 0] as const;

/*
 * Peer City's tools, in slot order (number keys). Stashes: pistols on the hips, SMGs down the chest, long
 * guns crossed on the back.
 */

export const PISTOL = new Gun({
  name: 'Pistol',
  model: { asset: 'pistol', orient: BACKWARDS, length: 0.2 },
  grip: { tip: [0, 0.025, -0.2] },
  stash: [
    { at: [0.22, -0.5, -0.05], pitch: DOWN },
    { at: [-0.22, -0.5, -0.05], pitch: DOWN },
  ],
  color: 0xffffff,
  issued: 2,
  cooldownMs: 160,
  range: 160,
  body: 22,
  head: 60,
  car: 8,
  kick: 1,
  sound: 'shot',
});

export const SMG = new Gun({
  name: 'SMG',
  model: { asset: 'smg', length: 0.62 },
  grip: { tip: [0, 0.04, -0.36] },
  stash: [
    { at: [0.14, -0.3, -0.16], pitch: DOWN },
    { at: [-0.14, -0.3, -0.16], pitch: DOWN },
  ],
  color: 0x4fc3ff,
  charges: { pickup: 120, max: 360 },
  cooldownMs: 80,
  range: 110,
  body: 14,
  head: 35,
  car: 5,
  spread: 0.035,
  kick: 0.6,
  sound: 'rifle',
});

export const SHOTGUN = new Gun({
  name: 'Shotgun',
  model: { asset: 'shotgun', length: 0.75 },
  grip: { tip: [0, 0.05, -0.55] },
  stash: [
    { at: [0.1, -0.5, 0.27], pitch: UP, roll: -0.2 },
    { at: [-0.1, -0.5, 0.27], pitch: UP, roll: 0.2 },
  ],
  color: 0xff9f43,
  charges: { pickup: 16, max: 48 },
  cooldownMs: 850,
  range: 45,
  body: 14,
  head: 30,
  car: 5,
  pellets: 8,
  spread: 0.09,
  kick: 2.2,
  sound: 'shotgun',
});

export const RIFLE = new Gun({
  name: 'Assault Rifle',
  model: { asset: 'rifle', length: 0.88 },
  grip: { tip: [0, 0.05, -0.62] },
  stash: [
    { at: [0.08, -0.35, 0.2], pitch: UP, roll: -0.4 },
    { at: [-0.08, -0.35, 0.2], pitch: UP, roll: 0.4 },
  ],
  color: 0xff5252,
  charges: { pickup: 90, max: 270 },
  cooldownMs: 110,
  range: 200,
  body: 26,
  head: 70,
  car: 10,
  spread: 0.012,
  kick: 0.9,
  sound: 'rifle',
});

export const SNIPER = new Gun({
  name: 'Sniper Rifle',
  model: { asset: 'sniper', length: 1.1 },
  grip: { tip: [0, 0.05, -0.78] },
  stash: [
    { at: [0.1, -0.4, 0.3], pitch: UP, roll: -0.25 },
    { at: [-0.1, -0.4, 0.3], pitch: UP, roll: 0.25 },
  ],
  color: 0xb388ff,
  charges: { pickup: 10, max: 30 },
  cooldownMs: 1200,
  range: 400,
  body: 90,
  head: 250,
  car: 35,
  kick: 2.5,
  sound: 'sniper',
});

export const TOOLS = new Toolbox([PISTOL, SMG, SHOTGUN, RIFLE, SNIPER]);
