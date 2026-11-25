# JamesHerdr

Personal [Herdr](https://herdr.dev) workspace layout, mods, and [Omarchy](https://omarchy.org) theme integration.

## Features

- **`better-sidebar` (customized)**: Based on `munza/herdr-mods/better-sidebar`, extended with the JamesHerdr Cockpit dock (`Dashboard`, `To-do`, `Runbook`, `Notes`, `Routines`, `GitHub` with live badges), collapsible spaces (click any space row to fold/unfold), background routines ticker, `~/` home space creation, and a compact footer opening **JamesHerdr Settings**.
- **`better-files` (customized)**: Based on `munza/herdr-mods/better-files`, adding a one-click whole-file `Copy` button, automatic native text selection on clean files, and a `Select` toggle for modified files with git gutter marks.
- **`james-dashboard`**: Cockpit-style agent-agnostic General Overview with live agent status counters, `Needs You` spotlight, `Apps` quick-launcher, General to-dos with priority picker, Global runbook shortcuts, and live General notes.
- **`james-todos`**: Per-Space and General to-do list with priorities (`High`/`Medium`/`Low`), expandable task notes, move between Space/General, filters, and 1-click launch with Default Agent.
- **`james-runbook`**: Per-Space and General command runbook with automatic script detection (`package.json`, `Makefile`, `Cargo.toml`), Shell / Agent / Split (multi-terminal in one tab) commands, and inline editing.
- **`james-routines`**: Scheduled commands and agent prompts supporting 24/7 OS-level execution (`crontab` / `systemd --user` on local or remote machines) or in-app Herdr timers, with remote log viewer.
- **`james-github`**: Zero-config GitHub hub (`gh api graphql`) for Pull Requests, Issues, and CI & GitHub Pages failures across all accessible repos/orgs, with filters, alert muting, and 1-click Default Agent launch.
- **`james-notes`**: Persistent Markdown scratchpad with per-Space and General scopes and auto-save.
- **`source-control`**: VS Code-inspired Source Control panel with header Pull/Push sync counters, AI commit message generation (Global + per-Space prompt & diff ignore patterns), Commit/Push/Amend actions, flat/tree file views with Material icons (`better-icons`) opening in `better-files`, a multi-lane interactive commit `Graph` (All/Branch toggle), and a dedicated centre diff tab (inline & side-by-side with syntax highlighting).
- **`james-settings`**: Unified settings dialog for **Default Agent**, **AI Commit**, **Sidebar** (`better-sidebar`), **Files** (`better-files`), **Alerts** (`better-alerts`), and **Omarchy**.
- **`james-tabs` & `james-new-menu`**: Custom tab bar with drag-and-drop tab merging into split panes, startup Omarchy theme sync, and a clean `+` menu showing only genuinely installed CLIs.
- **`james-chrome`, `james-pane`, `james-status`, `activity-bar`**: Top sidebar brand/chrome, shared icons & English UI dictionary, rounded pane header, status bar, and right activity rail.
- **`themes/`**: Bundled native Omarchy themes styled with unified sidebar/topbar chrome (`colors.chrome = background`) and darker panel contrast (`colors.canvas = dark_background`).

## External Mod Prerequisites

JamesHerdr uses two unmodified upstream mods from [munza/herdr-mods](https://github.com/munza/herdr-mods) (not vendored in this repo):

- **`better-alerts`**: Native Linux/Hyprland desktop notifications (`notify-send` + `hyprctl`) when agents need input or finish.
- **`better-icons`** *(optional, recommended)*: VS Code Material Icon Theme icons for `better-files` and `source-control` (must be **copied**, not symlinked, into `~/.config/herdr-app/mods/better-icons`).

## Installation

1. Clone the repository:

```bash
git clone https://github.com/ArthurWillers/JamesHerdr.git ~/Code/JamesHerdr
```

2. Install the required upstream mods from `munza/herdr-mods`:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/munza/herdr-mods.git /tmp/herdr-mods
git -C /tmp/herdr-mods sparse-checkout set better-alerts/mods/better-alerts better-icons/mods/better-icons
mkdir -p ~/.config/herdr-app/mods
cp -r /tmp/herdr-mods/better-alerts/mods/better-alerts ~/.config/herdr-app/mods/better-alerts
cp -r /tmp/herdr-mods/better-icons/mods/better-icons ~/.config/herdr-app/mods/better-icons
rm -rf /tmp/herdr-mods
```

3. Symlink the layout, JamesHerdr mods, themes, and helper script into `~/.config/herdr-app/`:

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

4. Switch Herdr to the `JamesHerdr` layout:

```bash
herdr-app do layout.switch '{"name":"JamesHerdr"}'
```

### Or just paste this prompt to your AI agent

```text
Read ~/.config/herdr-app/AGENTS.md, then install and configure the JamesHerdr layout on this machine:

1. Clone https://github.com/ArthurWillers/JamesHerdr.git into ~/Code/JamesHerdr (or pull latest if it already exists).
2. Install the required upstream mods from https://github.com/munza/herdr-mods into ~/.config/herdr-app/mods/ (by copying, NOT symlinking):
   - better-alerts/mods/better-alerts -> ~/.config/herdr-app/mods/better-alerts
   - better-icons/mods/better-icons -> ~/.config/herdr-app/mods/better-icons
3. Create ~/.config/herdr-app/{layouts,mods,themes,scripts} and symlink from ~/Code/JamesHerdr:
   - layouts/JamesHerdr.json -> ~/.config/herdr-app/layouts/JamesHerdr.json
   - every folder in mods/* -> ~/.config/herdr-app/mods/
   - every file in themes/*.json -> ~/.config/herdr-app/themes/
   - scripts/omarchy-theme-sync.sh -> ~/.config/herdr-app/scripts/omarchy-theme-sync.sh (ensure chmod +x).
4. Validate all installed mods by running `herdr-app check` on each mod in ~/.config/herdr-app/mods/.
5. If this system runs Omarchy with ~/.config/omarchy/hooks/theme-set.d, symlink ~/.config/herdr-app/scripts/omarchy-theme-sync.sh to ~/.config/omarchy/hooks/theme-set.d/herdr-theme-sync and run it once.
6. If Herdr is running, switch to the JamesHerdr layout with: herdr-app do layout.switch '{"name":"JamesHerdr"}'.
7. Report the installed paths, check results, and whether Omarchy theme sync was enabled.
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
