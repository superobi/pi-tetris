import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_GRAVITY_MS, BLOCKS, Game, HEIGHT, LINE_POINTS, MIN_GRAVITY_MS, WIDTH } from "../extensions/tetris/game.ts";
import { assertSaneTuning } from "./tuning.ts";

test("gameplay tuning has valid types and stays within broad usable bounds", assertSaneTuning);

test("each seven-piece bag contains every tetromino once", () => {
  const game = new Game(() => 0.4);
  for (let bag = 0; bag < 4; bag++) {
    const kinds = [];
    for (let i = 0; i < 7; i++) {
      kinds.push(game.active.kind);
      game.board.fill(0);
      game.hardDrop();
    }
    assert.deepEqual(kinds.sort(), [0, 1, 2, 3, 4, 5, 6]);
  }
});

test("all rotations keep four distinct blocks", () => {
  for (const rotations of BLOCKS) {
    for (const cells of rotations) {
      assert.equal(new Set(cells.map(String)).size, 4);
    }
  }
});

test("pieces stop at both walls and at occupied cells", () => {
  const game = new Game();
  game.active = { kind: 1, rotation: 0, x: 0, y: 5 };
  assert.equal(game.move(-1), false);
  while (game.move(1)) { /* move to the right wall */ }
  assert.equal(game.active.x, 8);
  assert.equal(game.move(1), false);
  game.board[7 * WIDTH + 8] = 2;
  assert.equal(game.move(0, 1), false);
  assert.equal(game.active.y, 5);
});

test("clockwise and counterclockwise rotations have opposite geometry", () => {
  const game = new Game();
  game.active = { kind: 2, rotation: 0, x: 3, y: 5 };
  const original = { ...game.active };
  assert.equal(game.rotate(1), true);
  assert.deepEqual(game.cells().map(String).sort(), ["4,5", "4,6", "5,6", "4,7"].sort());
  assert.equal(game.rotate(-1), true);
  assert.deepEqual(game.active, original);
  game.rotate(-1);
  assert.deepEqual(game.cells().map(String).sort(), ["4,5", "3,6", "4,6", "4,7"].sort());
  game.rotate(1);
  for (let i = 0; i < 4; i++) game.rotate(1);
  assert.deepEqual(game.active, original);
});

test("rotation kicks an I piece away from the wall and a T away from the floor", () => {
  const game = new Game();
  game.active = { kind: 0, rotation: 1, x: -2, y: 5 };
  assert.equal(game.fits(game.active), true);
  assert.equal(game.rotate(1), true);
  assert.equal(game.active.x, 0);
  assert.equal(game.fits(game.active), true);
  game.active = { kind: 2, rotation: 0, x: 3, y: HEIGHT - 2 };
  assert.equal(game.rotate(1), true);
  assert.equal(game.active.y, HEIGHT - 3);
  assert.equal(game.fits(game.active), true);
});

test("a blocked rotation leaves the active piece unchanged", () => {
  const game = new Game();
  game.active = { kind: 2, rotation: 0, x: 3, y: 5 };
  game.board.fill(1);
  for (const [x, y] of game.cells()) game.board[y * WIDTH + x] = 0;
  const original = { ...game.active };
  assert.equal(game.rotate(1), false);
  assert.equal(game.rotate(-1), false);
  assert.deepEqual(game.active, original);
});

test("hard drop matches the ghost, scores distance, and locks exactly four cells", () => {
  const game = new Game();
  game.active = { kind: 1, rotation: 0, x: 4, y: 0 };
  assert.equal(game.landingY(), 18);
  game.hardDrop();
  assert.equal(game.score, 36);
  assert.equal(game.locked, 1);
  assert.equal(game.board.filter(Boolean).length, 4);
  for (const index of [184, 185, 194, 195]) assert.equal(game.board[index], 2);
});

test("landing prediction stops above a stack without moving the active piece", () => {
  const game = new Game();
  game.active = { kind: 1, rotation: 0, x: 4, y: 3 };
  game.board[14 * WIDTH + 4] = 7;
  const active = game.active;
  const before = { ...active };
  const board = game.board.slice();
  assert.equal(game.landingY(), 12);
  assert.equal(game.active, active);
  assert.deepEqual(game.active, before);
  assert.deepEqual(game.board, board);
  game.active.y = 12;
  assert.equal(game.landingY(), 12, "an already landed piece has no drop distance");
});

test("four simultaneous lines clear and score once", () => {
  const game = new Game();
  for (let y = 16; y < HEIGHT; y++) game.board.fill(2, y * WIDTH + 1, (y + 1) * WIDTH);
  game.active = { kind: 0, rotation: 1, x: -2, y: 16 };
  game.step();
  assert.equal(game.lines, 4);
  assert.equal(game.score, LINE_POINTS[4]);
  assert.equal(game.board.some(Boolean), false);
  assert.equal(game.over, false);
  assert.deepEqual(game.lastClear?.rows, [19, 18, 17, 16]);
  assert.equal(game.lastClear?.board.slice(160).every(Boolean), true);
  game.hardDrop();
  assert.equal(game.lastClear, undefined, "a lock without cleared lines must not repeat the previous flash");
});

test("line clearing preserves rows above it and advances the level", () => {
  const game = new Game();
  game.lines = 9;
  const previousGravity = game.gravityMs;
  game.board.fill(3, 190, 200);
  game.board[194] = game.board[195] = 0;
  game.board[180] = 5;
  game.active = { kind: 1, rotation: 0, x: 4, y: 18 };
  game.step();
  assert.equal(game.lines, 10);
  assert.equal(game.level, 2);
  assert.ok(game.gravityMs <= previousGravity, "a level increase must not slow gravity");
  assert.equal(game.score, LINE_POINTS[1]);
  assert.equal(game.board[190], 5);
  assert.equal(game.board[194], 2);
  assert.equal(game.board[195], 2);
  assert.equal(game.board.slice(0, 190).some(Boolean), false);
  assert.deepEqual(game.lastClear?.rows, [19]);
  assert.equal(game.lastClear?.board[180], 5, "the flash keeps rows in their original positions");
  assert.equal(game.lastClear?.board[190], 3);
});

test("soft drop awards points; gravity does not", () => {
  const game = new Game();
  game.step();
  assert.equal(game.score, 0);
  game.step(true);
  assert.equal(game.score, 1);
  assert.equal(game.active.y, 2);
});

test("a blocked spawn ends the game and further input cannot mutate it", () => {
  const game = new Game();
  game.board[4] = game.board[5] = 2;
  game.next = 1;
  game.active = { kind: 1, rotation: 0, x: 4, y: 18 };
  game.step();
  assert.equal(game.over, true);
  const before = JSON.stringify(game);
  game.move(1);
  game.rotate(1);
  game.step(true);
  game.hardDrop();
  assert.equal(JSON.stringify(game), before);
});

test("locking with blocks above the ceiling ends the game without a partial write", () => {
  const game = new Game();
  game.active = { kind: 0, rotation: 1, x: 0, y: -1 };
  game.board[3 * WIDTH + 2] = 7;
  const before = game.board.slice();
  game.step();
  assert.equal(game.over, true);
  assert.deepEqual(game.board, before);
});

test("gravity never slows down as levels advance and stays bounded", () => {
  const game = new Game();
  let previous = BASE_GRAVITY_MS;
  for (const lines of [0, 10, 100, 1000, 10000, Number.MAX_SAFE_INTEGER]) {
    game.lines = lines;
    assert.ok(Number.isInteger(game.gravityMs));
    assert.ok(game.gravityMs >= MIN_GRAVITY_MS);
    assert.ok(game.gravityMs <= previous);
    previous = game.gravityMs;
  }
});
