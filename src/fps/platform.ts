/**
 * The kind of device someone plays on. It says nothing about what they do in the game; that's their role
 * (see role.ts). Replicated (`Player.platform`), so the values must stay stable.
 */
export const enum Platform {
  Desktop = 0,
  Vr = 1,
  Touch = 2,
}
