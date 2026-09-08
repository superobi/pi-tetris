import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

// A missing or damaged record must never prevent a game from starting.
export function readHighScore(path: string): number {
  try {
    const { highScore } = JSON.parse(readFileSync(path, "utf8"));
    return Number.isSafeInteger(highScore) && highScore >= 0 ? highScore : 0;
  } catch { return 0; }
}

export function writeHighScore(path: string, score: number): number {
  if (!Number.isSafeInteger(score) || score < 0) throw new RangeError("Invalid high score.");
  const previous = readHighScore(path);
  if (score <= previous) return previous;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ highScore: score }) + "\n", { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return score;
}
