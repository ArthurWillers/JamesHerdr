import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, nextCommand, knownAgents, exec, notify, home, readTextFile, checking } from "herdr";
import { tr } from "./i18n.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.dragging = false;
    this.dragStart = null;
    this.dragPos = null;
    this.dragName = "";
    this.dragTarget = null;
    this.scroll = ScrollHandle.new();
    const langPath = `${home()}/.config/omarchy/language`;
    const syncSystemLang = async () => {
      try {
        const raw = await readTextFile(langPath);
        const code = (raw ?? "").trim();
        if (code) {
          if (code !== shared("james.lang")) setShared("james.lang", code);
          return true;
        }
      } catch {
        // not on Omarchy or file absent
      }
      if (!shared("james.lang")) {
        let sysLocale = "";
        try {
          const r = await exec("sh", [
            "-c",
            'printf "%s" "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"',
          ]);
          sysLocale = (r.stdout ?? "").trim();
        } catch {
          // ignore on non-POSIX shells
        }
        if (!sysLocale) {
          try {
            sysLocale = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
          } catch {
            sysLocale = "";
          }
        }
        if (sysLocale) setShared("james.lang", sysLocale);
      }
      return false;
    };
    if (!checking()) {
      cx.spawn(async () => {
        const hasOmarchyLang = await syncSystemLang();
        if (!hasOmarchyLang) return;
        cx.timer.every(3000, () => {
          if ((shared("james.langMode") ?? "auto") === "auto") {
            cx.spawn(async () => {
              await syncSystemLang();
            });
          }
        });
      });
    }
    cx.spawn(async () => {
      try {
        const r = await exec("sh", [
          "-c",
          'SLUG=""; ' +
            'if command -v omarchy >/dev/null 2>&1; then SLUG="$(omarchy theme current 2>/dev/null | tr "[:upper:]" "[:lower:]" | tr " " "-")"; fi; ' +
            'if [ -z "$SLUG" ]; then LINK="$HOME/.config/omarchy/current/theme"; if [ -L "$LINK" ] || [ -d "$LINK" ]; then SLUG="$(basename "$(readlink -f "$LINK")")"; fi; fi; ' +
            '[ -n "$SLUG" ] || exit 0; ' +
            'if [ ! -e "$HOME/.config/herdr-app/themes/$SLUG.json" ]; then ' +
            '  for s in "$HOME/Code/JamesHerdr/scripts/omarchy-theme-sync.sh" "$HOME/.config/herdr-app/scripts/omarchy-theme-sync.sh"; do ' +
            '    if [ -x "$s" ]; then "$s" "$SLUG" >/dev/null 2>&1 || true; break; fi; ' +
            '  done; ' +
            'fi; ' +
            'if [ -e "$HOME/.config/herdr-app/themes/$SLUG.json" ]; then printf "%s" "$SLUG"; fi',
        ]);
        const slug = (r.stdout ?? "").trim();
        if (slug) run("app.theme", { name: slug });
      } catch {
        // ignore if not on Omarchy
      }
    });
    if (!shared("james.omarchyInitialized")) {
      cx.spawn(async () => {
        try {
          const r = await exec("sh", ["-c", "command -v omarchy-default-agent >/dev/null 2>&1 && omarchy-default-agent || true"]);
          const sysBin = (r.stdout ?? "").trim().toLowerCase();
          if (sysBin) {
            const list = await knownAgents({}).catch(() => []);
            const match = (list ?? []).find(a =>
              (a.run?.[0] ?? "").toLowerCase() === sysBin ||
              a.key.toLowerCase() === sysBin ||
              (sysBin === "agy" && a.key.toLowerCase().includes("antigravity"))
            );
            if (match && !shared("james.defaultAgent")) {
              setShared("james.defaultAgent", {
                key: match.key,
                name: match.name,
                icon: match.icon,
                tint: match.tint,
                run: match.run,
              });
            }
            const aiCfg = shared("james-changes.ai") ?? {};
            if (!aiCfg.provider) {
              const prov = sysBin === "antigravity" ? "agy" : sysBin;
              setShared("james-changes.ai", { ...aiCfg, provider: prov });
            }
          }
        } catch {
          // ignore if not on Omarchy
        } finally {
          setShared("james.omarchyInitialized", true);
        }
      });
    }
    const aiCfgCheck = shared("james-changes.ai") ?? {};
    if (aiCfgCheck.provider && aiCfgCheck.model) {
      cx.spawn(async () => {
        try {
          const prov = aiCfgCheck.provider.toLowerCase();
          const pathExport = 'export PATH="$HOME/.local/share/mise/installs/antigravity-cli/latest:$HOME/.local/share/mise/command-wrappers/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:$PATH"; ';
          let cmd = pathExport;
          if (prov === "agy") {
            cmd += '{ jq -r ".model // empty" "$HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null; BIN="$(command -v agy 2>/dev/null || echo "$HOME/.local/share/mise/installs/antigravity-cli/latest/agy")"; if [ -f "$BIN" ]; then rg -a -o "Gemini [34] (Argon|Carbon|Hydrogen|Neon|Pro|Flash)( \\((Low|Medium|High|XHigh)\\))?" "$BIN" 2>/dev/null; fi; } | awk "NF && !seen[\\$0]++"';
          } else if (prov === "codex") {
            cmd += '{ sed -n \'s/^model *= *"\\([^"]*\\)".*/\\1/p\' "$HOME/.codex/config.toml" 2>/dev/null; jq -r ".models[]?.slug // empty" "$HOME/.codex/models_cache.json" 2>/dev/null; } | awk "NF && !seen[\\$0]++"';
          } else if (prov === "opencode") {
            cmd += 'if [ -e "$HOME/.local/share/mise/installs/opencode/latest" ]; then opencode models 2>/dev/null | head -n 40; fi';
          } else if (prov === "claude") {
            cmd += '{ jq -r ".model // empty" "$HOME/.claude/settings.json" 2>/dev/null; printf "sonnet\\nhaiku\\nopus\\n"; } | awk "NF && !seen[\\$0]++"';
          } else {
            return;
          }
          const r = await exec("sh", ["-c", cmd]);
          if (r.code !== 0) return;
          const models = (r.stdout ?? "").split("\n").map(s => s.trim()).filter(Boolean);
          if (models.length > 0 && !models.includes(aiCfgCheck.model)) {
            const oldModel = aiCfgCheck.model;
            setShared("james-changes.ai", { ...aiCfgCheck, model: "" });
            notify({
              title: tr("tabs.model_unavailable_title"),
              body: tr("tabs.model_unavailable_body", { model: oldModel }),
              level: "warning",
            });
          }
        } catch {
          // ignore discovery failures on startup
        }
      });
    }
    cx.spawn(async () => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "default_agent") {
          const def = shared("james.defaultAgent");
          const space = spaces().find(s => s.active);
          if (def?.run) run("tab.new", { name: def.name, space: space?.id, argv: def.run });
          else openOverlay({ mod: "james-settings", kind: "dialog", width: 600, height: 500, props: { section: "default-agent" } });
        }
      }
    });
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const rawStored = this.panels[space.id] ?? null;
        const stored = rawStored === "changes" ? "source-control" : rawStored;
        const want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  mergeTabs(fromTabId, toTabId, cx) {
    if (!fromTabId || !toTabId || fromTabId === toTabId) return;
    const fromTerms = panes()
      .filter((p) => p.tab === fromTabId && p.terminal)
      .map((p) => p.terminal);
    if (fromTerms.length === 0) return;

    for (const term of fromTerms) {
      run("terminal.park", { terminal: term });
    }

    let attempts = 0;
    const attach = (timerCx) => {
      attempts++;
      const stillOpen = panes().some((p) => fromTerms.includes(p.terminal));
      if (stillOpen && attempts < 30) {
        timerCx.timer.after(40, attach);
        return;
      }
      run("tab.select", { id: toTabId });
      timerCx.timer.after(40, () => {
        for (const term of fromTerms) {
          run("terminal.keep", { terminal: term, place: "right" });
        }
      });
    };
    cx.timer.after(40, attach);
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = lead?.program;
      const name = label(c, lead);
      const isSource = this.dragging && this.pressed === i;
      const isDraggingOther = this.dragging && this.pressed !== null && this.pressed !== i;
      const dropMode = isDraggingOther && this.dragTarget?.index === i ? this.dragTarget.mode : null;
      const detectMode = (e) => {
        const w = e?.bounds?.width ?? 0;
        if (w <= 0 || e?.local_position == null) return "merge";
        const ratio = e.local_position.x / w;
        return ratio < 0.22 ? "left" : ratio > 0.78 ? "right" : "merge";
      };
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .when(this.dragging, el => el.cursor_grabbing())
        .when(!this.dragging, el => el.cursor_pointer())
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1)
        .border_color(dropMode === "merge" ? t.accent : isSource ? t.accent + "55" : c.active ? t.border : t.chrome)
        .when(dropMode === "left", el => el.border_l(3).border_color(t.accent))
        .when(dropMode === "right", el => el.border_r(3).border_color(t.accent))
        .bg(dropMode === "merge" ? t.selected : isSource ? t.canvas ?? t.chrome : c.active ? t.raised : t.chrome)
        .text_color(isSource ? t.dim : c.active || dropMode === "merge" ? t.foreground : t.muted)
        .hover(s => s.bg(dropMode === "merge" ? t.selected : isSource ? t.canvas ?? t.chrome : t.hover))
        .on_hover((hovered, cx) => {
          if (this.pressed === null || this.pressed === i) return;
          if (!hovered && this.dragTarget?.index === i) {
            this.dragTarget = null;
            cx.notify();
          } else if (hovered && this.dragTarget?.index !== i) {
            this.dragTarget = { index: i, mode: "merge" };
            cx.notify();
          }
        })
        .on_mouse_move((e, cx) => {
          if (this.pressed === null || this.pressed === i) return;
          const mode = detectMode(e);
          if (this.dragTarget?.index !== i || this.dragTarget?.mode !== mode) {
            this.dragTarget = { index: i, mode };
            cx.notify();
          }
        })
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.pressed = i;
          this.dragging = false;
          this.dragStart = e.position ?? null;
          this.dragName = name;
          this.dragTarget = null;
          if (e.click_count === 2) run("tab.rename", { id: c.id });
          cx.notify();
        })
        .on_mouse_up("left", (e, cx) => {
          cx.stop_propagation();
          const from = this.pressed;
          const wasDragging = this.dragging;
          const mode = this.dragTarget?.index === i ? this.dragTarget.mode : detectMode(e);
          this.pressed = null;
          this.dragging = false;
          this.dragStart = null;
          this.dragPos = null;
          this.dragTarget = null;
          if (from !== null && from !== i && shown[from]) {
            if (mode === "merge") {
              this.mergeTabs(shown[from].id, c.id, cx);
            } else {
              const targetPos = space.tabs.findIndex(x => x.id === c.id) + 1;
              run("tab.move", { id: shown[from].id, index: targetPos });
            }
          } else if (!wasDragging) {
            run("tab.select", { id: c.id });
          }
          cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(isSource ? t.dim : t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(dropMode === "merge", el =>
          el.child(
            div()
              .px(5)
              .py(1)
              .rounded(4)
              .bg(t.accent)
              .text_size(9.5)
              .font_weight(700)
              .text_color(t.accent_foreground ?? "#ffffff")
              .child(tr("tabs.drop_split"))
          )
        )
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active && !this.dragging, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabledRaw = shared("workspace.panels") ?? ["files", "changes", "todos", "runbook", "notes"];
    const enabled = [...new Set([...enabledRaw.map((p) => (p === "changes" ? "source-control" : p)), "todos", "runbook", "notes"])];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).relative().px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .when(this.dragging, el => el.cursor_grabbing())
      .on_mouse_move((e, cx) => {
        if (this.pressed === null) return;
        if (!this.dragging && this.dragStart && e.position) {
          const dx = Math.abs(e.position.x - this.dragStart.x);
          const dy = Math.abs(e.position.y - this.dragStart.y);
          if (dx > 4 || dy > 4) this.dragging = true;
        }
        if (this.dragging && e.local_position) {
          this.dragPos = e.local_position;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        this.pressed = null;
        this.dragging = false;
        this.dragStart = null;
        this.dragPos = null;
        this.dragTarget = null;
        cx.notify();
      })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "james-new-menu", kind: "popup", width: 250, height: 527 })))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))))
      .when(this.dragging && Boolean(this.dragPos), el => {
        const zoom = settings().zoom || 1;
        const hasTag = Boolean(this.dragTarget?.mode);
        const estW = Math.min(190, Math.max(52, this.dragName.length * 7 + (hasTag ? 54 : 22)));
        return el.child(
          h_flex()
            .absolute()
            .left(Math.max(4, Math.round(this.dragPos.x / zoom - estW / 2)))
            .top(7)
            .h(26)
            .px(9)
            .gap(6)
            .rounded(6)
            .items_center()
            .border_1()
            .border_color(t.accent)
            .bg(t.popover ?? t.surface)
            .text_size(11.5)
            .font_weight(600)
            .text_color(t.foreground)
            .child(div().max_w(130).truncate().child(this.dragName))
            .when(this.dragTarget?.mode === "merge", b =>
              b.child(div().text_size(10).text_color(t.accent).child(tr("tabs.drop_split")))
            )
            .when(this.dragTarget?.mode === "left" || this.dragTarget?.mode === "right", b =>
              b.child(div().text_size(10).text_color(t.muted).child("↔"))
            )
        );
      });
  }
}
