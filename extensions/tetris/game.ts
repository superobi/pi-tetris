export const WIDTH = 10;
export const HEIGHT = 20;
export const NAMES = ["I", "O", "T", "S", "Z", "J", "L"] as const;

type Point = readonly [number, number];
export type Piece = { kind: number; rotation: number; x: number; y: number };
export type LineClear = { rows: number[]; board: Uint8Array };

const SHAPES = [
  ["....", "####", "....", "...."],
  ["##", "##"],
  [".#.", "###", "..."],
  [".##", "##.", "..."],
  ["##.", ".##", "..."],
  ["#..", "###", "..."],
  ["..#", "###", "..."],
];

// Precompute four rotations about each shape's square bounding box.
export const BLOCKS: Point[][][] = SHAPES.map((shape) => {
  let cells: Point[] = [];
  shape.forEach((row, y) => [...row].forEach((cell, x) => {
    if (cell === "#") cells.push([x, y]);
  }));
  return Array.from({ length: 4 }, () => {
    const current = cells;
    cells = cells.map(([x, y]) => [shape.length - 1 - y, x]);
    return current;
  });
});

// Small, symmetric wall/floor kicks. This intentionally uses simpler rules than SRS.
const KICKS: Point[] = [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [0, -2]];

// Gameplay tuning. Tests use these settings without pinning their chosen values.
export const LINE_POINTS: readonly number[] = [0, 100, 300, 500, 800];
export const BASE_GRAVITY_MS: number = 1200;
export const GRAVITY_DECAY: number = 0.8;
export const MIN_GRAVITY_MS: number = 80;
export const CLEAR_FLASH_MS: number = 100;
export const TETRIS_FLASH_MS: number = 300;
export const FLASH_FRAME_MS: number = 16;
export const LOCK_DELAY_MS: number = 500;
export const MAX_LOCK_RESETS: number = 5;

export class Game {
  readonly board = new Uint8Array(WIDTH * HEIGHT);
  active!: Piece;
  next: number;
  held?: number;
  holdUsed = false;
  score = 0;
  lines = 0;
  tetrises = 0;
  locked = 0;
  over = false;
  lastClear?: LineClear;
  private previous = -1;
  private readonly random: () => number;

  readonly startLevel: number;

  constructor(random: () => number = Math.random, startLevel = 0) {
    if (!Number.isInteger(startLevel) || startLevel < 0 || startLevel > 9) {
      throw new RangeError("Starting level must be an integer from 0 to 9.");
    }
    this.startLevel = startLevel;
    this.random = random;
    this.next = this.draw();
    this.spawn();
  }

  get tetrisPercent(): number { return this.lines === 0 ? 0 : 100 * (4 * this.tetrises) / this.lines; }
  get level(): number { return this.startLevel + Math.floor(this.lines / 10); }
  get gravityMs(): number {
    return Math.max(MIN_GRAVITY_MS, Math.round(BASE_GRAVITY_MS * GRAVITY_DECAY ** this.level));
  }
  get grounded(): boolean { return !this.fits({ ...this.active, y: this.active.y + 1 }); }

  private draw(): number {
    // NES-style one-reroll rule. Uses independent random draws rather than
    // emulating the NES's frame-driven generator and its correlated results.
    let kind = Math.floor(this.random() * (NAMES.length + 1));
    if (kind === NAMES.length || kind === this.previous) kind = Math.floor(this.random() * NAMES.length);
    this.previous = kind;
    return kind;
  }

  private spawn(kind?: number): void {
    if (kind === undefined) {
      kind = this.next;
      this.next = this.draw();
    }
    this.active = { kind, rotation: 0, x: Math.floor((WIDTH - SHAPES[kind].length) / 2), y: 0 };
    this.over = !this.fits(this.active);
  }

  hold(): boolean {
    if (this.over || this.holdUsed) return false;
    const kind = this.active.kind;
    this.spawn(this.held);
    this.held = kind;
    this.holdUsed = true;
    return true;
  }

  cells(piece: Piece = this.active): Point[] {
    return BLOCKS[piece.kind][piece.rotation].map(([x, y]) => [x + piece.x, y + piece.y]);
  }

  fits(piece: Piece): boolean {
    for (const [dx, dy] of BLOCKS[piece.kind][piece.rotation]) {
      const x = piece.x + dx;
      const y = piece.y + dy;
      if (!(x >= 0 && x < WIDTH && y < HEIGHT && (y < 0 || this.board[y * WIDTH + x] === 0))) return false;
    }
    return true;
  }

  move(dx: number, dy = 0): boolean {
    if (this.over) return false;
    const candidate = { ...this.active, x: this.active.x + dx, y: this.active.y + dy };
    if (!this.fits(candidate)) return false;
    this.active = candidate;
    return true;
  }

  rotate(direction: -1 | 1): boolean {
    if (this.over || this.active.kind === 1) return false;
    const rotation = (this.active.rotation + direction + 4) % 4;
    for (const [dx, dy] of KICKS) {
      const candidate = { ...this.active, rotation, x: this.active.x + dx, y: this.active.y + dy };
      if (this.fits(candidate)) {
        this.active = candidate;
        return true;
      }
    }
    return false;
  }

  step(softDrop = false): void {
    if (this.over) return;
    if (this.move(0, 1)) {
      if (softDrop) this.score++;
    } else {
      this.lock();
    }
  }

  landingY(): number {
    const candidate = { ...this.active };
    do {
      candidate.y++;
    } while (this.fits(candidate));
    return candidate.y - 1;
  }

  hardDrop(): void {
    if (this.over) return;
    const y = this.landingY();
    this.score += 2 * (y - this.active.y);
    this.active.y = y;
    this.lock();
  }

  private lock(): void {
    this.lastClear = undefined;
    const cells = this.cells();
    if (cells.some(([, y]) => y < 0)) {
      this.over = true;
      return;
    }
    for (const [x, y] of cells) this.board[y * WIDTH + x] = this.active.kind + 1;

    // Compact surviving rows down in place, then zero the vacated rows.
    let target = HEIGHT - 1;
    for (let source = HEIGHT - 1; source >= 0; source--) {
      const start = source * WIDTH;
      if (this.board.subarray(start, start + WIDTH).every((cell) => cell !== 0)) {
        // No rows have moved before the first full row.
        // Capture the intact board once, only when a clear actually happens.
        this.lastClear ??= { rows: [], board: this.board.slice() };
        this.lastClear.rows.push(source);
        continue;
      }
      if (source !== target) this.board.copyWithin(target * WIDTH, start, start + WIDTH);
      target--;
    }
    const cleared = target + 1;
    this.board.fill(0, 0, cleared * WIDTH);
    this.score += LINE_POINTS[cleared] * (this.level + 1);
    this.lines += cleared;
    if (cleared === 4) this.tetrises++;
    this.locked++;
    this.holdUsed = false;
    this.spawn();
  }
}
