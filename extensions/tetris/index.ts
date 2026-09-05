import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { BLOCKS, CLEAR_FLASH_MS, FLASH_FRAME_MS, Game, HEIGHT, LOCK_DELAY_MS,
  MAX_LOCK_RESETS, NAMES, TETRIS_FLASH_MS, WIDTH, type LineClear } from "./game.ts";

const COLORS = [0, 51, 226, 201, 46, 196, 33, 208];
const MIN_WIDTH = 32;
const MIN_HEIGHT = 15;
const FULL_WIDTH = 42;
const FULL_HEIGHT = 25;
const RESET = "\x1b[0m";
// Precompute the two shaded faces once; each brick keeps its own bevel.
const TILES = [[0, 0, 0], [20, 185, 220], [230, 180, 45], [160, 85, 205],
  [75, 175, 100], [215, 65, 65], [55, 115, 220], [235, 140, 40]].map(rgb => {
  const light = rgb.map(v => Math.round(v + (255 - v) * 0.55)).join(";");
  const dark = rgb.map(v => Math.round(v * 0.35)).join(";");
  return `\x1b[48;2;${rgb.join(";")};38;2;${light}m▛\x1b[38;2;${dark}m▟${RESET}`;
});

class Tetris {
  private game: Game;
  private tui: TUI;
  private theme: Theme;
  private done: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private gravityAt?: number;
  private lockAt?: number;
  private lockResets = 0;
  private clearing?: LineClear;
  private flashOn = true;
  private flashEndsAt?: number;
  private wipePairs = 0;
  private disposed = false;
  private paused: boolean;
  private working: boolean;
  private finished = false;
  private cached?: string[];
  private cachedWidth = 0;
  private cachedHeight = 0;

  constructor(tui: TUI, theme: Theme, done: () => void, game: Game, resumed: boolean, working: boolean) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.game = game;
    this.paused = resumed;
    this.working = working;
    this.schedule();
  }

  get state(): Game { return this.game; }

  private stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.gravityAt = undefined;
    this.lockAt = undefined;
    this.flashEndsAt = undefined;
    this.flashOn = true;
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || this.paused || this.game.over || this.clearing) return;
    const now = Date.now();
    this.gravityAt ??= now + this.game.gravityMs;
    const grounded = this.game.grounded;
    if (grounded) {
      this.lockAt ??= now + LOCK_DELAY_MS;
    } else {
      // After the reset limit, lifting off a ledge must not buy another delay.
      if (this.lockResets < MAX_LOCK_RESETS) this.lockAt = undefined;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const locked = this.game.locked;
      // A grounded piece reaches this callback only after its lock delay.
      this.game.step();
      this.gravityAt = Date.now() + this.game.gravityMs;
      this.afterAction(locked);
    }, Math.max(0, (grounded ? this.lockAt! : this.gravityAt) - now));
    this.timer.unref();
  }

  private afterAction(locked: number): void {
    if (this.game.locked !== locked) {
      this.stopTimer();
      this.lockResets = 0;
      this.clearing = this.game.lastClear;
      this.wipePairs = this.clearing?.rows.length === 4 ? 1 : 0;
    }
    this.schedule();
    this.changed();
  }

  private holdClearFrame(): void {
    if (!this.clearing || this.timer !== undefined || this.paused || this.disposed) return;
    // Start on the first rendered frame. A deadline keeps delayed frames from
    // extending the hold; the same timeout drives blinking and then gravity.
    this.flashEndsAt ??= Date.now() + (this.clearing.rows.length === 4 ? TETRIS_FLASH_MS : CLEAR_FLASH_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (Date.now() >= this.flashEndsAt!) {
        this.clearing = undefined;
        this.stopTimer();
        this.schedule();
      } else {
        this.flashOn = !this.flashOn;
        if (this.clearing?.rows.length === 4) {
          const elapsed = TETRIS_FLASH_MS - (this.flashEndsAt! - Date.now());
          // Keep cleared columns erased when an effect is paused and resumed.
          this.wipePairs = Math.max(this.wipePairs,
            Math.min(WIDTH / 2, 1 + Math.floor(elapsed * (WIDTH / 2) / TETRIS_FLASH_MS)));
        }
        this.holdClearFrame();
      }
      this.changed();
    }, Math.min(FLASH_FRAME_MS, Math.max(0, this.flashEndsAt - Date.now())));
    this.timer.unref();
  }

  invalidate(): void { this.cached = undefined; }

  private changed(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  setWorking(working: boolean): void {
    if (this.disposed) return;
    if (this.working && !working) {
      this.finished = true;
      this.paused = true;
      this.stopTimer();
    }
    if (working) this.finished = false;
    this.working = working;
    this.changed();
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const key = (name: "c" | "v" | "p" | "r" | "q") =>
      matchesKey(data, name) || matchesKey(data, `shift+${name}`);
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || key("q")) {
      this.close();
      return;
    }
    if (this.tui.terminal.columns < MIN_WIDTH || this.tui.terminal.rows < MIN_HEIGHT) return;
    if (key("r")) {
      this.stopTimer();
      this.lockResets = 0;
      this.game = new Game();
      this.clearing = undefined;
      this.wipePairs = 0;
      this.paused = false;
      this.schedule();
      this.changed();
      return;
    }
    if (key("p") && !this.game.over) {
      this.paused = !this.paused;
      this.stopTimer();
      this.schedule();
      this.changed();
      return;
    }
    if (this.paused || this.game.over || this.clearing) return;

    const locked = this.game.locked;
    const grounded = this.game.grounded;
    let adjusted = false;
    if (matchesKey(data, "left")) adjusted = this.game.move(-1);
    else if (matchesKey(data, "right")) adjusted = this.game.move(1);
    else if (matchesKey(data, "down")) {
      if (!grounded) this.game.step(true);
    } else if (matchesKey(data, "up")) adjusted = this.game.rotate(1);
    else if (matchesKey(data, "space")) this.game.hardDrop();
    else if (key("c")) adjusted = this.game.rotate(-1);
    else if (key("v")) adjusted = this.game.rotate(1);
    else return;

    if (grounded && adjusted && this.lockResets < MAX_LOCK_RESETS) {
      this.lockAt = Date.now() + LOCK_DELAY_MS;
      this.lockResets++;
    }
    this.afterAction(locked);
  }

  render(width: number): string[] {
    const height = this.tui.terminal.rows;
    if (this.cached && width === this.cachedWidth && height === this.cachedHeight) return this.cached;
    const fit = (line: string) => truncateToWidth(line, Math.max(0, width), "");
    if (width < MIN_WIDTH || height < MIN_HEIGHT) {
      this.paused = true;
      this.stopTimer();
      this.invalidate();
      return ["TETRIS paused", "Resize to at least 32 x 15.", "P resumes; Esc returns to Pi."].slice(0, height).map(fit);
    }

    const compact = width < FULL_WIDTH || height < FULL_HEIGHT;
    const dim = (s: string) => this.theme.fg("dim", s);
    const accent = (s: string) => this.theme.fg("accent", s);
    const fourLines = this.clearing?.rows.length === 4;
    const border = fourLines && this.flashOn ? (s: string) => this.theme.fg("warning", s) : dim;
    const board = (this.clearing?.board ?? this.game.board).slice();
    const erased = (i: number) => fourLines && this.clearing!.rows.includes(Math.floor(i / WIDTH)) &&
      Math.abs(i % WIDTH - (WIDTH - 1) / 2) < this.wipePairs;
    if (fourLines) {
      for (const y of this.clearing!.rows) {
        board.fill(0, y * WIDTH + WIDTH / 2 - this.wipePairs, y * WIDTH + WIDTH / 2 + this.wipePairs);
      }
    }
    const highlighted = (i: number) => this.flashOn && this.clearing?.rows.includes(Math.floor(i / WIDTH));
    const color = (i: number) => highlighted(i)
      ? (fourLines ? 231 : 250) : COLORS[board[i]];
    const ghost = new Set<number>();
    if (!this.game.over && !this.clearing) {
      for (const [x, y] of this.game.cells({ ...this.game.active, y: this.game.landingY() })) {
        if (y >= 0) ghost.add(y * WIDTH + x);
      }
      for (const [x, y] of this.game.cells()) {
        if (y >= 0) board[y * WIDTH + x] = this.game.active.kind + 1;
      }
    }

    const status = this.game.over ? "" : this.paused ? "PAUSED"
      : fourLines ? "TETRIS!" : this.clearing ? `+${this.clearing.rows.length} LINE${this.clearing.rows.length > 1 ? "S" : ""}` : "";
    const side = [accent("TETRIS"), "", `Score ${this.game.score}`, `Lines ${this.game.lines}`,
      `Level ${this.game.level}`, "", dim(`╭ NEXT ${NAMES[this.game.next]} ╮`)];
    for (let y = 0; y < 2; y++) {
      const previewY = y + (this.game.next === 0 ? 1 : 0);
      let row = "";
      for (let x = 0; x < 4; x++) {
        row += BLOCKS[this.game.next][0].some(([px, py]) => px === x && py === previewY)
          ? TILES[this.game.next + 1] : "  ";
      }
      side.push(dim("│") + row + dim("│"));
    }
    side.push(dim("╰────────╯"));
    side.push(accent(status), this.finished ? accent("Pi finished") : dim(this.working ? "Pi working..." : "Pi idle"));

    const boardWidth = compact ? WIDTH : WIDTH * 2;
    const rows = [border(`╭${"─".repeat(boardWidth)}╮`)];
    for (let y = 0; y < HEIGHT; y += compact ? 2 : 1) {
      let row = border("│");
      for (let x = 0; x < WIDTH; x++) {
        const i = y * WIDTH + x;
        if (compact) {
          const upper = board[i];
          const lower = board[i + WIDTH];
          if (upper && lower && color(i) === color(i + WIDTH)) {
            row += `\x1b[38;5;${color(i)}m${highlighted(i) ? "█" : "▓"}${RESET}`;
          } else if (upper && lower) row += `\x1b[38;5;${color(i)};48;5;${color(i + WIDTH)}m▀${RESET}`;
          else if (upper) row += `\x1b[38;5;${color(i)}m${highlighted(i) ? "▀" : "⠛"}${RESET}`;
          else if (lower) row += `\x1b[38;5;${color(i + WIDTH)}m${highlighted(i + WIDTH) ? "▄" : "⣤"}${RESET}`;
          else row += erased(i) || erased(i + WIDTH) ? " " : dim(ghost.has(i) || ghost.has(i + WIDTH) ? "░" : "·");
        } else {
          row += erased(i) ? "  " : board[i]
            ? highlighted(i) ? `\x1b[38;5;${color(i)}m██${RESET}` : TILES[board[i]]
            : dim(ghost.has(i) ? "░░" : "· ");
        }
      }
      rows.push(row + border("│"));
    }
    rows.push(border(`╰${"─".repeat(boardWidth)}╯`));
    if (this.game.over) {
      const boxWidth = compact ? 10 : 16;
      const message = compact ? ["GAME", "OVER", ":("] : ["GAME OVER :("];
      const padding = compact ? 1 : 2;
      const boxHeight = message.length + padding * 2 + 2;
      const textTop = padding + 1;
      const left = 1 + Math.floor((boardWidth - boxWidth) / 2);
      const top = 1 + Math.floor((rows.length - 2 - boxHeight) / 2);
      for (let y = 0; y < boxHeight; y++) {
        const text = message[y - textTop] ?? "";
        const content = (" ".repeat(Math.floor((boxWidth - 2 - text.length) / 2)) + text).padEnd(boxWidth - 2);
        const line = y === 0 ? `┌${"─".repeat(boxWidth - 2)}┐`
          : y === boxHeight - 1 ? `└${"─".repeat(boxWidth - 2)}┘` : `│${content}│`;
        rows[top + y] = sliceByColumn(rows[top + y], 0, left) + this.theme.fg("error", line) +
          sliceByColumn(rows[top + y], left + boxWidth, boardWidth + 2 - left - boxWidth);
      }
    }
    const lines = rows.map((row, i) => row + "  " + (side[i] ?? ""));
    lines.push(dim("← → move  ↓ soft  Space drop"), dim("↑/V ↻  C ↺  P pause  R restart"), dim("Esc/Q back to Pi"));
    this.holdClearFrame();
    this.cached = lines.map(fit);
    this.cachedWidth = width;
    this.cachedHeight = height;
    return this.cached;
  }
}

export default function tetris(pi: ExtensionAPI): void {
  let saved: Game | undefined;
  let active: Tetris | undefined;
  let opening = false;
  let session = 0;

  const open = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Tetris needs Pi's interactive terminal mode.", "error");
      return;
    }
    if (opening) return;
    opening = true;
    const startedIn = session;
    try {
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        active = new Tetris(tui, theme, () => done(), saved ?? new Game(), saved !== undefined, !ctx.isIdle());
        return active;
      }, { overlay: true, overlayOptions: { width: FULL_WIDTH, anchor: "right-center", margin: 0 } });
    } finally {
      if (active) {
        if (startedIn === session) saved = active.state;
        active.dispose();
      }
      active = undefined;
      opening = false;
    }
  };

  pi.registerCommand("tetris", { description: "Play or resume Tetris (C/V rotate)", handler: (_args, ctx) => open(ctx) });
  pi.on("agent_start", () => { active?.setWorking(true); });
  pi.on("agent_settled", () => { active?.setWorking(false); });
  pi.on("session_shutdown", () => {
    session++;
    active?.close();
    saved = undefined;
  });
}
