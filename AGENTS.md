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

3. **i18n & AI Commit Prompt**:
   - Single master dictionary lives in `mods/james-chrome/i18n.js` (covers all 50 Omarchy locales in `SUPPORTED_LANGS`).
   - `james-chrome` (always mounted first in `sidebar`) publishes the active merged dictionary via `publishI18n()` into `shared("james.i18n.dict")`, `shared("james.i18n.lang")`, and `shared("james.i18n.langs")`.
   - All other mods use a tiny static 22-line `mods/*/i18n.js` client that reads `shared("james.i18n.*")` — NEVER copy the full dictionary into other mods.
   - Keep `DEFAULT_PROMPT` for AI Commit in English regardless of UI language.

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
