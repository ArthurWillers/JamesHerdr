# JamesHerdr

Personal [Herdr](https://herdr.dev) workspace layout, mods, and Kanagawa theme.

## Features

- **`projects-sidebar`**: Collapsible Spaces tree grouped by machine, showing nested tabs, agent icons/spinners, context menus, and a footer shortcut to **JamesHerdr Settings**.
- **`source-control`**: VS Code-inspired Source Control panel with multi-line commit composer, ephemeral AI commit message generation (`Generate`), split Commit/Push/Amend actions, `Staged Changes` / `Changes` with line counts and status tooltips, interactive commit `Graph`, and collapsible diff inspector.
- **`james-settings`**: Dedicated settings dialog to configure the **Default Agent** (for the `+` menu and `Ctrl+Shift+A` shortcut) and **AI Commit** (CLI provider, auto-discovered local models, and editable prompt template).
- **`james-tabs` & `james-new-menu`**: Custom tab bar with `Source Control` toggle and a clean `+` menu prioritizing the configured Default Agent and only showing genuinely installed CLIs.
- **`james-pane`**: Rounded pane header matching the terminal frame radius.
- **`themes/kanagawa.json`**: Kanagawa Wave color palette with darker canvas contrast.

## Reference

- Layout architecture, settings modal pattern, and UI ideas inspired by [quaresc/cockpit](https://github.com/quaresc/cockpit).
- Icons from [Heroicons](https://heroicons.com/).

## License

MIT — Copyright (c) 2026 Arthur Willers. See [LICENSE](LICENSE).
