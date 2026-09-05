import assert from "node:assert/strict";
import { BASE_GRAVITY_MS, CLEAR_FLASH_MS, FLASH_FRAME_MS, GRAVITY_DECAY,
  LINE_POINTS, LOCK_DELAY_MS, MAX_LOCK_RESETS, MIN_GRAVITY_MS, TETRIS_FLASH_MS } from "../extensions/tetris/game.ts";

export function assertSaneTuning(): void {
  const numberInRange = (name: string, value: unknown, min: number, max: number, integer = true) => {
    assert.equal(typeof value, "number", `${name} must be a number`);
    assert.ok(Number.isFinite(value), `${name} must be finite`);
    assert.ok(!integer || Number.isInteger(value), `${name} must be an integer`);
    assert.ok((value as number) >= min && (value as number) <= max, `${name} must be between ${min} and ${max}`);
  };
  // Broad guardrails for broken tuning, not preferred gameplay speeds.
  numberInRange("BASE_GRAVITY_MS", BASE_GRAVITY_MS, 1, 60_000);
  numberInRange("MIN_GRAVITY_MS", MIN_GRAVITY_MS, 1, BASE_GRAVITY_MS);
  numberInRange("GRAVITY_DECAY", GRAVITY_DECAY, 0, 1, false);
  for (const [name, value] of Object.entries({ LOCK_DELAY_MS, CLEAR_FLASH_MS, TETRIS_FLASH_MS })) {
    numberInRange(name, value, 1, 10_000);
  }
  numberInRange("FLASH_FRAME_MS", FLASH_FRAME_MS, 1, 1_000);
  numberInRange("MAX_LOCK_RESETS", MAX_LOCK_RESETS, 0, 100);
  assert.equal(LINE_POINTS.length, 5, "LINE_POINTS needs entries for zero through four cleared lines");
  LINE_POINTS.forEach((points, lines) => numberInRange(`LINE_POINTS[${lines}]`, points, 0, 1_000_000_000));
  assert.equal(LINE_POINTS[0], 0, "locking without clearing lines must not award line-clear points");
}
