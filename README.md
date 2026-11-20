# JamesHerdr

Personal [Herdr](https://herdr.dev) workspace layout, mods, and [Omarchy](https://omarchy.org) theme integration.

## Features

- **`activity-bar`**: Icon-only right navigation rail with tooltips to toggle `Files` and `Source Control` panels.
- **`projects-sidebar`**: Collapsible Spaces tree grouped by machine, showing nested tabs, agent icons/spinners, context menus, and a footer shortcut to **JamesHerdr Settings**.
- **`source-control`**: VS Code-inspired Source Control panel with multi-line commit composer, ephemeral AI commit message generation (`Generate`), split Commit/Push/Amend actions, `Staged Changes` / `Changes` with line counts and status tooltips, interactive commit `Graph`, and collapsible diff inspector.
- **`james-settings`**: Dedicated settings dialog to configure:
  - **Default Agent** (for the `+` menu and `Ctrl+Shift+A` shortcut)
  - **AI Commit** (CLI provider, auto-discovered local models, and editable prompt template)
  - **Omarchy Theme** (shown only on compatible Omarchy systems; installs/uninstalls the `theme-set.d` hook and triggers manual sync)
- **`james-tabs` & `james-new-menu`**: Custom tab bar with startup Omarchy theme sync and a clean `+` menu prioritizing the configured Default Agent and only showing genuinely installed CLIs.
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
