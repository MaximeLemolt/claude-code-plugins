# Changelog

All notable changes to the session-overview plugin. Newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.5] - 2026-11-20

### Changed

- **Hide order** is free text again, so any order can be set. The parts are `model`, `effort`,
  `git-branch`, `ctx-label`, `ctx-bar`, `ctx-percent`, `ctx-tokens` and `cost`, or `none`. Every
  part can be hidden now, the model and the percentage included.
- `/config` stores what is typed in a clean form: separators and case do not matter, and repeats
  are dropped. An unknown part is refused. Names from older versions (`bar`, `percent`, `tokens`,
  `branch`) are still read.
- The effort goes with the model, and the context label and tokens go with the context: a row
  with every part hidden is not drawn at all.

### Added

- **Show context label** setting: show or hide the word "context" before the bar.
- **Separator** setting: the text drawn between the parts, `|` by default.

## [0.4.4] - 2026-11-20

### Changed

- Colors follow the theme picked with `/theme` (dark, light, colorblind-friendly, ANSI, or the
  system's), instead of fixed colors made for a dark background. Model, branch and cost each have
  their own color. The context goes from green to warning, then orange, then red as it fills.

## [0.4.3] - 2026-11-20

### Fixed

- Model, effort and branch now show as soon as a session opens. Before, they stayed empty until
  the next command or for up to 30 seconds.

### Added

- Tests, run with `claude plugin test`. They cover how the row fits narrow terminals, the
  settings, number formatting and colors, plus scenarios for the terminal, the desktop app,
  `/compact` and a slow start.

## [0.4.2] - 2026-11-20

### Fixed

- In the terminal, the context now updates about a second after `/compact` instead of waiting
  for the next message. Claude Code's built-in security plugin hides the compaction events from
  other plugins, so the row now watches the end of the `/compact` command instead.

## [0.4.1] - 2026-11-20

### Added

- Narrow terminals: when the row does not fit, parts are hidden one by one, then a long branch
  name is shortened with an ellipsis. The model and the percentage always stay.
- **Hide order** setting in `/config`: which parts go first (four presets, or `none`).

## [0.4.0] - 2026-11-20

### Added

- Display settings in `/config`: show or hide the model, effort, branch and cost; show the context
  as a bar, a percentage, both, or not at all; show the context tokens or not.

### Changed

- The row is for the terminal only. In the desktop app the plugin stays idle and reads nothing.

## [0.3.7] - 2026-11-20

### Fixed

- After `/compact`, the context is read again a few times in the following seconds until it
  changes, instead of waiting for the next message.

## [0.3.6] - 2026-11-20

### Added

- Context tokens and window beside the percentage, e.g. `32% (64k/1M)`.

### Changed

- Switching models updates the context window at once.

## [0.3.5] - 2026-11-20

### Changed

- Model, effort and branch now update on the events that change them, such as a model switch,
  `/effort` or a change of folder, instead of frequent polling. A 30-second check remains as a
  safety net.
- Between turns, the row keeps the effort really used on the last turn.

## [0.3.4] - 2026-11-20

### Changed

- A missing figure no longer blanks the context or the cost: the row keeps the last value.
- After a compaction, the old figure is dimmed until a fresh one arrives.
- `/clear`, `/resume` and forks reset the context figure.

## [0.3.3] - 2026-11-20

### Fixed

- The effort chosen in the `/effort` picker is saved for each model. The row read only the
  global level, so it showed the wrong effort after each turn.

## [0.3.2] - 2026-11-20

### Fixed

- The context no longer shows the figure from before `/compact` until the next message.

## [0.3.1] - 2026-11-20

### Changed

- The session cost is shown in amber.

## [0.3.0] - 2026-11-20

### Changed

- The context is shown as a bar, e.g. `context ███░░░░░░░ 32%`. It is green below 45%, yellow below
  60% (past 60% it is time to hand the work to a fresh session), orange below 80%, and red above.

## [0.2.2] - 2026-11-20

### Fixed

- A new effort chosen with `/effort`, or kept when switching with `/model`, shows at once instead
  of after the next request.

## [0.2.1] - 2026-11-20

### Added

- First published version: a colored row above the prompt with the model, effort, git branch,
  context percentage and session cost.

[0.4.4]: https://github.com/MaximeLemolt/claude-code-plugins/commit/704165c
[0.4.3]: https://github.com/MaximeLemolt/claude-code-plugins/commit/f9384b5
[0.4.2]: https://github.com/MaximeLemolt/claude-code-plugins/commit/b8f19e5
[0.4.1]: https://github.com/MaximeLemolt/claude-code-plugins/commit/75a2078
[0.4.0]: https://github.com/MaximeLemolt/claude-code-plugins/commit/40369f4
[0.3.7]: https://github.com/MaximeLemolt/claude-code-plugins/commit/c7ca417
[0.3.6]: https://github.com/MaximeLemolt/claude-code-plugins/commit/05751d1
[0.3.5]: https://github.com/MaximeLemolt/claude-code-plugins/commit/2cd7c18
[0.3.4]: https://github.com/MaximeLemolt/claude-code-plugins/commit/1c5693a
[0.3.3]: https://github.com/MaximeLemolt/claude-code-plugins/commit/a5beecf
[0.3.2]: https://github.com/MaximeLemolt/claude-code-plugins/commit/cb9536b
[0.3.1]: https://github.com/MaximeLemolt/claude-code-plugins/commit/adc8aff
[0.3.0]: https://github.com/MaximeLemolt/claude-code-plugins/commit/bd98d03
[0.2.2]: https://github.com/MaximeLemolt/claude-code-plugins/commit/32b0254
[0.2.1]: https://github.com/MaximeLemolt/claude-code-plugins/commit/a07ec44
