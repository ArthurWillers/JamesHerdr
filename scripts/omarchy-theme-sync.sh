#!/usr/bin/env bash
set -euo pipefail

REPO_THEMES="${HOME}/Code/JamesHerdr/themes"
HERDR_THEMES="${HOME}/.config/herdr-app/themes"
CURRENT_THEME_LINK="${HOME}/.config/omarchy/current/theme"

resolve_slug() {
  if [[ -n "${1:-}" ]]; then
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr ' ' '-'
    return 0
  fi
  if command -v omarchy >/dev/null 2>&1; then
    omarchy theme current 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr ' ' '-'
    return 0
  fi
  if [[ -L "$CURRENT_THEME_LINK" || -d "$CURRENT_THEME_LINK" ]]; then
    basename "$(readlink -f "$CURRENT_THEME_LINK")"
    return 0
  fi
  return 1
}

slug="$(resolve_slug "${1:-}" || true)"
slug="${slug//$'\r'/}"
slug="${slug//$'\n'/}"
[[ -n "$slug" ]] || exit 0

mkdir -p "$REPO_THEMES" "$HERDR_THEMES"

repo_json="${REPO_THEMES}/${slug}.json"
herdr_theme="${HERDR_THEMES}/${slug}.json"
colors_toml=""
for candidate in \
  "${HOME}/.config/omarchy/themes/${slug}/colors.toml" \
  "/usr/share/omarchy/themes/${slug}/colors.toml" \
  "${CURRENT_THEME_LINK}/colors.toml"; do
  if [[ -f "$candidate" ]]; then
    colors_toml="$candidate"
    break
  fi
done

# Native themes live in REPO_THEMES and are symlinked; custom/local Omarchy
# themes are generated on the fly directly into HERDR_THEMES without dirtying the repo.
if [[ -f "$repo_json" ]]; then
  if [[ ! -e "$herdr_theme" ]]; then
    ln -sfn "$repo_json" "$herdr_theme"
  fi
elif [[ ! -f "$herdr_theme" && -f "$colors_toml" ]]; then
  python3 - "$colors_toml" "$herdr_theme" <<'PY'
import json, pathlib, re, sys

colors_path = pathlib.Path(sys.argv[1])
out_path = pathlib.Path(sys.argv[2])

c = {}
for line in colors_path.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    c[k.strip()] = v.strip().strip('"').strip("'")

def darken_hex(hex_color: str, factor: float = 0.85) -> str:
    m = re.fullmatch(r"#([0-9a-fA-F]{6})", hex_color or "")
    if not m:
        return hex_color
    r, g, b = (int(m.group(1)[i:i+2], 16) for i in (0, 2, 4))
    return "#{:02x}{:02x}{:02x}".format(
        max(0, min(255, int(r * factor))),
        max(0, min(255, int(g * factor))),
        max(0, min(255, int(b * factor))),
    )

bg = c.get("background")
fg = c.get("foreground")
if not bg or not fg:
    sys.exit(0)

theme = {
    "background": bg,
    "foreground": fg,
    "selection": c.get("selection") or c.get("lighter_background") or bg,
    "cursor": c.get("light_foreground") or fg,
    "ansi": [
        c.get("darker_background") or c.get("dark_background") or bg,
        c.get("red", fg),
        c.get("green", fg),
        c.get("yellow", fg),
        c.get("blue", fg),
        c.get("magenta", fg),
        c.get("cyan", fg),
        c.get("light_foreground") or fg,
        c.get("dark_foreground") or c.get("muted") or fg,
        c.get("bright_red") or c.get("red", fg),
        c.get("bright_green") or c.get("green", fg),
        c.get("bright_yellow") or c.get("yellow", fg),
        c.get("bright_blue") or c.get("blue", fg),
        c.get("bright_magenta") or c.get("magenta", fg),
        c.get("bright_cyan") or c.get("cyan", fg),
        c.get("bright_foreground") or fg,
    ],
    "colors": {
        "chrome": bg,
        "canvas": c.get("dark_background") or darken_hex(bg, 0.85),
    },
}

out_path.write_text(json.dumps(theme, indent=2) + "\n", encoding="utf-8")
PY
fi

if [[ -e "$herdr_theme" ]] && command -v herdr-app >/dev/null 2>&1; then
  herdr-app do app.theme "{\"name\":\"${slug}\"}" >/dev/null 2>&1 || true
fi
