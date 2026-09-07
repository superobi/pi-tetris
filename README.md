# pi-tetris

Play Tetris in your terminal while pi works. Open it with `/tetris` and return
to your conversation whenever you're ready.

## Install

```sh
pi install git:github.com/superobi/pi-tetris@v1.0.2
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

## Features

- **Play while pi works.** The game pauses when the agent finishes, so you know
  your response is ready.
- **Plan your next move.** See the next piece and an outline of where your
  current piece will land.
- **Chase a higher score.** Clear lines to level up as the pieces fall faster.
- **Colorful terminal graphics.** Shaded bricks and flashing line clears, with
  a special animation for clearing four lines at once.
- **Pause and come back.** Return to your conversation, then reopen `/tetris`
  to resume your game.
- **Fits smaller terminals.** The board switches to a compact layout when
  space is tight.

### Before you play

The game needs at least 32 columns by 15 rows. Progress lasts only for the
current pi session: restarting pi, switching sessions, or running `/reload`
clears it. There are no saved games between sessions.

## Contributing

This branch (`main`) carries only the extension itself, so `pi install` and
`pi -e` stay small. Tests, `package-lock.json`, and tuning notes live on
[`develop`](https://github.com/superobi/pi-tetris/tree/develop):

```sh
git clone https://github.com/superobi/pi-tetris.git
cd pi-tetris
git checkout develop
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
