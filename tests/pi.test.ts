import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { BASE_GRAVITY_MS, CLEAR_FLASH_MS, FLASH_FRAME_MS, LOCK_DELAY_MS, MAX_LOCK_RESETS,
  TETRIS_FLASH_MS } from "../extensions/tetris/game.ts";
import { assertSaneTuning } from "./tuning.ts";

// Stop before scheduling timers or looping over a malformed setting.
assertSaneTuning();
const idleWait = 2 * Math.max(BASE_GRAVITY_MS, LOCK_DELAY_MS, CLEAR_FLASH_MS, TETRIS_FLASH_MS, FLASH_FRAME_MS);

// Test against Pi's own loader and keyboard parser without installing another copy.
function findPi(): string {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  for (const path of (process.env.PATH ?? "").split(delimiter)) {
    if (!existsSync(join(path, "pi"))) continue;
    let directory = dirname(realpathSync(join(path, "pi")));
    while (dirname(directory) !== directory) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") {
        return directory;
      }
      directory = dirname(directory);
    }
  }
  throw new Error("Pi must be on PATH for integration tests (or set PI_PACKAGE_DIR).");
}

const piRoot = findPi();
const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
const requireFromPi = createRequire(join(piRoot, "package.json"));
const { visibleWidth } = await import(pathToFileURL(requireFromPi.resolve("@earendil-works/pi-tui")).href);
const root = fileURLToPath(new URL("..", import.meta.url));
const clean = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

async function harness(t: TestContext, working = false) {
  const { extensions, errors } = await loadExtensions([resolve(root, "extensions/tetris/index.ts")], root);
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1);
  const extension = extensions[0];
  const terminal = { columns: 80, rows: 30 };
  let component: any;
  let renders = 0;
  let openings = 0;
  let pending: Promise<void> | undefined;
  const notices: string[] = [];
  const ctx: any = {
    mode: "tui", hasUI: true, isIdle: () => !working,
    ui: {
      notify: (message: string) => notices.push(message),
      custom: (factory: any, options: any) => new Promise<void>((done) => {
        openings++;
        assert.equal(options.overlay, true);
        component = factory({ terminal, requestRender: () => renders++ }, { fg: (_color: string, s: string) => s }, {}, done);
      }),
    },
  };
  const open = () => {
    pending = extension.commands.get("tetris").handler("", ctx);
    return pending;
  };
  const emit = async (event: string) => {
    for (const handler of extension.handlers.get(event) ?? []) await handler({}, ctx);
  };
  t.after(async () => {
    component?.close();
    await pending;
  });
  return { open, emit, ctx, terminal, notices,
    get component() { return component; }, get renders() { return renders; }, get openings() { return openings; } };
}

test("Pi loads the overlay while busy; C/V work in legacy and extended input", async (t) => {
  const h = await harness(t, true);
  void h.open();
  const ui = h.component;
  ui.state.active = { kind: 2, rotation: 0, x: 3, y: 5 };
  assert.match(clean(ui.render(42)), /Pi working/);
  ui.handleInput("c");
  assert.equal(ui.state.active.rotation, 3);
  ui.handleInput("v");
  assert.equal(ui.state.active.rotation, 0);
  ui.handleInput("\x1b[99u");
  assert.equal(ui.state.active.rotation, 3);
  ui.handleInput("\x1b[118u");
  assert.equal(ui.state.active.rotation, 0);
  ui.handleInput("C");
  assert.equal(ui.state.active.rotation, 3);
  ui.handleInput("V");
  assert.equal(ui.state.active.rotation, 0);
  ui.handleInput("\x1b[D");
  assert.equal(ui.state.active.x, 2);
  ui.handleInput("\x1b[C");
  assert.equal(ui.state.active.x, 3);
  ui.handleInput("\x1b[B");
  assert.equal(ui.state.active.y, 6);
  ui.handleInput("\x1b[A");
  assert.equal(ui.state.active.rotation, 1);
  assert.equal(ui.state.locked, 0);
  ui.handleInput("\x1b[1;1A");
  assert.equal(ui.state.active.rotation, 2);
  ui.handleInput(" ");
  assert.equal(ui.state.locked, 1);
  ui.handleInput("\x1b[32u");
  assert.equal(ui.state.locked, 2);
  assert.equal(h.notices.length, 0);
});

test("gravity ticks on schedule; movement does not postpone it; pause and close stop it", async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void h.open();
  const ui = h.component;
  const initialY = ui.state.active.y;
  t.mock.timers.tick(ui.state.gravityMs - 1);
  ui.handleInput("\x1b[D");
  assert.equal(ui.state.active.y, initialY);
  t.mock.timers.tick(1);
  assert.equal(ui.state.active.y, initialY + 1);
  ui.handleInput("p");
  const pausedRenders = h.renders;
  t.mock.timers.tick(idleWait);
  assert.equal(ui.state.active.y, initialY + 1);
  assert.equal(h.renders, pausedRenders);
  ui.handleInput("p");
  t.mock.timers.tick(h.component.state.gravityMs);
  assert.equal(ui.state.active.y, initialY + 2);
  ui.close();
  const closedRenders = h.renders;
  t.mock.timers.tick(idleWait);
  assert.equal(h.renders, closedRenders);
});

for (const lines of [0, 10000]) {
  test(`landing respects the configured delay, including at level ${1 + lines / 10}`, async (t) => {
    const h = await harness(t);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    void h.open();
    const ui = h.component;
    ui.state.lines = lines;
    ui.state.active = { kind: 1, rotation: 0, x: 4, y: 17 };
    ui.handleInput("p");
    ui.handleInput("p");
    t.mock.timers.tick(ui.state.gravityMs);
    assert.equal(ui.state.active.y, 18);
    assert.equal(ui.state.grounded, true);
    t.mock.timers.tick(LOCK_DELAY_MS - 1);
    assert.equal(ui.state.locked, 0);
    assert.equal(ui.state.board.some(Boolean), false);
    t.mock.timers.tick(1);
    assert.equal(ui.state.locked, 1);
    assert.equal(ui.state.board.filter(Boolean).length, 4);
  });
}

test("soft drop onto a stack leaves time to slide; blocked Down does not score or lock", async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void h.open();
  const ui = h.component;
  ui.state.board[15 * 10 + 4] = 7;
  ui.state.active = { kind: 1, rotation: 0, x: 4, y: 12 };
  ui.handleInput("\x1b[B");
  assert.equal(ui.state.active.y, 13);
  assert.equal(ui.state.score, 1);
  const elapsed = Math.floor(LOCK_DELAY_MS / 3);
  t.mock.timers.tick(elapsed);
  for (let i = 0; i < 10; i++) ui.handleInput("\x1b[B");
  assert.equal(ui.state.locked, 0);
  assert.equal(ui.state.score, 1);
  ui.handleInput("\x1b[D");
  assert.equal(ui.state.active.x, 3);
  t.mock.timers.tick(LOCK_DELAY_MS - (MAX_LOCK_RESETS > 0 ? 0 : elapsed) - 1);
  assert.equal(ui.state.locked, 0);
  t.mock.timers.tick(1);
  assert.equal(ui.state.locked, 1);
  for (const index of [133, 134, 143, 144]) assert.equal(ui.state.board[index], 2);
});

for (const [key, rotation, expected] of [["v", 1, 2], ["c", 2, 1]] as const) {
  test(`${key.toUpperCase()} rotation obeys the configured lock reset policy`, async (t) => {
    const h = await harness(t);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    void h.open();
    const ui = h.component;
    ui.state.active = { kind: 2, rotation, x: 3, y: 16 };
    ui.handleInput("\x1b[B");
    assert.equal(ui.state.grounded, true);
    t.mock.timers.tick(LOCK_DELAY_MS - 1);
    ui.handleInput(key);
    assert.equal(ui.state.active.rotation, expected);
    assert.equal(ui.state.grounded, true);
    if (MAX_LOCK_RESETS > 0) t.mock.timers.tick(LOCK_DELAY_MS - 1);
    assert.equal(ui.state.locked, 0);
    t.mock.timers.tick(1);
    assert.equal(ui.state.locked, 1);
  });
}

test("blocked movement and unchanged rotation do not postpone locking", async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void h.open();
  const ui = h.component;
  ui.state.active = { kind: 1, rotation: 0, x: 0, y: 17 };
  ui.handleInput("\x1b[B");
  t.mock.timers.tick(LOCK_DELAY_MS - 1);
  for (const key of ["\x1b[D", "c", "v", "\x1b[B"]) ui.handleInput(key);
  assert.equal(ui.state.locked, 0);
  t.mock.timers.tick(1);
  assert.equal(ui.state.locked, 1);
});

test("grounded movement respects the reset limit and each piece gets a fresh allowance", async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void h.open();
  const ui = h.component;
  ui.state.active = { kind: 1, rotation: 0, x: 4, y: 17 };
  ui.handleInput("\x1b[B");
  for (let i = 0; i < MAX_LOCK_RESETS; i++) {
    t.mock.timers.tick(LOCK_DELAY_MS - 1);
    ui.handleInput(i % 2 === 0 ? "\x1b[D" : "\x1b[C");
    assert.equal(ui.state.locked, 0);
  }
  t.mock.timers.tick(LOCK_DELAY_MS - 1);
  const previousX = ui.state.active.x;
  ui.handleInput("\x1b[C");
  assert.equal(ui.state.active.x, previousX + 1, "movement still works after the reset limit");
  t.mock.timers.tick(1);
  assert.equal(ui.state.locked, 1);

  ui.state.active = { kind: 1, rotation: 0, x: 0, y: 17 };
  ui.handleInput("\x1b[B");
  t.mock.timers.tick(LOCK_DELAY_MS - 1);
  ui.handleInput("\x1b[C");
  if (MAX_LOCK_RESETS > 0) t.mock.timers.tick(LOCK_DELAY_MS - 1);
  assert.equal(ui.state.locked, 1, "the next piece gets a fresh reset allowance");
  t.mock.timers.tick(1);
  assert.equal(ui.state.locked, 2);
});

test("sliding off a ledge resumes gravity and starts a fresh delay on landing", async (t) => {
  if (MAX_LOCK_RESETS < 2) return t.skip("This case needs a reset remaining after sliding off the ledge.");
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void h.open();
  const ui = h.component;
  ui.state.board[15 * 10 + 4] = 7;
  ui.state.active = { kind: 1, rotation: 0, x: 4, y: 12 };
  ui.handleInput("\x1b[B");
  const elapsed = Math.floor(Math.min(LOCK_DELAY_MS, ui.state.gravityMs) / 3);
  t.mock.timers.tick(elapsed);
  ui.handleInput("\x1b[C");
  assert.equal(ui.state.grounded, false);
  t.mock.timers.tick(ui.state.gravityMs - elapsed - 1);
  assert.equal(ui.state.locked, 0, "a piece must not lock in the air");
  assert.equal(ui.state.active.y, 13);
  t.mock.timers.tick(1);
  assert.equal(ui.state.active.y, 14, "the original gravity deadline is preserved");
  for (let i = 0; i < 4; i++) ui.handleInput("\x1b[B");
  assert.equal(ui.state.active.y, 18);
  t.mock.timers.tick(LOCK_DELAY_MS - 1);
  assert.equal(ui.state.locked, 0);
  t.mock.timers.tick(1);
  assert.equal(ui.state.locked, 1);
});

test("sliding off a ledge after the reset limit cannot renew an expired delay", async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void h.open();
  const ui = h.component;
  // Keep the next fall later than the lock deadline to exercise an expired
  // delay in midair regardless of the game's chosen gravity speed.
  Object.defineProperty(ui.state, "gravityMs", { value: LOCK_DELAY_MS * 2 });
  ui.handleInput("p");
  ui.handleInput("p");
  ui.state.board.fill(7, 153, 157);
  ui.state.board[167] = 7;
  ui.state.active = { kind: 1, rotation: 0, x: 4, y: 12 };
  ui.handleInput("\x1b[B");
  for (let i = 0; i < MAX_LOCK_RESETS; i++) {
    ui.handleInput(i % 2 === 0 ? "\x1b[C" : "\x1b[D");
  }
  while (ui.state.active.x < 7) ui.handleInput("\x1b[C");
  assert.equal(ui.state.active.x, 7);
  assert.equal(ui.state.grounded, false);
  t.mock.timers.tick(LOCK_DELAY_MS);
  assert.equal(ui.state.locked, 0);
  t.mock.timers.tick(LOCK_DELAY_MS);
  assert.equal(ui.state.locked, 1, "landing after the deadline locks without another delay");
  assert.equal(ui.state.board[147], 2);
});

test("Space bypasses the landing delay and the next piece gets normal gravity", async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void h.open();
  const ui = h.component;
  ui.state.active = { kind: 1, rotation: 0, x: 4, y: 17 };
  ui.handleInput("\x1b[B");
  t.mock.timers.tick(Math.floor(LOCK_DELAY_MS / 4));
  ui.handleInput(" ");
  assert.equal(ui.state.locked, 1);
  assert.equal(ui.state.score, 1, "zero-distance hard drop adds no score");
  t.mock.timers.tick(ui.state.gravityMs - 1);
  assert.equal(ui.state.active.y, 0);
  assert.equal(ui.state.locked, 1);
  t.mock.timers.tick(1);
  assert.equal(ui.state.active.y, 1);
});

test("pause, restart, close, and Pi completion cancel a pending lock", async (t) => {
  const h = await harness(t, true);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void h.open();
  const ui = h.component;
  const land = () => {
    ui.state.active = { kind: 1, rotation: 0, x: 0, y: 17 };
    ui.handleInput("\x1b[B");
    t.mock.timers.tick(Math.floor(LOCK_DELAY_MS / 4));
  };
  land();
  ui.handleInput("p");
  const pausedRenders = h.renders;
  t.mock.timers.tick(idleWait);
  assert.equal(ui.state.locked, 0);
  assert.equal(h.renders, pausedRenders);
  ui.handleInput("p");
  t.mock.timers.tick(LOCK_DELAY_MS - 1);
  assert.equal(ui.state.locked, 0);
  t.mock.timers.tick(1);
  assert.equal(ui.state.locked, 1);

  ui.handleInput("r");
  land();
  await h.emit("agent_settled");
  t.mock.timers.tick(idleWait);
  assert.equal(ui.state.locked, 0);
  assert.match(clean(ui.render(42)), /Pi finished/);

  ui.handleInput("r");
  land();
  const oldGame = ui.state;
  ui.handleInput("r");
  t.mock.timers.tick(ui.state.gravityMs - 1);
  assert.equal(oldGame.locked, 0);
  assert.equal(ui.state.active.y, 0);
  land();
  ui.close();
  const closedRenders = h.renders;
  t.mock.timers.tick(idleWait);
  assert.equal(ui.state.locked, 0);
  assert.equal(h.renders, closedRenders);
  assert.equal(oldGame.locked, 0);
});

test("Pi completion pauses the game and displays a notice", async (t) => {
  const h = await harness(t, true);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void h.open();
  await h.emit("agent_settled");
  assert.match(clean(h.component.render(42)), /Pi finished/);
  assert.match(clean(h.component.render(42)), /PAUSED/);
  const y = h.component.state.active.y;
  t.mock.timers.tick(idleWait);
  assert.equal(h.component.state.active.y, y);
  h.component.handleInput("p");
  t.mock.timers.tick(h.component.state.gravityMs);
  assert.equal(h.component.state.active.y, y + 1);
});

test("all viewport sizes fit; an undersized pane pauses until explicitly resumed", async (t) => {
  const h = await harness(t);
  void h.open();
  for (const width of [0, 1, 12, 31, 32, 41, 42, 80]) {
    for (const height of [1, 10, 14, 15, 24, 25, 40]) {
      h.terminal.columns = width;
      h.terminal.rows = height;
      const lines = h.component.render(width);
      assert.ok(lines.length <= height, `${width}x${height} overflows vertically`);
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width), `${width}x${height} overflows horizontally`);
    }
  }
  h.terminal.columns = 80;
  h.terminal.rows = 30;
  assert.match(clean(h.component.render(42)), /PAUSED/);
  h.component.handleInput("p");
  assert.doesNotMatch(clean(h.component.render(42)), /PAUSED/);
  const frame = h.component.render(42);
  assert.equal(h.component.render(42), frame, "unchanged frames should be cached during streaming");
  h.component.invalidate();
  assert.notEqual(h.component.render(42), frame);
});

test("Escape returns to Pi; reopening preserves progress and starts paused", async (t) => {
  const h = await harness(t);
  const closed = h.open();
  h.component.handleInput(" ");
  const game = h.component.state;
  h.component.handleInput("\x1b");
  await closed;
  void h.open();
  assert.equal(h.component.state, game);
  assert.equal(h.component.state.locked, 1);
  assert.match(clean(h.component.render(42)), /PAUSED/);
  h.component.handleInput("r");
  assert.notEqual(h.component.state, game);
  assert.equal(h.component.state.locked, 0);
});

test("duplicate opens are ignored and a new session discards the old game", async (t) => {
  const h = await harness(t);
  void h.open();
  const game = h.component.state;
  await h.open();
  assert.equal(h.openings, 1);
  await h.emit("session_shutdown");
  void h.open();
  assert.notEqual(h.component.state, game);
  assert.doesNotMatch(clean(h.component.render(42)), /PAUSED/);
});

test("RPC mode never opens terminal UI", async (t) => {
  const h = await harness(t);
  h.ctx.mode = "rpc";
  await h.open();
  assert.equal(h.openings, 0);
  assert.match(h.notices[0], /interactive terminal/);
});

function prepareClear(ui: any, count: number): void {
  const game = ui.state;
  game.board.fill(0);
  for (let y = 20 - count; y < 20; y++) {
    game.board.fill(2, y * 10, (y + 1) * 10);
    game.board[y * 10 + 4] = 0;
  }
  game.active = { kind: 0, rotation: 1, x: 2, y: 0 };
  game.next = 2;
  ui.invalidate();
}

for (const count of [1, 2, 3, 4]) {
  test(`${count} cleared lines flash and hold gameplay for ${count === 4 ? TETRIS_FLASH_MS : CLEAR_FLASH_MS} ms`, async (t) => {
    const h = await harness(t);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    void h.open();
    const ui = h.component;
    prepareClear(ui, count);
    ui.handleInput(" ");
    const frame = ui.render(42);
    const label = count === 4 ? "TETRIS!" : `+${count} LINE`;
    assert.ok(clean(frame).includes(label));
    assert.ok(frame.join("").includes(count === 4 ? ";231m" : ";250m"));
    for (let row = 20 - count; row < 20; row++) {
      const expected = count === 4 ? "█".repeat(8) + " ".repeat(4) + "█".repeat(8) : "█".repeat(20);
      assert.equal(clean([frame[row + 1]]).split("│")[1], expected, "a Tetris starts by erasing the center pair");
    }
    assert.equal(ui.state.lines, count);
    const nextPiece = { ...ui.state.active };
    for (const key of ["\x1b[D", "\x1b[C", "\x1b[A", "\x1b[B", "c", "v", " "]) ui.handleInput(key);
    assert.deepEqual(ui.state.active, nextPiece, "gameplay input is ignored during the hold");
    assert.equal(ui.state.locked, 1);

    const duration = count === 4 ? TETRIS_FLASH_MS : CLEAR_FLASH_MS;
    t.mock.timers.tick(duration - 1);
    assert.ok(clean(ui.render(42)).includes(label));
    t.mock.timers.tick(1);
    assert.ok(!clean(ui.render(42)).includes(label));
    assert.deepEqual(ui.state.active, nextPiece);
    t.mock.timers.tick(ui.state.gravityMs - 1);
    assert.equal(ui.state.active.y, nextPiece.y);
    t.mock.timers.tick(1);
    assert.equal(ui.state.active.y, nextPiece.y + 1, "the hold adds to the normal gravity interval");
    ui.handleInput("\x1b[C");
    assert.equal(ui.state.active.x, nextPiece.x + 1);
  });
}

test("the flash waits for a rendered frame and works when gravity locks a piece", async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void h.open();
  const ui = h.component;
  prepareClear(ui, 2);
  ui.state.active.y = ui.state.landingY() - 1;
  t.mock.timers.tick(h.component.state.gravityMs);
  assert.equal(ui.state.lines, 0);
  t.mock.timers.tick(LOCK_DELAY_MS);
  assert.equal(ui.state.lines, 2);
  t.mock.timers.tick(idleWait); // Simulate Pi's renderer being delayed.
  assert.equal(ui.state.active.y, 0);
  assert.match(clean(ui.render(42)), /\+2 LINES/);
  t.mock.timers.tick(CLEAR_FLASH_MS - 1);
  assert.match(clean(ui.render(42)), /\+2 LINES/);
  t.mock.timers.tick(1);
  assert.doesNotMatch(clean(ui.render(42)), /\+2 LINES/);
});

for (const count of [1, 2, 3, 4]) {
  test(`compact layout flashes ${count} rows without overflowing or tinting adjacent rows`, async (t) => {
    const h = await harness(t);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    h.terminal.rows = 15;
    h.terminal.columns = 32;
    void h.open();
    const ui = h.component;
    prepareClear(ui, count);
    ui.handleInput(" ");
    const frame = ui.render(32);
    assert.equal(frame.length, 15);
    assert.ok(frame.every((line: string) => visibleWidth(line) <= 32));
    const tint = count === 4 ? 231 : 250;
    const bottomRow = frame[10];
    assert.ok(bottomRow.includes(`;${tint}m`));
    if (count === 1) {
      assert.ok(bottomRow.includes(`38;5;51;48;5;${tint}m`), "the I block above the single cleared row keeps its cyan color");
    }
    t.mock.timers.tick(count === 4 ? TETRIS_FLASH_MS : CLEAR_FLASH_MS);
    assert.ok(!ui.render(32).join("").includes(`;${tint}m`));
  });
}

test("pausing a flash cancels its timeout and resuming finishes it", async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void h.open();
  const ui = h.component;
  prepareClear(ui, 1);
  ui.handleInput(" ");
  ui.render(42);
  ui.handleInput("p");
  const renders = h.renders;
  t.mock.timers.tick(idleWait);
  assert.equal(h.renders, renders);
  assert.match(clean(ui.render(42)), /PAUSED/);
  ui.handleInput("p");
  assert.match(clean(ui.render(42)), /\+1 LINE/);
  t.mock.timers.tick(CLEAR_FLASH_MS);
  assert.doesNotMatch(clean(ui.render(42)), /\+1 LINE/);
});

test("restart and close cancel a flash without a late callback affecting the game", async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void h.open();
  const ui = h.component;
  prepareClear(ui, 4);
  ui.handleInput(" ");
  ui.render(42);
  ui.handleInput("r");
  const fresh = ui.state;
  const renders = h.renders;
  t.mock.timers.tick(ui.state.gravityMs - 1);
  assert.equal(h.renders, renders);
  assert.equal(ui.state, fresh);
  assert.equal(ui.state.lines, 0);
  assert.doesNotMatch(clean(ui.render(42)), /TETRIS!/);
  t.mock.timers.tick(1);
  assert.equal(ui.state.active.y, 1);

  prepareClear(ui, 4);
  ui.handleInput(" ");
  ui.render(42);
  ui.close();
  const closedRenders = h.renders;
  t.mock.timers.tick(idleWait);
  assert.equal(h.renders, closedRenders);
});

for (const [width, height] of [[42, 30], [32, 15]]) {
  for (const count of [1, 4]) {
    test(`${count}-line feedback alternates on animation frames at ${width}x${height}`, async (t) => {
      const h = await harness(t);
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      h.terminal.columns = width;
      h.terminal.rows = height;
      void h.open();
      const ui = h.component;
      prepareClear(ui, count);
      ui.handleInput(" ");
      const tint = count === 4 ? ";231m" : ";250m";
      const lit = ui.render(width);
      assert.ok(lit.join("").includes(tint));
      assert.equal(ui.render(width), lit, "repeated reads do not advance the animation");
      const duration = count === 4 ? TETRIS_FLASH_MS : CLEAR_FLASH_MS;
      let elapsed = 0;
      let highlight = true;
      while (elapsed + FLASH_FRAME_MS < duration) {
        t.mock.timers.tick(FLASH_FRAME_MS);
        elapsed += FLASH_FRAME_MS;
        highlight = !highlight;
        const frame = ui.render(width);
        const wiped = count === 4 && elapsed >= duration * 4 / 5;
        assert.equal(frame.join("").includes(tint), highlight && !wiped);
        assert.ok(clean(frame).includes(count === 4 ? "TETRIS!" : "+1 LINE"), "rows stay in place between blinks");
      }
      t.mock.timers.tick(duration - elapsed);
      assert.doesNotMatch(clean(ui.render(width)), /TETRIS!|\+1 LINE/);
      const renders = h.renders;
      t.mock.timers.tick(ui.state.gravityMs - 1);
      assert.equal(h.renders, renders, "animation stops once the lines collapse");
    });
  }

  test(`a Tetris wipes outward in symmetric column pairs at ${width}x${height}`, async (t) => {
    const h = await harness(t);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    h.terminal.columns = width;
    h.terminal.rows = height;
    void h.open();
    const ui = h.component;
    prepareClear(ui, 4);
    ui.handleInput(" ");
    const collapsed = ui.state.board.slice();
    const snapshot = ui.clearing.board.slice();
    const cellWidth = width === 42 ? 2 : 1;
    for (let elapsed = 0; elapsed < TETRIS_FLASH_MS; elapsed += FLASH_FRAME_MS) {
      if (elapsed > 0) t.mock.timers.tick(FLASH_FRAME_MS);
      const frame = ui.render(width);
      const pairs = Math.min(5, 1 + Math.floor(elapsed * 5 / TETRIS_FLASH_MS));
      for (let row = 16; row < 20; row++) {
        const line = clean([frame[1 + (width === 42 ? row : Math.floor(row / 2))]]).split("│")[1];
        for (let x = 0; x < 10; x++) {
          const blank = line.slice(x * cellWidth, (x + 1) * cellWidth) === " ".repeat(cellWidth);
          assert.equal(blank, x >= 5 - pairs && x < 5 + pairs, `column ${x} at ${elapsed} ms`);
        }
      }
      assert.deepEqual(ui.state.board, collapsed, "the wipe does not alter the collapsed game board");
      assert.deepEqual(ui.clearing.board, snapshot, "the original rows stay intact in the animation snapshot");
    }
  });

  test(`pausing a Tetris wipe never brings erased columns back at ${width}x${height}`, async (t) => {
    const h = await harness(t);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    h.terminal.columns = width;
    h.terminal.rows = height;
    void h.open();
    const ui = h.component;
    prepareClear(ui, 4);
    ui.handleInput(" ");
    ui.render(width);
    t.mock.timers.tick(Math.floor(TETRIS_FLASH_MS / 2));
    const blankColumns = () => {
      const row = clean([ui.render(width)[width === 42 ? 20 : 10]]).split("│")[1];
      return [...row].map((char, i) => char === " " ? i : -1).filter(i => i >= 0);
    };
    const before = blankColumns();
    ui.handleInput("p");
    t.mock.timers.tick(idleWait);
    assert.deepEqual(blankColumns(), before);
    ui.handleInput("p");
    assert.deepEqual(blankColumns(), before);
    t.mock.timers.tick(TETRIS_FLASH_MS);
    assert.doesNotMatch(clean(ui.render(width)), /TETRIS!/);
  });

  test(`textured pieces and the next-piece window fit at ${width}x${height}`, async (t) => {
    const h = await harness(t);
    h.terminal.columns = width;
    h.terminal.rows = height;
    void h.open();
    const ui = h.component;
    ui.state.active = { kind: 1, rotation: 0, x: 4, y: 4 };
    const sideColumn = width === 42 ? 24 : 14;
    for (const [kind, name] of ["I", "O", "T", "S", "Z", "J", "L"].entries()) {
      ui.state.next = kind;
      ui.invalidate();
      const frame = ui.render(width);
      assert.ok(frame.length <= height);
      assert.ok(frame.every((row: string) => visibleWidth(row) <= width));
      const side = frame.map((row: string) => clean([row]).slice(sideColumn));
      assert.equal(side[6], `╭ NEXT ${name} ╮`);
      assert.equal(side[9], "╰────────╯");
      assert.ok(side.slice(7, 9).every((row: string) => row.startsWith("│") && row.endsWith("│")));
      assert.equal((side.slice(7, 9).join("").match(/▛▟/g) ?? []).length, 4);
      const pieceRow = width === 42 ? 5 : 3;
      const boardRow = clean([frame[pieceRow]]).split("│")[1];
      assert.ok(boardRow.includes(width === 42 ? "▛▟▛▟" : "▓▓"));
    }
  });
}
