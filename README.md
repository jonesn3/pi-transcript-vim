# pi-transcript-vim

Vim-style navigation for [pi](https://pi.dev)'s fullscreen transcript, plus a one-key jump that opens the whole transcript in Neovim with pi's colors intact.

## Install

```bash
pi install git:github.com/jonesn3/pi-transcript-vim
```

Then run `/reload` in open sessions.

## Usage

Press `ctrl+q` to enter transcript mode. A `-- TRANSCRIPT --` line above the editor shows that it is active. Every other key is swallowed until you leave, so nothing leaks into your prompt.

| Key | Action |
|---|---|
| `j` / `k`, `ctrl+e` / `ctrl+y` | Line down / up (counts work: `10j`) |
| `ctrl+d` / `ctrl+u`, `d` / `u` | Half page down / up |
| `ctrl+f` / `ctrl+b` | Page down / up |
| `gg` / `G` | Top / bottom |
| `{` / `}` | Previous / next of your prompts |
| `/` | Search; type, `Enter` to commit, then `n` / `N` |
| `v` | Open the transcript in `$EDITOR`, stay in transcript mode afterwards |
| `ctrl+q` | Open the transcript in `$EDITOR`, return to the prompt afterwards |
| `Esc` | Close search, or leave transcript mode |
| `i`, `q` | Leave transcript mode |

`ctrl+q ctrl+q` is the shortcut for jumping straight into the editor.

### Neovim

With `nvim` as `$VISUAL` or `$EDITOR`, the transcript opens in a terminal buffer (`nvim_open_term`) that renders pi's ANSI output as-is: the same syntax highlighting, diffs, and theme colors. No Neovim plugins or config changes are needed. The cursor starts at the line you were looking at in pi. Visual mode, yanking to `"+`, and search all work; the buffer is read-only.

Other editors get plain text. `vim` and `nano` open at the current line.

## Required keybinding change

pi binds `Enter` to "next search match" by default, which stops transcript mode from seeing it. Move next/previous match elsewhere in `~/.pi/agent/keybindings.json`:

```json
{
  "tui.altScreen.searchNext": "ctrl+n",
  "tui.altScreen.searchPrevious": "ctrl+p"
}
```

Without it, search still works, but `Enter` jumps to the next match instead of committing the search, so `n` / `N` are not reachable.

## Limitations

- Fullscreen TUI mode only (the default). Regular mode leaves scrollback to the terminal.
- Search, prompt jumps, and transcript export use pi internals that are not part of the public extension API, so a pi update can break them.
- The editor view is the rendered transcript: lines are wrapped at pi's width, images are omitted, and collapsed tool output stays collapsed (`ctrl+o` before opening to include it).
