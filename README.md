# pi-tetris

Tetris in a pi overlay, playable while the agent works. Two TypeScript files, no
runtime dependencies, no build step. It uses pi's own terminal UI and keyboard
parser.

## Install

```sh
pi install git:github.com/superobi/pi-tetris@v1.0.0
```

Run `/reload` in an open session, or start a new one. Then type `/tetris`.

To try it for one run without installing:

```sh
pi -e git:github.com/superobi/pi-tetris
```

Remove it with `pi remove git:github.com/superobi/pi-tetris`.

## Play

`/tetris` opens the board on the right. It works while the agent is responding.
Esc returns to the prompt and keeps the game in memory; `/tetris` reopens it
paused, and P resumes. When the agent finishes its run, the game pauses and
shows "Pi finished".

| Key | Action |
| --- | --- |
| Left / Right | Move sideways |
| Down | Soft drop |
| Up | Rotate clockwise |
| Space | Hard drop |
| C | Rotate counterclockwise |
| V | Rotate clockwise |
| P | Pause / resume |
| R | Restart |
| Esc / Q | Return to pi, keeping this game |

C and V work with ordinary terminal input, including through tmux. Ctrl+C closes
the overlay.

## Behavior

- Seven-piece shuffle bag, beveled bricks, bordered next-piece preview, landing
  ghost, and basic wall and floor kicks. Texture is terminal characters only, so
  there are no image assets.
- Ten cleared lines advance a level. Gravity accelerates from 800 ms per row to a
  minimum of 80 ms. One to four line clears earn 100/300/500/800 points times the
  level. Soft and hard drops earn 1 and 2 points per row.
- Landing starts a 500 ms lock delay so you can slide or rotate into place.
  Moves and rotations while grounded refresh it, up to 5 times per piece.
- Completed rows blink for 100 ms. Four-line clears hold for 300 ms with a
  brighter highlight, a blinking border, "TETRIS!", and columns erased from the
  center outward. The agent stays responsive throughout.
- The full layout needs 42 columns by 25 rows. Smaller terminals switch to
  half-block cells, down to 32 by 15. Below that the game pauses until you resize
  and press P.
- One timeout drives gravity, locking, and the clear animation. Pausing, closing,
  restarting, and session shutdown cancel it. Unchanged frames are cached while
  the model streams output.
- Progress lasts for the current session. Restarting pi, switching sessions, or
  reloading extensions clears it. Game state never enters the model's context.

Gameplay tuning lives at the top of `extensions/tetris/game.ts`.

## Tests

```sh
npm test
```

Node's built-in runner checks the game rules and loads the extension through the
installed pi loader, so pi must be on PATH (or set `PI_PACKAGE_DIR` to its
package directory). Tests cover both keyboard encodings, lock delay and sliding,
the clear animation, timer cleanup, pause and resume, session changes, and
terminal sizing. Timing tests read the configured values, so changing speeds does
not require editing tests.

Built against pi 0.85 (`@earendil-works/pi-coding-agent`) and Node 22. Earlier pi
versions may need API adjustments.
