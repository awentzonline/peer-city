import type { DesktopInput } from './input';
import type { AvatarIntent } from './intent';

/** Radians of turn per pixel the mouse moves. */
export const MOUSE_SENSITIVITY = 0.0022;

/** Mouse movement since last frame as a virtual head's turn and look up. */
export function readMouseLook(input: DesktopInput, intent: AvatarIntent): void {
  const [dx, dy] = input.consumeMouse();
  intent.turn = dx * MOUSE_SENSITIVITY;
  intent.lookUp = -dy * MOUSE_SENSITIVITY;
}

/** WASD walks, Shift runs and Space jumps. Crouching is the game's, since not every game has it. */
export function readWalking(input: DesktopInput, intent: AvatarIntent): void {
  const key = (code: string) => (input.down(code) ? 1 : 0);
  intent.strafe = key('KeyD') - key('KeyA');
  intent.forward = key('KeyW') - key('KeyS');
  intent.run = input.down('ShiftLeft') || input.down('ShiftRight');
  intent.jump = input.pressed('Space');
}
