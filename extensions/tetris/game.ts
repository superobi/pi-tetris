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
export const BASE_GRAVITY_MS: number = 800;
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
  score = 0;
  lines = 0;
  locked = 0;
  over = false;
  lastClear?: LineClear;
  private bag: number[] = [];
  private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
    this.next = this.draw();
    this.spawn();
  }

  get level(): number { return 1 + Math.floor(this.lines / 10); }
  get gravityMs(): number {
    return Math.max(MIN_GRAVITY_MS, Math.round(BASE_GRAVITY_MS * GRAVITY_DECAY ** (this.level - 1)));
  }
  get grounded(): boolean { return !this.fits({ ...this.active, y: this.active.y + 1 }); }

  private draw(): number {
    if (!this.bag.length) {
      this.bag = NAMES.map((_, i) => i);
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop()!;
  }

  private spawn(): void {
    const kind = this.next;
    this.next = this.draw();
    this.active = { kind, rotation: 0, x: Math.floor((WIDTH - SHAPES[kind].length) / 2), y: 0 };
    this.over = !this.fits(this.active);
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
    this.score += LINE_POINTS[cleared] * this.level;
    this.lines += cleared;
    this.locked++;
    this.spawn();
  }
}
