import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, knownAgents, exec, run, openOverlay, closeOverlay, props, window, keys, shared, setShared, home } from "herdr";
import { tr } from "./i18n.js";

// The last agents each machine reported, shown at once while knownAgents() checks again.
const KNOWN = "new-menu.agents";

function shortcut(name) {
  const k = keys().find(b => (b.section === "global" || b.section === "layout:JamesHerdr") && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export default class NewMenu extends View {
  init(_props, cx) {
    const machine = spaces().find(s => s.active)?.machine;
    const where = machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async cx => {
      try {
        const checkScript =
          'CLEAN_PATH=$(printf "%s" "$PATH" | tr ":" "\\n" | grep -vE "mise/(shims|command-wrappers)" | tr "\\n" ":"); ' +
          "check_one() { " +
          '  bin="$1"; mdir="$2"; ' +
          '  if [ -e "$HOME/.local/share/mise/installs/$mdir/latest" ]; then printf "%s\\n" "$bin"; return; fi; ' +
          '  p=$(PATH="$CLEAN_PATH:$HOME/.local/bin:/usr/local/bin:/usr/bin" command -v "$bin" 2>/dev/null || true); ' +
          '  if [ -n "$p" ] && ! { head -c 2 "$p" 2>/dev/null | grep -q "^#!" && grep -q "mise" "$p" 2>/dev/null; }; then ' +
          '    printf "%s\\n" "$bin"; ' +
          "  fi; " +
          "}; " +
          "check_one agy antigravity-cli; " +
          "check_one claude claude; " +
          "check_one codex codex; " +
          "check_one opencode opencode; " +
          "check_one gemini gemini-cli; " +
          "check_one pi pi; " +
          "check_one cursor-agent cursor-agent; " +
          "check_one kimi kimi-code; " +
          "check_one qwen qwen-code;";
        const [all, realRes] = await Promise.all([
          knownAgents({ on: machine }),
          machine ? Promise.resolve({ code: 1, stdout: "" }) : exec("sh", ["-c", checkScript]).catch(() => ({ code: 1, stdout: "" })),
        ]);
        const realBins = new Set((realRes.code === 0 ? realRes.stdout : "").split("\n").map(s => s.trim()).filter(Boolean));
        this.agents = (all ?? []).filter(a => {
          if (!a.installed) return false;
          if (realRes.code === 0) {
            const bin = a.run?.[0] ?? "";
            return realBins.has(bin) || realBins.has(a.key);
          }
          return true;
        });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      }
      catch { this.failed = true; }
      cx.notify();
    });
  }
  row(id, icon, name, action, hint = "", enabled = true) {
    const t = theme();
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, el => el.hover(s => s.bg(t.selected)))
      .on_click(() => { if (enabled) { closeOverlay(props().overlay); action(); } })
      .child(icon).child(div().flex_1().min_w(0).truncate().child(name)).child(div().text_size(11).text_color(t.dim).child(hint));
  }
  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const defKey = shared("james.defaultAgent")?.key ?? null;
    const installedAll = this.agents.filter(a => a.installed);
    const defaultAgent = defKey ? installedAll.find(a => a.key === defKey) : null;
    const installed = defaultAgent ? installedAll.filter(a => a.key !== defaultAgent.key) : installedAll;
    const choices = installed;
    const extraH = defaultAgent ? 46 : 0;
    return v_flex().min_h(0).w_full().h(Math.min(540, 172 + extraH + Math.max(1, choices.length + (this.failed ? 1 : 0)) * 31)).bg(t.popover).p(5).text_size(12.8)
      .id("new-menu").track_focus(this.handle)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const ordered = defaultAgent ? [defaultAgent, ...installed] : installed;
        const agent = /^[1-9]$/.test(e.key) ? ordered[Number(e.key) - 1] : null;
        if (!agent) return;
        closeOverlay(props().overlay);
        run("tab.new", { name: agent.name, space: space?.id, argv: agent.run });
      })
      .when(Boolean(defaultAgent), el => el
        .child(this.row(
          `default-${defaultAgent.key}`,
          defaultAgent.tint ? svg(defaultAgent.icon).size(14).flex_none().text_color(t.accent) : image(defaultAgent.icon).w(14).h(14).flex_none(),
          tr("menu.default_suffix", { name: defaultAgent.name }),
          () => run("tab.new", { name: defaultAgent.name, space: space?.id, argv: defaultAgent.run }),
          shortcut("james-tabs.default_agent") || "1"
        ))
        .child(div().h(1).mx(4).my(4).bg(t.border))
      )
      .child(this.row("terminal", svg("icons/shell.svg").size(14), tr("menu.terminal"), () => run("tab.new", { space: space?.id }), shortcut("tab.new")))
      .when(choices.length > 0 || this.failed || this.agents.length === 0, el => el
        .child(div().px(9).pt(8).pb(4).text_size(11).text_color(t.dim).child(tr("menu.start_agent")))
        .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
          .children(choices.map((a, i) => {
            const num = defaultAgent ? i + 2 : i + 1;
            return this.row(a.key, a.tint ? svg(a.icon).size(14).flex_none().text_color(t.foreground) : image(a.icon).w(14).h(14).flex_none(), a.name,
              () => run("tab.new", { name: a.name, space: space?.id, argv: a.run }), a.installed ? (num <= 9 ? String(num) : "") : tr("menu.not_installed"), a.installed);
          }))
          .when(this.failed || this.agents.length === 0, el => el.child(div().px(9).py(6).text_color(t.dim).child(this.failed ? tr("menu.check_failed") : tr("menu.checking_agents"))))))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(this.row("space", div().w(14).child("+"), tr("menu.new_space"), () => run("space.new", { folder: home() }), shortcut("space.new")))
      .child(this.row("worktree", svg("mods/workspace-chrome/branch.svg").size(14), tr("menu.new_worktree"), () => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "new" } }), "", Boolean(space)))
      .child(this.row("worktree-open", svg("mods/workspace-chrome/branch.svg").size(14), tr("menu.open_worktree"), () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "open" } }), "", Boolean(space)));
  }
}
