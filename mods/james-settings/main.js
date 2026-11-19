import { View, div, svg, image } from "gpui-kit";
import {
  v_flex,
  h_flex,
  TextareaState,
  Textarea,
  Popup,
  HoverCard,
  ScrollHandle,
  Scrollbar,
} from "gpui-base";
import {
  theme,
  shared,
  setShared,
  closeOverlay,
  props,
  knownAgents,
  exec,
  checking,
} from "herdr";

const ICON = {
  sliders: "mods/source-control/icons/sliders.svg",
  sparkles: "mods/source-control/icons/sparkles.svg",
  undo: "mods/source-control/icons/undo.svg",
  refresh: "mods/source-control/icons/refresh.svg",
  close: "mods/workspace-chrome/x.svg",
  check: "mods/workspace-chrome/check.svg",
  chevronDown: "mods/workspace-chrome/chevron-down.svg",
  spinner: "mods/workspace-chrome/spinner.svg",
};

export const DEFAULT_PROMPT =
  "Analyze the git diff below and write a git commit message following the Conventional Commits specification:\n" +
  "1. First line: <type>(<optional scope>): <concise summary in imperative mood, max 72 chars>\n" +
  "2. Second line: blank\n" +
  "3. Body: concise bullet points (- ...) explaining the key changes and why they were made.\n\n" +
  "Rules:\n" +
  "- Output ONLY the raw commit message text (no markdown code fences, no commentary, no intro/outro).\n" +
  "- Do NOT run any commands or tools.";

const PATH_EXPORT =
  'export PATH="$HOME/.local/share/mise/installs/antigravity-cli/latest:$HOME/.local/share/mise/command-wrappers/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:$PATH"; ';

function tipAbove(id, label, triggerEl, t, anchor = "bottom_center") {
  return HoverCard.new(`tip-${id}`)
    .anchor(anchor)
    .open_delay(300)
    .close_delay(0)
    .trigger(triggerEl)
    .content(
      div()
        .px(8)
        .py(4)
        .mb(4)
        .rounded(6)
        .border_1()
        .border_color(t.border)
        .bg(t.popover ?? t.surface)
        .text_size(11.5)
        .text_color(t.foreground)
        .child(label)
    );
}

function agentIcon(a, size, color) {
  if (!a?.icon)
    return svg(ICON.sparkles).size(size).flex_none().text_color(color);
  return a.tint
    ? svg(a.icon).size(size).flex_none().text_color(color)
    : image(a.icon).w(size).h(size).flex_none();
}

function normKey(key) {
  const k = (key ?? "").toLowerCase();
  if (k.includes("antigravity") || k === "agy") return "agy";
  if (k.includes("claude")) return "claude";
  if (k.includes("codex")) return "codex";
  if (k.includes("opencode")) return "opencode";
  return k || "agy";
}

const FALLBACK_AGENTS = [
  { key: "antigravity", name: "Antigravity", icon: "icons/antigravity.svg", tint: false },
  { key: "codex", name: "Codex", icon: "icons/codex.svg", tint: false },
  { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false },
  { key: "opencode", name: "OpenCode", icon: "icons/opencode.svg", tint: true },
];

export default class JamesSettings extends View {
  init(_props, cx) {
    this.section = props()?.section ?? "default-agent";
    this.handle = cx.focus_handle();
    this.handle.focus();

    const saved = shared("james-changes.ai") ?? {};
    this.provider = saved.provider ? normKey(saved.provider) : "";
    this.model = saved.model ?? "";
    this.prompt = saved.prompt ?? DEFAULT_PROMPT;
    this.defaultAgent = shared("james.defaultAgent") ?? null;
    this.allInstalledAgents = shared("james-settings.allAgents") ?? [];

    this.installedAgents = shared("james-settings.agents") ?? [];
    this.discoveredModels = this.provider
      ? shared(`james-settings.models.${this.provider}`) ?? []
      : [];
    this.loadingAgents = false;
    this.loadingModels = false;
    this.modelMenuOpen = false;
    this.modelScroll = ScrollHandle.new();

    this.promptInput = TextareaState.new({
      placeholder: "Commit message generation instructions...",
      value: this.prompt,
      rows: 7,
    });
    this.promptInput.on("change", () => {
      this.prompt = this.promptInput.value();
      this.save();
    });

    if (checking()) return;
    this.discoverAgents(cx);
    if (this.provider) this.discoverModels(this.provider, cx);
  }

  save() {
    setShared("james-changes.ai", {
      provider: this.provider,
      model: this.model,
      prompt: this.prompt,
    });
  }

  discoverAgents(cx) {
    this.loadingAgents = true;
    cx.spawn(async (cx) => {
      try {
        // Check actual installed binaries, ignoring uninstalled lazy mise shims/wrappers.
        const checkScript =
          'CLEAN_PATH=$(printf "%s" "$PATH" | tr ":" "\\n" | grep -vE "mise/(shims|command-wrappers)" | tr "\\n" ":"); ' +
          "check_one() { " +
          '  key="$1"; bin="$2"; mdir="$3"; ' +
          '  if [ -e "$HOME/.local/share/mise/installs/$mdir/latest" ] || PATH="$CLEAN_PATH:$HOME/.local/bin:/usr/local/bin:/usr/bin" command -v "$bin" >/dev/null 2>&1; then ' +
          '    printf "%s\\n" "$key"; ' +
          "  fi; " +
          "}; " +
          "check_one agy agy antigravity-cli; " +
          "check_one claude claude claude; " +
          "check_one codex codex codex; " +
          "check_one opencode opencode opencode; " +
          "check_one gemini gemini gemini-cli; " +
          "check_one pi pi pi; " +
          "check_one cursor-agent cursor-agent cursor-agent; " +
          "check_one kimi kimi-code kimi-code; " +
          "check_one qwen qwen qwen-code;";

        const [list, realRes] = await Promise.all([
          knownAgents({}).catch(() => []),
          exec("sh", ["-c", checkScript]).catch(() => ({ code: 1, stdout: "" })),
        ]);

        const realKeys = new Set(
          (realRes.code === 0 ? realRes.stdout : "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        );

        const allInstalled = (list ?? []).filter((a) => {
          const bin = a.run?.[0] ?? normKey(a.key);
          const k = normKey(a.key);
          if (realRes.code === 0) return realKeys.has(k) || realKeys.has(bin);
          return Boolean(a.installed);
        });
        this.allInstalledAgents = allInstalled;
        setShared("james-settings.allAgents", allInstalled);

        const supported = new Set(["agy", "claude", "codex", "opencode"]);
        const catalog = (list && list.length > 0 ? list : FALLBACK_AGENTS).filter(
          (a) => supported.has(normKey(a.key))
        );

        const installed = catalog.filter((a) => {
          const k = normKey(a.key);
          return realRes.code === 0 ? realKeys.has(k) : Boolean(a.installed);
        });

        this.installedAgents = installed;
        setShared("james-settings.agents", installed);

        if (
          this.provider &&
          installed.length > 0 &&
          !installed.some((a) => normKey(a.key) === this.provider)
        ) {
          this.provider = "";
          this.model = "";
          this.discoveredModels = [];
          this.save();
        }
      } catch {
        // keep cached list on error
      } finally {
        this.loadingAgents = false;
        cx.notify();
      }
    });
  }

  discoverModels(providerId, cx) {
    const prov = normKey(providerId);
    this.loadingModels = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        let cmd = PATH_EXPORT;
        if (prov === "agy") {
          cmd +=
            '{ jq -r ".model // empty" "$HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null; ' +
            'BIN="$(command -v agy 2>/dev/null || echo "$HOME/.local/share/mise/installs/antigravity-cli/latest/agy")"; ' +
            'if [ -f "$BIN" ]; then rg -a -o "Gemini [34] (Argon|Carbon|Hydrogen|Neon|Pro|Flash)( \\((Low|Medium|High|XHigh)\\))?" "$BIN" 2>/dev/null; fi; } | awk "NF && !seen[\\$0]++"';
        } else if (prov === "codex") {
          cmd +=
            '{ sed -n \'s/^model *= *"\\([^"]*\\)".*/\\1/p\' "$HOME/.codex/config.toml" 2>/dev/null; ' +
            'jq -r ".models[]?.slug // empty" "$HOME/.codex/models_cache.json" 2>/dev/null; } | awk "NF && !seen[\\$0]++"';
        } else if (prov === "opencode") {
          cmd +=
            'if [ -e "$HOME/.local/share/mise/installs/opencode/latest" ]; then opencode models 2>/dev/null | head -n 40; fi';
        } else if (prov === "claude") {
          cmd +=
            '{ jq -r ".model // empty" "$HOME/.claude/settings.json" 2>/dev/null; printf "sonnet\\nhaiku\\nopus\\n"; } | awk "NF && !seen[\\$0]++"';
        }

        const r = await exec("sh", ["-c", cmd]);
        if (r.code === 0) {
          const models = (r.stdout ?? "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
          this.discoveredModels = models;
          setShared(`james-settings.models.${prov}`, models);
        }
      } catch {
        this.discoveredModels = [];
      } finally {
        this.loadingModels = false;
        cx.notify();
      }
    });
  }

  selectProvider(provId, cx) {
    const next = normKey(provId);
    if (this.provider === next) {
      this.provider = "";
      this.model = "";
      this.modelMenuOpen = false;
      this.discoveredModels = [];
      this.save();
      cx.notify();
      return;
    }
    this.provider = next;
    this.model = "";
    this.modelMenuOpen = false;
    this.save();
    this.discoveredModels = shared(`james-settings.models.${next}`) ?? [];
    this.discoverModels(next, cx);
    cx.notify();
  }

  renderModelSelect(t) {
    const options = ["", ...this.discoveredModels];
    if (this.model && !options.includes(this.model)) {
      options.splice(1, 0, this.model);
    }
    const currentLabel = this.model || "Auto (CLI Default)";

    const trigger = h_flex()
      .id("settings-model-select-trigger")
      .w_full()
      .h(32)
      .px(10)
      .gap(8)
      .rounded(7)
      .items_center()
      .justify_between()
      .cursor_pointer()
      .border_1()
      .border_color(this.modelMenuOpen ? t.accent : t.border)
      .bg(t.canvas ?? t.raised)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_ev, cx) => {
        cx.stop_propagation();
        this.modelMenuOpen = !this.modelMenuOpen;
        cx.notify();
      })
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(7)
          .items_center()
          .child(svg(ICON.sparkles).size(12).flex_none().text_color(t.accent))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(12)
              .text_color(t.foreground)
              .child(currentLabel)
          )
      )
      .child(
        svg(ICON.chevronDown)
          .size(12)
          .flex_none()
          .text_color(t.muted)
      );

    return Popup.new("settings-model-select-popup", trigger)
      .anchor("bottom_left")
      .when(this.modelMenuOpen, (el) =>
        el.content(
          div()
            .w(396)
            .h(Math.min(210, options.length * 30 + 10))
            .relative()
            .rounded(8)
            .border_1()
            .border_color(t.border)
            .bg(t.popover ?? t.background)
            .on_mouse_down_out((_e, cx) => {
              this.modelMenuOpen = false;
              cx.notify();
            })
            .child(
              v_flex()
                .id("settings-model-select-menu")
                .absolute()
                .inset_0()
                .p(4)
                .gap(2)
                .overflow_y_scroll()
                .track_scroll(this.modelScroll)
                .children(
                  options.map((m, idx) => {
                    const active = this.model === m;
                    const label = m || "Auto (CLI Default)";
                    return h_flex()
                      .id(`model-opt-${idx}`)
                      .h(28)
                      .flex_none()
                      .px(8)
                      .gap(8)
                      .rounded(6)
                      .items_center()
                      .cursor_pointer()
                      .when(active, (s) => s.bg(t.selected))
                      .hover((s) => s.bg(t.hover))
                      .on_mouse_down("left", (_ev, cx) => {
                        cx.stop_propagation();
                        this.model = m;
                        this.modelMenuOpen = false;
                        this.save();
                        cx.notify();
                      })
                      .child(
                        active
                          ? svg(ICON.check).size(12).flex_none().text_color(t.accent)
                          : div().w(12).flex_none()
                      )
                      .child(
                        div()
                          .flex_1()
                          .min_w(0)
                          .truncate()
                          .text_size(12)
                          .font_weight(active ? 500 : 400)
                          .text_color(active ? t.foreground : t.muted)
                          .child(label)
                      );
                  })
                )
            )
            .child(
              Scrollbar.vertical("settings-model-select-menu")
                .absolute()
                .inset_0()
            )
        )
      );
  }

  render() {
    const t = theme();
    const agentsList = this.installedAgents;

    const navItem = (id, iconPath, label) => {
      const active = this.section === id;
      return h_flex()
        .id(`nav-${id}`)
        .h(32)
        .px(10)
        .gap(8)
        .rounded(7)
        .items_center()
        .cursor_pointer()
        .when(active, (e) => e.bg(t.selected).text_color(t.foreground))
        .when(!active, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", (_ev, cx) => {
          cx.stop_propagation();
          this.section = id;
          cx.notify();
        })
        .child(svg(iconPath).size(14).text_color(active ? t.accent : t.muted))
        .child(
          div()
            .text_size(12.5)
            .font_weight(active ? 500 : 400)
            .child(label)
        );
    };

    const closeBtn = h_flex()
      .id("close-james-settings")
      .w(26)
      .h(26)
      .rounded(6)
      .items_center()
      .justify_center()
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_ev, cx) => {
        cx.stop_propagation();
        closeOverlay(props()?.overlay);
      })
      .child(svg(ICON.close).size(14).text_color(t.muted));

    return v_flex()
      .id("james-settings")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.modelMenuOpen) {
            this.modelMenuOpen = false;
            cx.stop_propagation();
            cx.notify();
            return;
          }
          closeOverlay(props()?.overlay);
        }
      })
      .child(
        // Modal Header
        h_flex()
          .h(44)
          .flex_none()
          .px(16)
          .items_center()
          .justify_between()
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(svg(ICON.sliders).size(15).text_color(t.accent))
              .child(
                div()
                  .text_size(13.5)
                  .font_weight(600)
                  .child("JamesHerdr Settings")
              )
          )
          .child(tipAbove("close-settings", "Close Settings (Esc)", closeBtn, t))
      )
      .child(
        // Modal Body: Left Sidebar + Right Content
        h_flex()
          .flex_1()
          .min_h(0)
          .items_stretch()
          .child(
            v_flex()
              .w(170)
              .h_full()
              .flex_none()
              .justify_start()
              .p(10)
              .gap(4)
              .border_r(1)
              .border_color(t.border)
              .bg(t.chrome ?? t.raised)
              .child(
                div()
                  .px(8)
                  .py(4)
                  .text_size(10.5)
                  .font_weight(600)
                  .text_color(t.dim)
                  .child("MODULES")
              )
              .child(navItem("default-agent", ICON.sparkles, "Default Agent"))
              .child(navItem("ai-commit", ICON.sliders, "AI Commit"))
          )
          .when(this.section === "default-agent", (panel) =>
            panel.child(
              v_flex()
                .flex_1()
                .h_full()
                .min_h(0)
                .justify_start()
                .p(16)
                .gap(16)
                .overflow_y_scroll()
                .child(
                  v_flex()
                    .gap(4)
                    .child(
                      div()
                        .text_size(12.5)
                        .font_weight(600)
                        .text_color(t.foreground)
                        .child("Default Agent (New Menu & Shortcut)")
                    )
                    .child(
                      div()
                        .text_size(11.5)
                        .text_color(t.muted)
                        .child(
                          "Appears at the top of the + menu and launches directly with Ctrl+Shift+A."
                        )
                    )
                )
                .child(
                  h_flex()
                    .gap(8)
                    .flex_wrap()
                    .children(
                      (this.allInstalledAgents.length > 0
                        ? this.allInstalledAgents
                        : this.installedAgents
                      ).map((a) => {
                        const active = this.defaultAgent?.key === a.key;
                        return h_flex()
                          .id(`def-agent-${a.key}`)
                          .h(34)
                          .px(12)
                          .gap(8)
                          .rounded(7)
                          .items_center()
                          .cursor_pointer()
                          .border_1()
                          .border_color(active ? t.accent : t.border)
                          .bg(active ? t.selected : t.raised)
                          .text_color(active ? t.foreground : t.muted)
                          .hover((s) => s.bg(t.hover))
                          .on_mouse_down("left", (_ev, cx) => {
                            cx.stop_propagation();
                            if (active) {
                              this.defaultAgent = null;
                            } else {
                              this.defaultAgent = {
                                key: a.key,
                                name: a.name,
                                icon: a.icon,
                                tint: a.tint,
                                run: a.run,
                              };
                            }
                            setShared("james.defaultAgent", this.defaultAgent);
                            cx.notify();
                          })
                          .child(
                            agentIcon(a, 15, active ? t.foreground : t.muted)
                          )
                          .child(
                            div()
                              .text_size(12.5)
                              .font_weight(active ? 500 : 400)
                              .child(a.name)
                          )
                          .when(active, (el) =>
                            el.child(
                              svg(ICON.check).size(12).text_color(t.accent)
                            )
                          );
                      })
                    )
                )
            )
          )
          .when(this.section === "ai-commit", (panel) =>
            panel.child(
              v_flex()
                .flex_1()
                .h_full()
                .min_h(0)
                .justify_start()
                .p(16)
                .gap(16)
                .overflow_y_scroll()
              .child(
                // 1. Installed Agents
                v_flex()
                  .gap(6)
                  .child(
                    h_flex()
                      .items_center()
                      .justify_between()
                      .child(
                        div()
                          .text_size(12)
                          .font_weight(600)
                          .text_color(t.foreground)
                          .child("Installed Agents")
                      )
                      .when(this.loadingAgents, (e) =>
                        e.child(
                          svg(ICON.spinner)
                            .size(12)
                            .text_color(t.muted)
                            .spin(900)
                        )
                      )
                  )
                  .when(agentsList.length > 0, (e) =>
                    e.child(
                      h_flex()
                        .gap(6)
                        .flex_wrap()
                        .children(
                          agentsList.map((a) => {
                            const pKey = normKey(a.key);
                            const active = this.provider === pKey;
                            return h_flex()
                              .id(`agent-choice-${pKey}`)
                              .h(30)
                              .px(10)
                              .gap(7)
                              .rounded(7)
                              .items_center()
                              .cursor_pointer()
                              .border_1()
                              .border_color(active ? t.accent : t.border)
                              .bg(active ? t.selected : t.raised)
                              .text_color(active ? t.foreground : t.muted)
                              .hover((s) => s.bg(t.hover))
                              .on_mouse_down("left", (_ev, cx) => {
                                cx.stop_propagation();
                                this.selectProvider(pKey, cx);
                              })
                              .child(
                                agentIcon(
                                  a,
                                  14,
                                  active ? t.foreground : t.muted
                                )
                              )
                              .child(
                                div()
                                  .text_size(12)
                                  .font_weight(active ? 500 : 400)
                                  .child(a.name)
                              )
                              .when(active, (el) =>
                                el.child(
                                  svg(ICON.check).size(12).text_color(t.accent)
                                )
                              );
                          })
                        )
                    )
                  )
                  .when(agentsList.length === 0 && !this.loadingAgents, (e) =>
                    e.child(
                      div()
                        .text_size(12)
                        .text_color(t.dim)
                        .child("No supported AI CLI agents detected.")
                    )
                  )
              )
              .child(
                // 2. Model Selector (Select dropdown)
                v_flex()
                  .gap(6)
                  .child(
                    h_flex()
                      .items_center()
                      .justify_between()
                      .child(
                        h_flex()
                          .gap(6)
                          .items_center()
                          .child(
                            div()
                              .text_size(12)
                              .font_weight(600)
                              .text_color(t.foreground)
                              .child("Model")
                          )
                          .child(
                            div()
                              .px(5)
                              .py(1)
                              .rounded(6)
                              .bg(t.raised)
                              .text_size(10.5)
                              .text_color(t.dim)
                              .child(String(this.discoveredModels.length))
                          )
                      )
                      .child(
                        h_flex()
                          .id("refresh-models-btn")
                          .h(22)
                          .px(7)
                          .gap(4)
                          .rounded(5)
                          .items_center()
                          .cursor_pointer()
                          .border_1()
                          .border_color(t.border)
                          .bg(t.raised)
                          .text_size(11)
                          .text_color(t.muted)
                          .hover((s) => s.bg(t.hover).text_color(t.foreground))
                          .on_mouse_down("left", (_ev, cx) => {
                            cx.stop_propagation();
                            this.discoverAgents(cx);
                            if (this.provider) this.discoverModels(this.provider, cx);
                          })
                          .child(
                            this.loadingModels
                              ? svg(ICON.spinner)
                                  .size(11)
                                  .text_color(t.accent)
                                  .spin(900)
                              : svg(ICON.refresh).size(11).text_color(t.muted)
                          )
                          .child(div().child("Refresh"))
                      )
                  )
                  .child(this.renderModelSelect(t))
              )
              .child(
                // 3. Commit Prompt Template
                v_flex()
                  .flex_1()
                  .min_h(150)
                  .gap(6)
                  .child(
                    h_flex()
                      .items_center()
                      .justify_between()
                      .child(
                        div()
                          .text_size(12)
                          .font_weight(600)
                          .text_color(t.foreground)
                          .child("Commit Prompt Template")
                      )
                      .child(
                        h_flex()
                          .id("reset-prompt-btn")
                          .px(8)
                          .py(3)
                          .gap(5)
                          .rounded(5)
                          .items_center()
                          .cursor_pointer()
                          .border_1()
                          .border_color(t.border)
                          .bg(t.raised)
                          .text_size(11)
                          .text_color(t.muted)
                          .hover((s) => s.bg(t.hover).text_color(t.foreground))
                          .on_mouse_down("left", (_ev, cx) => {
                            cx.stop_propagation();
                            this.prompt = DEFAULT_PROMPT;
                            this.promptInput.set_value(DEFAULT_PROMPT);
                            this.save();
                            cx.notify();
                          })
                          .child(svg(ICON.undo).size(11).text_color(t.muted))
                          .child(div().child("Reset to Default"))
                      )
                  )
                  .child(
                    div()
                      .id("settings-prompt-textarea")
                      .flex_1()
                      .min_h(120)
                      .p(8)
                      .rounded(7)
                      .border_1()
                      .border_color(t.border)
                      .bg(t.canvas ?? t.raised)
                      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                      .child(
                        Textarea.new(this.promptInput)
                          .size_full()
                          .text_size(11.5)
                          .text_color(t.foreground)
                      )
                  )
              )
            )
          )
      );
  }
}
