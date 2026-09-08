import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readHighScore, writeHighScore } from "./high-score.ts";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { BLOCKS, CLEAR_FLASH_MS, FLASH_FRAME_MS, Game, HEIGHT, LOCK_DELAY_MS,
  MAX_LOCK_RESETS, TETRIS_FLASH_MS, WIDTH, type LineClear } from "./game.ts";

const MIN_WIDTH = 32;
const MIN_HEIGHT = 15;
const FULL_WIDTH = 42;
const FULL_HEIGHT = 25;
const BIG_WIDTH = 64;
const BIG_HEIGHT = 45;
const RESET = "\x1b[0m";
// NES-style light/dark pairs sampled from the user's level-color reference.
// Repeat the readable 0–9 themes at higher levels, without the NES glitch colors.
const PALETTES = [
  [[60, 188, 252], [0, 88, 248]], [[184, 248, 24], [2, 168, 0]],
  [[248, 120, 248], [216, 0, 204]], [[88, 216, 84], [0, 88, 248]],
  [[89, 248, 152], [228, 36, 88]], [[104, 136, 252], [89, 248, 152]],
  [[124, 124, 124], [248, 56, 0]], [[168, 22, 32], [104, 68, 252]],
  [[248, 56, 0], [0, 88, 248]], [[252, 160, 68], [248, 56, 0]],
].map(([light, dark]) => {
  const white = "248;248;248";
  const mix = (a: number[], b: number[], amount: number) => a.map((v, i) => Math.round(v * (1 - amount) + b[i] * amount));
  // Seven shades within the theme; no independent rainbow colors.
  const faces = [[0, 0, 0], mix(light, [248, 248, 248], 0.7), mix(dark, [248, 248, 248], 0.45),
    light, mix(light, [248, 248, 248], 0.3), dark, mix(dark, [0, 0, 0], 0.3), mix(light, [0, 0, 0], 0.3)];
  const colors = faces.map(rgb => rgb.join(";"));
  const tiles = colors.map((base, kind) => {
    const rgb = faces[kind];
    const shadow = rgb.map(v => Math.round(v * 0.35)).join(";");
    // Preserve the small version's existing edge styles, with distinct faces.
    if (kind <= 3) return `\x1b[4;48;2;${base};38;2;${shadow}m▏▕${RESET}`;
    return `\x1b[48;2;${base};38;2;${white}m▔\x1b[4;38;2;${shadow}m▕${RESET}`;
  });
  const bigTiles = faces.map((rgb, kind) => {
    const shine = rgb.map(v => Math.round(v + (255 - v) * 0.35)).join(";");
    const shadow = rgb.map(v => Math.round(v * 0.6)).join(";");
    const part = (glyph: string, color: string) => `\x1b[48;2;${colors[kind]};38;2;${color}m${glyph}`;
    return [part("▛▀▀", shine) + part("▜", shadow) + RESET,
      part("▙", shine) + part("▄▄▟", shadow) + RESET];
  });
  return { colors, tiles, bigTiles, border: light.join(";") };
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
  private contact?: { at: number; renderedAt?: number; surface: string };
  private lockTrace: string[] = [];
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
  private selecting: boolean;
  private selectedLevel: number;
  private highScore: number;
  private persistScore: (score: number) => number;
  private big: boolean;

  private get minWidth(): number { return this.big ? BIG_WIDTH : MIN_WIDTH; }
  private get minHeight(): number { return this.big ? BIG_HEIGHT : MIN_HEIGHT; }

  constructor(tui: TUI, theme: Theme, done: () => void, game: Game, resumed: boolean, working: boolean,
    highScore: number, persistScore: (score: number) => number, big = false) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.game = game;
    this.big = big;
    this.selecting = !resumed;
    this.selectedLevel = game.startLevel;
    this.highScore = highScore;
    this.persistScore = persistScore;
    this.paused = resumed;
    this.working = working;
    this.schedule();
  }

  get state(): Game { return this.game; }
  get hasStarted(): boolean { return !this.selecting; }

  private checkpoint(): void {
    this.highScore = this.persistScore(Math.max(this.highScore, this.game.score));
  }

  diagnostics(): string {
    return [`Tetris lock trace 1: ${LOCK_DELAY_MS} ms`, `Source: ${import.meta.url}`,
      ...(this.lockTrace.length ? this.lockTrace : ["No locks recorded yet."])].join("\n");
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.gravityAt = undefined;
    this.lockAt = undefined;
    this.contact = undefined;
    this.flashEndsAt = undefined;
    this.flashOn = true;
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || this.selecting || this.paused || this.game.over || this.clearing) return;
    const now = Date.now();
    this.gravityAt ??= now + this.game.gravityMs;
    const grounded = this.game.grounded;
    if (grounded) {
      this.lockAt ??= now + LOCK_DELAY_MS;
      this.contact ??= { at: now,
        surface: this.game.cells().some(([, y]) => y === HEIGHT - 1) ? "floor" : "stack" };
    } else {
      this.contact = undefined;
      // After the reset limit, lifting off a ledge must not buy another delay.
      if (this.lockResets < MAX_LOCK_RESETS) this.lockAt = undefined;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const locked = this.game.locked;
      // A grounded piece reaches this callback only after its lock delay.
      this.game.step();
      this.gravityAt = Date.now() + this.game.gravityMs;
      this.afterAction(locked, "timer");
    }, Math.max(0, (grounded ? this.lockAt! : this.gravityAt) - now));
    this.timer.unref();
  }

  private afterAction(locked: number, cause: string): void {
    this.highScore = Math.max(this.highScore, this.game.score);
    if (this.game.over) this.checkpoint();
    if (this.game.locked !== locked) {
      const now = Date.now();
      const since = (at?: number) => at === undefined ? "none" : `${now - at}ms`;
      this.lockTrace.unshift(`#${this.game.locked} ${cause}; ${this.contact?.surface ?? "air"}; ` +
        `contact=${since(this.contact?.at)}; rendered=${since(this.contact?.renderedAt)}; ` +
        `past deadline=${since(this.lockAt)}; resets=${this.lockResets}`);
      this.lockTrace.length = Math.min(this.lockTrace.length, 6);
      this.stopTimer();
      this.lockResets = 0;
      this.clearing = this.game.lastClear;
      this.wipePairs = this.clearing ? 1 : 0;
    }
    this.schedule();
    this.changed();
  }

  private holdClearFrame(): void {
    if (!this.clearing || this.timer !== undefined || this.paused || this.disposed) return;
    // Start on the first rendered frame. A deadline keeps delayed frames from
    // extending the hold; the same timeout drives blinking and then gravity.
    const duration = this.clearing.rows.length === 4 ? TETRIS_FLASH_MS : CLEAR_FLASH_MS;
    this.flashEndsAt ??= Date.now() + duration;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (Date.now() >= this.flashEndsAt!) {
        this.clearing = undefined;
        this.stopTimer();
        this.schedule();
      } else {
        this.flashOn = !this.flashOn;
        const elapsed = duration - (this.flashEndsAt! - Date.now());
        // Keep cleared columns erased when an effect is paused and resumed.
        this.wipePairs = Math.max(this.wipePairs,
          Math.min(WIDTH / 2, 1 + Math.floor(elapsed * (WIDTH / 2) / duration)));
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
      this.checkpoint();
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
    this.checkpoint();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const key = (name: "c" | "v" | "d" | "p" | "r" | "q") =>
      matchesKey(data, name) || matchesKey(data, `shift+${name}`);
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || key("q")) {
      this.close();
      return;
    }
    if (this.tui.terminal.columns < this.minWidth || this.tui.terminal.rows < this.minHeight) return;
    if (key("r")) {
      this.checkpoint();
      this.stopTimer();
      this.lockResets = 0;
      this.game = new Game();
      this.clearing = undefined;
      this.wipePairs = 0;
      this.paused = false;
      this.selecting = true;
      this.schedule();
      this.changed();
      return;
    }
    if (this.selecting) {
      for (const [level, digit] of (["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const).entries()) {
        if (matchesKey(data, digit)) this.selectedLevel = level;
      }
      if (matchesKey(data, "left")) this.selectedLevel = Math.max(0, this.selectedLevel - 1);
      if (matchesKey(data, "right")) this.selectedLevel = Math.min(9, this.selectedLevel + 1);
      if (matchesKey(data, "up")) this.selectedLevel = Math.max(0, this.selectedLevel - 5);
      if (matchesKey(data, "down")) this.selectedLevel = Math.min(9, this.selectedLevel + 5);
      if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        this.game = new Game(Math.random, this.selectedLevel);
        this.selecting = false;
        this.paused = false;
        this.schedule();
      }
      this.changed();
      return;
    }
    if (key("p") && !this.game.over) {
      this.paused = !this.paused;
      this.stopTimer();
      this.checkpoint();
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
    else if (key("d")) {
      if (!this.game.hold()) return;
      this.stopTimer();
      this.lockResets = 0;
    } else return;

    if (grounded && adjusted && this.lockResets < MAX_LOCK_RESETS) {
      this.lockAt = Date.now() + LOCK_DELAY_MS;
      this.lockResets++;
    }
    this.afterAction(locked, `input ${JSON.stringify(data)}`);
  }

  render(width: number): string[] {
    const height = this.tui.terminal.rows;
    if (this.cached && width === this.cachedWidth && height === this.cachedHeight) return this.cached;
    const fit = (line: string) => truncateToWidth(line, Math.max(0, width), "");
    if (width < this.minWidth || height < this.minHeight) {
      this.paused = true;
      this.stopTimer();
      this.invalidate();
      return ["TETRIS paused", `Resize to at least ${this.minWidth} x ${this.minHeight}.`,
        "P resumes; Esc returns to Pi."].slice(0, height).map(fit);
    }

    const compact = !this.big && (width < FULL_WIDTH || height < FULL_HEIGHT);
    const cellWidth = this.big ? 4 : compact ? 1 : 2;
    const cellHeight = this.big ? 2 : 1;
    const dim = (s: string) => this.theme.fg("dim", s);
    const palette = PALETTES[(this.selecting ? this.selectedLevel : this.game.level) % PALETTES.length];
    const accent = (s: string) => `\x1b[38;2;${palette.border}m${s}${RESET}`;
    if (this.selecting) {
      const rows = [accent(this.big ? "TETRIS BIG" : "TETRIS"), "", "START LEVEL", ""];
      for (let y = 0; y < 2; y++) {
        rows.push(Array.from({ length: 5 }, (_, x) => {
          const level = y * 5 + x;
          return level === this.selectedLevel ? accent(`[${level}]`) : ` ${level} `;
        }).join(" "));
      }
      rows.push("", `High ${this.highScore}`, "", dim("0–9 / arrows choose"),
        dim("Enter / Space starts"), dim("Esc/Q back to Pi"));
      const boxWidth = 28;
      const pad = " ".repeat(Math.max(0, Math.floor((Math.min(width, this.big ? BIG_WIDTH : FULL_WIDTH) - boxWidth) / 2)));
      const panel = [accent(`╭${"─".repeat(boxWidth - 2)}╮`), ...rows.map(row => {
        const space = boxWidth - 2 - visibleWidth(row);
        return accent("│") + " ".repeat(Math.floor(space / 2)) + row +
          " ".repeat(Math.ceil(space / 2)) + accent("│");
      }), accent(`╰${"─".repeat(boxWidth - 2)}╯`)];
      this.cached = panel.map(row => fit(pad + row));
      this.cachedWidth = width;
      this.cachedHeight = height;
      return this.cached;
    }
    const fourLines = this.clearing?.rows.length === 4;
    const border = fourLines && this.flashOn ? (s: string) => this.theme.fg("warning", s) : accent;
    const board = (this.clearing?.board ?? this.game.board).slice();
    const erased = (i: number) => this.clearing?.rows.includes(Math.floor(i / WIDTH)) &&
      Math.abs(i % WIDTH - (WIDTH - 1) / 2) < this.wipePairs;
    if (this.clearing) {
      for (const y of this.clearing.rows) {
        board.fill(0, y * WIDTH + WIDTH / 2 - this.wipePairs, y * WIDTH + WIDTH / 2 + this.wipePairs);
      }
    }
    const highlighted = (i: number) => this.flashOn && this.clearing?.rows.includes(Math.floor(i / WIDTH));
    const color = (i: number) => highlighted(i)
      ? `5;${fourLines ? 231 : 250}` : `2;${palette.colors[board[i]]}`;
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
    const boardRows = compact ? HEIGHT / 2 : HEIGHT * cellHeight;
    const piStatus = this.finished ? accent("Pi finished") : dim(this.working ? "Pi working..." : "Pi idle");
    const rule = accent("─".repeat(this.big || compact ? 18 : 10));
    const center = (text: string, width: number, fill = " ") =>
      text.padStart(text.length + Math.max(0, Math.floor((width - text.length) / 2)), fill).padEnd(width, fill);
    const side = [`Top   ${this.highScore}`, `Score ${this.game.score}`,
      accent("─ ") + piStatus + accent(" ─"), compact && status ? accent(status) : ""];
    const preview = (label: string, kind?: number) => {
      const result = [accent(compact ? center(label, 8) : `╭${center(` ${label} `, this.big ? 16 : 8, "─")}╮`)];
      const hasBlock = (x: number, y: number) => kind !== undefined && BLOCKS[kind][0].some(([px, py]) => px === x && py === y);
      for (let y = 0; y < (compact ? 1 : 2 * cellHeight); y++) {
        const previewY = Math.floor(y / cellHeight) + (kind === 0 ? 1 : 0);
        let row = "";
        for (let x = 0; x < 4; x++) {
          if (compact) {
            const upper = hasBlock(x, previewY);
            const lower = hasBlock(x, previewY + 1);
            row += upper || lower ? `\x1b[38;2;${palette.colors[kind! + 1]}m${(upper ? lower ? "█" : "▀" : "▄").repeat(2)}${RESET}` : "  ";
          } else {
            row += hasBlock(x, previewY)
              ? this.big ? palette.bigTiles[kind! + 1][y % cellHeight] : palette.tiles[kind! + 1]
              : " ".repeat(this.big ? 4 : 2);
          }
        }
        result.push(compact ? row : accent("│") + row + accent("│"));
      }
      if (!compact) result.push(accent(`╰${"─".repeat(this.big ? 16 : 8)}╯`));
      return result;
    };
    const next = preview("NEXT", this.game.next);
    const held = preview("HOLD", this.game.held);
    side.push(...(compact ? next.map((row, i) => row + "  " + held[i]) : [...next, ...held]),
      rule, accent("LEVEL"), center(String(this.game.level).padStart(2, "0"), 5));
    if (!compact) side.push(status ? accent(status) : rule);
    while (side.length < boardRows - 1) side.push("");
    side.push(accent("Tetris Rate"), `${this.game.tetrisPercent.toFixed(0)}%`);

    const boardWidth = WIDTH * cellWidth;
    const lineCount = String(this.game.lines).padStart(4, "0");
    const lineLabel = compact ? `${lineCount.length > 4 ? "L" : "Lines"} ${lineCount}` : ` Lines - ${lineCount} `;
    const rows = [border(`╭${truncateToWidth(lineLabel, boardWidth, "").padEnd(boardWidth, "─")}╮`)];
    const gameOverCells: string[][] = [];
    for (let rowIndex = 0; rowIndex < boardRows; rowIndex++) {
      const y = compact ? rowIndex * 2 : Math.floor(rowIndex / cellHeight);
      let row = border("│");
      const cells: string[] | undefined = this.game.over ? [] : undefined;
      for (let x = 0; x < WIDTH; x++) {
        let cell: string;
        const i = y * WIDTH + x;
        if (compact) {
          const upper = board[i];
          const lower = board[i + WIDTH];
          if (upper && lower && color(i) === color(i + WIDTH)) {
            cell = `\x1b[38;${color(i)}m█${RESET}`;
          } else if (upper && lower) cell = `\x1b[38;${color(i)};48;${color(i + WIDTH)}m▀${RESET}`;
          else if (upper) cell = `\x1b[38;${color(i)}m▀${RESET}`;
          else if (lower) cell = `\x1b[38;${color(i + WIDTH)}m▄${RESET}`;
          else cell = erased(i) || erased(i + WIDTH) ? " " : dim(ghost.has(i) || ghost.has(i + WIDTH) ? "░" : " ");
        } else {
          cell = erased(i) ? " ".repeat(cellWidth) : board[i]
            ? highlighted(i) ? `\x1b[38;${color(i)}m${"█".repeat(cellWidth)}${RESET}`
              : this.big ? palette.bigTiles[board[i]][rowIndex % cellHeight] : palette.tiles[board[i]]
            : dim(ghost.has(i) ? this.big ? (rowIndex % cellHeight === 0 ? "┌──┐" : "└──┘") : "░░" : " ".repeat(cellWidth));
        }
        row += cell;
        cells?.push(cell);
      }
      if (cells) gameOverCells.push(cells);
      rows.push(row + border("│"));
    }
    rows.push(border(`╰${"─".repeat(boardWidth)}╯`));
    if (this.game.over) {
      const boxWidth = this.big ? 24 : compact ? 10 : 16;
      const message = compact ? ["GAME", "OVER", ":("] : ["GAME OVER :("];
      const padding = 1;
      const boxHeight = message.length + padding * 2 + 2;
      const textTop = padding + 1;
      const left = 1 + Math.floor((boardWidth - boxWidth) / 2);
      const top = 1 + Math.floor((rows.length - 2 - boxHeight) / 2);
      for (let y = 0; y < boxHeight; y++) {
        const text = message[y - textTop] ?? "";
        const content = (" ".repeat(Math.floor((boxWidth - 2 - text.length) / 2)) + text).padEnd(boxWidth - 2);
        const line = y === 0 ? `┌${"─".repeat(boxWidth - 2)}┐`
          : y === boxHeight - 1 ? `└${"─".repeat(boxWidth - 2)}┘` : `│${content}│`;
        // Keep complete styled cells on each side; slicing ANSI strings can
        // leak a brick's background into the box or replay colors out of order.
        const cells = gameOverCells[top + y - 1];
        rows[top + y] = border("│") + cells.slice(0, (left - 1) / cellWidth).join("") +
          RESET + this.theme.fg("error", line) + RESET +
          cells.slice((left + boxWidth - 1) / cellWidth).join("") + border("│");
      }
    }
    const lines = rows.map((row, i) => row + "  " + (side[i] ?? ""));
    lines.push(dim("← → move  ↓ soft  Space drop"), dim("↑/V ↻  C ↺  P pause  R restart"), dim("D hold  Esc/Q back to Pi"));
    if (this.contact) this.contact.renderedAt ??= Date.now();
    this.holdClearFrame();
    this.cached = lines.map(fit);
    this.cachedWidth = width;
    this.cachedHeight = height;
    return this.cached;
  }
}

export default function tetris(pi: ExtensionAPI): void {
  const saved = new Map<boolean, Game>();
  let active: Tetris | undefined;
  let opening = false;
  let session = 0;
  let lastDiagnostics = "Open /tetris and play until a piece locks first.";

  const open = async (ctx: ExtensionContext, big = false) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Tetris needs Pi's interactive terminal mode.", "error");
      return;
    }
    if (opening) return;
    const highScoreFile = join(getAgentDir(), "data", "tetris-highscore.json");
    let highScore = readHighScore(highScoreFile);
    let reportedError = false;
    const persistScore = (score: number) => {
      if (score <= highScore) return highScore;
      try {
        highScore = writeHighScore(highScoreFile, score);
      } catch {
        if (!reportedError) ctx.ui.notify("Tetris couldn't write the high-score file.", "warning");
        reportedError = true;
      }
      return Math.max(highScore, score);
    };
    opening = true;
    const startedIn = session;
    try {
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        active = new Tetris(tui, theme, () => done(), saved.get(big) ?? new Game(), saved.has(big),
          !ctx.isIdle(), highScore, persistScore, big);
        return active;
      }, { overlay: true, overlayOptions: { width: big ? BIG_WIDTH : FULL_WIDTH, anchor: "right-center", margin: 0 } });
    } finally {
      if (active) {
        lastDiagnostics = active.diagnostics();
        if (startedIn === session) {
          if (active.hasStarted) saved.set(big, active.state);
          else saved.delete(big);
        }
        active.dispose();
      }
      active = undefined;
      opening = false;
    }
  };

  pi.registerCommand("tetris", { description: "Play or resume Tetris (C/V rotate, D hold)", handler: (_args, ctx) => open(ctx) });
  pi.registerCommand("tetrisbig", { description: "Try larger Tetris bricks (64 x 45 terminal)", handler: (_args, ctx) => open(ctx, true) });
  pi.registerCommand("tetris-debug", { description: "Show timing of the last six piece locks", handler: async (_args, ctx) => {
    ctx.ui.notify(active?.diagnostics() ?? lastDiagnostics, "info");
  } });
  pi.on("agent_start", () => { active?.setWorking(true); });
  pi.on("agent_settled", () => { active?.setWorking(false); });
  pi.on("session_shutdown", () => {
    session++;
    active?.close();
    saved.clear();
  });
}
