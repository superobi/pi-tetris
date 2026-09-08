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

