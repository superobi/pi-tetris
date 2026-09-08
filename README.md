# Tetris for Pi

A small TypeScript extension that opens Tetris over Pi's terminal interface while
the agent keeps working. It uses Pi's existing runtime and UI, with no additional
runtime dependencies or build step.

## Install

```sh
pi install git:github.com/superobi/pi-tetris@v1.1.0
```

Then run `/reload` in an existing Pi session, or start a new one.

For development from a local clone:

```sh
pi install /absolute/path/to/pi-tetris
```

Keep the project directory in place, since Pi loads the extension from it.

## Play

Enter `/tetris` in Pi. Choose a starting level from 0 to 9 with the number
keys or arrows, then press Enter or Space. The command also works while the agent is responding.
Esc returns to the prompt and keeps your game in memory. `/tetris` reopens it
paused; P resumes. When Pi finishes its run, the game pauses and shows
"Pi finished". You can return to Pi or press P to keep playing.

For the larger-brick experiment, enter `/tetrisbig`. It uses four columns and
two rows per brick, with complete beveled edges and a larger next-piece preview.
It requires at least **64 columns × 45 rows** and pauses if the pane is smaller.
Return with Esc, then use `/tetris` to go back to the original size. Each command
keeps its own game in memory; both share the persistent high score.

| Key | Action |
| --- | --- |
| Left / Right | Move sideways |
| Down | Soft drop |
| Up | Rotate clockwise |
| Space | Hard drop |
| C | Rotate counterclockwise |
| V | Rotate clockwise |
| D | Hold / swap piece |
| P | Pause / resume |
| R | Return to the starting-level selector |
| Esc / Q | Return to Pi, keeping this game |

C, V, and D work with ordinary terminal input, including through tmux. Ctrl+C also
closes the game overlay.

D stores the current piece and brings in the next one. If you already hold a
piece, D swaps it with the current one without consuming the next preview.
You can hold once per placed piece. Replacements start at the top with their
original rotation and fresh gravity and landing timers. A blocked replacement
ends the game. NEXT and HOLD show graphic previews in every layout, with
centered titles. Compact mode places one-row half-block previews side by side.

## Size and behavior

- The game uses a 200-byte board, an NES-style reroll randomizer, character-based
  approximations of classic bricks with broad white faces, thin edges, and narrow
  highlights (simplified in the compact board),
  a bordered next-piece preview, and a landing ghost. Rotations include basic
  wall and floor kicks. Texture uses terminal characters and standard underlining,
  with solid half-blocks in the compact layout, so it needs no image assets or extra packages.
- The playfield has an empty background. Pieces, the next preview, and the border
  follow the chosen level's palette. Each piece has a distinct shade made from
  that theme's two reference colors, white, and black; there are no independent
  rainbow hues. This extends the original three-color NES scheme to distinguish
  all seven shapes. The ten level themes repeat as levels
  advance; higher-level NES glitch palettes are omitted. The small texture keeps the
  existing two-column, one-row brick size and needs no inline-image support.
- Piece selection first draws one of the seven shapes or a dummy slot. The dummy
  slot or a repeat of the previous draw triggers one fresh seven-way draw, accepted
  even if it repeats. There is no bag or drought cap. This approximates the
  [NES reroll rule](https://tetrissuomi.wordpress.com/wp-content/uploads/2020/04/nes_tetris_rng.pdf)
  using independent random draws; it does not emulate the console's frame-driven
  generator, exact piece sequences, or statistical biases.
- The starting-level selector sits inside a centered panel whose border follows
  the selected level's color.
- Ten cleared lines advance a level, starting from the selected 0–9 level.
  Gravity accelerates from 1,200 ms per row at level 0 to
  a minimum of 80 ms. Single/double/triple/four-line clears earn 100/300/500/800
  points times (level + 1). Soft/hard drops earn 1/2 points per row.
- Landing starts a 500 ms lock delay so you can slide or rotate into place.
  Successful moves and rotations while grounded refresh it, up to 5 times per
  piece. Down respects the delay; Space locks immediately. Sliding off a ledge
  lets the piece fall again.
- Completed rows blink between their normal colors and a highlight on animation
  frames (16 ms apart). One, two, or three lines hold for 100 ms; four lines hold
  for 300 ms with a brighter highlight, blinking border, and "TETRIS!". Four-line
  clears use the same center-out wipe as singles, doubles, and triples: all
  clears erase two columns at a time before the rows collapse. Gameplay holds
  during the effect while Pi remains responsive.
- The sidebar shows Tetris rate (TRT): lines cleared through Tetrises divided
  by total cleared lines, rounded to a whole percentage (0% before any clears).
  One Tetris gives 100% (4 / 4 lines); a single afterward lowers it to 80%
  (4 / 5 lines). Pieces that clear no lines do not affect the ratio.
  The counter lasts for the current game.
- The playfield's top border shows `Lines - 0000` (shortened in compact mode).
  The sidebar shows Top and Score as plain numbers, then NEXT/HOLD previews,
  LEVEL with its centered two-digit value, and Tetris Rate with its whole
  percentage below. The rate sits one row above the bottom border.
  No drought counter appears.
- The full layout fits 42 columns by 25 rows. Smaller terminals use half-block
  cells, down to 32 columns by 15 rows. A smaller pane pauses the game until you
  resize and press P.
- "GAME OVER :(" is centered inside a box over the stack, with one
  blank row above and below it. The compact layout wraps the message to fit.
  R returns to the level selector.
- One timeout schedules gravity, locking, or the line-clear flash. Pausing, closing,
  restarting, and session shutdown cancel it. Game over stops gravity. Unchanged
  frames are cached while Pi streams output.
- The high score persists in `data/tetris-highscore.json` under Pi's agent directory
  (normally `~/.pi/agent`). It updates on game over, pause, restart, closing the
  overlay, or Pi finishing. Only the record is stored, with no game-state save.
- Game progress lasts for the current Pi session. Restarting Pi, switching sessions,
  or reloading extensions clears it. Game state stays out of the model's context.

## Develop

From a local clone, run the extension without installing:

```sh
pi -e ./extensions/tetris/index.ts
```

Or use `npm start`, which runs the same command.

## Verify

```sh
npm test
```

Node's built-in test runner checks the game rules and loads the extension through
the installed Pi loader. Pi must be on PATH; `PI_PACKAGE_DIR` can instead point
to its installed package directory. Tests cover both keyboard encodings, landing
delay and sliding, clear animation, timer cleanup, completion, pause/resume,
session changes, and terminal sizing.

Gameplay tuning lives in `extensions/tetris/game.ts`. Timing and scoring tests
use the configured values and verify behavior at their boundaries, so adjusting
speeds or reset counts does not require editing tests. Broad sanity checks catch
wrong types, non-finite numbers, negative or extreme values, and inconsistent
gravity bounds. Zero lock resets is supported.

The three runtime source files total about 28 KB. This measures source size, not
process memory. Tested with Pi 0.84.4 (`@earendil-works/pi-coding-agent`) and Node
22.22.2. Earlier Pi versions may need API adjustments.

For the landing-delay investigation, `/tetris-debug` shows the last six locks
from your most recent game, including time since contact and its first rendered
frame. Reproduce the problem, press Esc, then run the command. The small trace
stays in memory and does not enter the model's context.
