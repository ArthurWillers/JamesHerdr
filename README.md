# JamesHerdr

Personal [Herdr](https://herdr.dev) workspace layout, mods, and [Omarchy](https://omarchy.org) theme integration.

## Features

- **`activity-bar`**: Icon-only right navigation rail with tooltips to toggle `Dashboard`, `Files`, `Source Control`, `To-do`, `Runbook`, and `Notes` panels.
- **`james-dashboard`**: Cockpit-style General Overview panel with live agent status counters/jump list, General to-dos, Global runbook shortcuts, General notes preview, and Spaces/Machines status.
- **`james-files`**: Lazy file browser with searchable file tree (↑/↓ + Enter), folder/file Git status indicators and tooltips, inline file editor with Auto-Save / `Ctrl+S`, Word Wrap (`Alt+Z`), in-file search, and a character-level inline HEAD Diff view (`Alt+D`) with per-hunk revert.
- **`james-todos`**: Per-Space and General to-do list with priorities (`High`/`Medium`/`Low`), expandable task notes, move between Space/General, filters (`All` / `Pending` / `Done`), and 1-click launch of any task (with its notes) using the configured Default Agent.
- **`james-runbook`**: Per-Space and General command runbook with automatic script detection from `package.json`, `Makefile`, and `Cargo.toml`, plus custom saved commands runnable in a new tab with 1 click.
- **`james-notes`**: Persistent Markdown scratchpad with per-Space and General scopes and automatic saving (without dirtying the git repository).
- **`projects-sidebar`**: Collapsible Spaces tree grouped by machine, showing nested tabs, agent icons/spinners, context menus, and a footer shortcut to **JamesHerdr Settings**.
- **`source-control`**: VS Code-inspired Source Control panel with multi-line commit composer, ephemeral AI commit message generation (`Generate`), split Commit/Push/Amend actions, `Staged Changes` / `Changes` with line counts and status tooltips, interactive commit `Graph`, and collapsible diff inspector.
- **`james-settings`**: Dedicated settings dialog to configure:
  - **Default Agent** (for the `+` menu and `Ctrl+Shift+A` shortcut)
  - **AI Commit** (CLI provider, auto-discovered local models, and editable prompt template — kept in English regardless of UI language)
  - **Language** (searchable selector supporting 50 locales, with `Auto (System)` detection across Linux, macOS, Windows, and Omarchy)
  - **Omarchy** (shown only on compatible Omarchy systems; groups Omarchy hooks such as `theme-set.d` theme sync)
- **`james-tabs` & `james-new-menu`**: Custom tab bar with automatic system/Omarchy language detection, startup Omarchy theme sync, and a clean `+` menu prioritizing the configured Default Agent and only showing genuinely installed CLIs.
- **`james-pane`**: Rounded pane header matching the terminal frame radius.
- **`themes/`**: Bundled native Omarchy themes styled with unified sidebar/topbar chrome (`colors.chrome = background`) and darker panel contrast (`colors.canvas = dark_background`).

## Installation

1. Clone the repository:

```bash
git clone https://github.com/ArthurWillers/JamesHerdr.git ~/Code/JamesHerdr
```

2. Symlink the layout, mods, themes, and helper script into `~/.config/herdr-app/`:

```bash
mkdir -p ~/.config/herdr-app/{layouts,mods,themes,scripts}

ln -sfn ~/Code/JamesHerdr/layouts/JamesHerdr.json ~/.config/herdr-app/layouts/JamesHerdr.json

for mod in ~/Code/JamesHerdr/mods/*; do
  ln -sfn "$mod" ~/.config/herdr-app/mods/"$(basename "$mod")"
done

for theme in ~/Code/JamesHerdr/themes/*.json; do
  ln -sfn "$theme" ~/.config/herdr-app/themes/"$(basename "$theme")"
done

ln -sfn ~/Code/JamesHerdr/scripts/omarchy-theme-sync.sh ~/.config/herdr-app/scripts/omarchy-theme-sync.sh
```

3. Switch Herdr to the `JamesHerdr` layout (or select it in the layout menu):

```bash
herdr-app do app.layout '{"name":"JamesHerdr"}'
```

### Or just paste this prompt to your AI agent

```text
Install and configure the JamesHerdr layout for Herdr on this machine:

1. Clone https://github.com/ArthurWillers/JamesHerdr.git into ~/Code/JamesHerdr (or pull latest if it already exists).
2. Create ~/.config/herdr-app/{layouts,mods,themes,scripts} and symlink:
   - layouts/JamesHerdr.json -> ~/.config/herdr-app/layouts/JamesHerdr.json
   - every folder in mods/* -> ~/.config/herdr-app/mods/
   - every file in themes/*.json -> ~/.config/herdr-app/themes/
   - scripts/omarchy-theme-sync.sh -> ~/.config/herdr-app/scripts/omarchy-theme-sync.sh (ensure it is executable with chmod +x).
3. Validate all installed mods by running `herdr-app check` on each symlinked mod in ~/.config/herdr-app/mods/.
4. Check if this system runs Omarchy with ~/.config/omarchy/hooks/theme-set.d:
   - If yes, symlink ~/.config/herdr-app/scripts/omarchy-theme-sync.sh to ~/.config/omarchy/hooks/theme-set.d/herdr-theme-sync and run it once so Herdr syncs with the current Omarchy theme (including generating a custom theme JSON on the fly if the active theme uses colors.toml).
   - If not on Omarchy, skip the hook step.
5. If Herdr is running, switch to the JamesHerdr layout with: herdr-app do app.layout '{"name":"JamesHerdr"}'.
6. Report the installed paths, check results, and whether Omarchy theme sync was enabled.
```

## Omarchy Theme Sync

JamesHerdr includes native Omarchy theme synchronization **without external plugins**:

- **23 native Omarchy themes** are bundled in `themes/` (including a customized `kanagawa.json`).
- **Any custom Omarchy v4+ / Aether theme** containing a `colors.toml` (e.g., in `~/.config/omarchy/themes/<name>/colors.toml`) is generated on the fly directly into `~/.config/herdr-app/themes/<name>.json` with the same `chrome = background` and `canvas = dark_background` styling — without modifying the repository.
- **Startup sync**: `james-tabs` checks the active Omarchy theme when Herdr starts and applies it automatically.

### Enabling live theme switching

On compatible Omarchy systems (with `~/.config/omarchy/hooks/theme-set.d`):

- **Via UI**: Open **JamesHerdr Settings → Omarchy Theme** and click **Install Hook**.
- **Via CLI**:

```bash
mkdir -p ~/.config/omarchy/hooks/theme-set.d
ln -sfn ~/.config/herdr-app/scripts/omarchy-theme-sync.sh ~/.config/omarchy/hooks/theme-set.d/herdr-theme-sync
```

> **Note:** Legacy third-party Omarchy themes without a `colors.toml` file (e.g., older themes that only ship `alacritty.toml` or `kitty.conf`) are not auto-generated.

## Reference

- Layout architecture, settings modal pattern, and UI ideas inspired by [quaresc/cockpit](https://github.com/quaresc/cockpit).
- Theme sync behavior inspired by [xvvhang/omarchy-herdr-theme-sync](https://github.com/xvvhang/omarchy-herdr-theme-sync).
- Icons from [Heroicons](https://heroicons.com/).

## License

MIT — Copyright (c) 2026 Arthur Willers. See [LICENSE](LICENSE).
