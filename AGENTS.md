# JamesHerdr — Agent Guidelines

Personal Herdr desktop layout, mods, themes, and i18n repository (`/home/avw/Code/JamesHerdr`, symlinked into `~/.config/herdr-app/`).

## Core Product Rules

1. **Never show uninstalled agents**:
   - Herdr's `knownAgents()` can report `installed: true` for agents that only have `mise` shims in `PATH`.
   - Always cross-check `knownAgents({ on: machine })` with `exec("sh", ["-c", checkScript], machine ? { on: machine } : undefined)` that strips `mise/(shims|command-wrappers)` from `PATH` and checks `~/.local/share/mise/installs/<tool>/latest` or real non-mise binaries.
   - Only show genuinely installed agents (+ `Default` when applicable).

2. **100% Agent-Agnostic**:
   - Never hardcode Claude-only or Codex-only metrics, spend cards, or UI assumptions.
   - Any agent feature (Runbooks, Routines, To-dos, AI Commit) must work with the user's configured Default Agent (`shared("james.defaultAgent")`) or any installed CLI agent detected via `knownAgents()`.

3. **English-Only UI & Unified Mods**:
   - UI is **English-only** (`mods/james-chrome/i18n.js` holds the single English dictionary `EN` and publishes it to `shared("james.i18n.dict")`).
   - Layout uses `better-sidebar` (vendored & customized with Cockpit dock, collapsible spaces, routines ticker, and `~/` home space creation), `source-control`, and unified `james-settings` (which also edits `better-sidebar/mod.json`, `better-files/mod.json`, and `better-alerts/mod.json`).
   - External unmodified prerequisites (installed in `~/.config/herdr-app/mods/`, not tracked in this repo): `better-files`, `better-alerts`, and `better-icons` from `https://github.com/munza/herdr-mods`.
   - Keep `DEFAULT_PROMPT` for AI Commit in English.

## GPUI / Herdr Technical Rules

- **Validate every edited mod** before finishing:
  ```bash
  herdr-app check /home/avw/.config/herdr-app/mods/<mod-name>
  ```
- **Colors**: Never pass `"transparent"` to `.bg(...)`. Use `.when(Boolean(color), d => d.bg(color))`.
- **Flex grow**: Always pass a numeric weight: `.flex_grow(1)`, `.flex_grow(2)`.
- **Rounded containers**: Children with backgrounds inside `.rounded(10).overflow_hidden()` need `.rounded_t(9)` / `.rounded_b(9)` to prevent square corner bleed.
- **Timers**: Always use the callback's `timerCx` inside `cx.timer.after(ms, (timerCx) => ...)` and `cx.timer.every(ms, (timerCx) => ...)`, never an outer expired `cx`. Guard side effects in `init()` with `if (!checking())`.
- **ExecResult**: `exec()` returns `{ code, stdout, stderr }` (check `res.code !== 0`, NOT `res.status`).
- **Tooltips / Popups**: Avoid `Popup` tooltips on buttons near the top edge of the window (they get clamped over the trigger and block clicks); prefer explicit labeled buttons or properly positioned triggers. Wrap `Popup` in `div().flex_1().min_w(0)` when distributing items evenly in an `h_flex()`.
- **EditorState lifecycle**: Never call `EditorState.new()` or `.release()` synchronously inside `render()`; defer releases with `cx.timer.after(100, () => ed.release())`.
