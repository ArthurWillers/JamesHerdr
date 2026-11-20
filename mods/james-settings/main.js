import { View, div, svg, image } from "gpui-kit";
import {
  v_flex,
  h_flex,
  TextareaState,
  Textarea,
  InputState,
  Input,
  Popup,
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
  run,
} from "herdr";
import { tr, SUPPORTED_LANGS, currentLang } from "./i18n.js";

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
  "3. Body: concise bullet points (- ...) explaining the key changes and why they were made.";

const PATH_EXPORT =
  'export PATH="$HOME/.local/share/mise/installs/antigravity-cli/latest:$HOME/.local/share/mise/command-wrappers/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:$PATH"; ';

const tipState = { id: null };

function tipAbove(id, label, triggerEl, t, anchor = "bottom_center") {
  const trigger = triggerEl.on_hover((hovered, cx) => {
    const next = hovered ? id : tipState.id === id ? null : tipState.id;
    if (next !== tipState.id) {
      tipState.id = next;
      cx.notify();
    }
  });
  return Popup.new(`tip-${id}`, trigger)
    .anchor(anchor)
    .when(tipState.id === id, (el) =>
      el.content(
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
      )
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
    const rawSavedPrompt = saved.prompt ?? DEFAULT_PROMPT;
    this.prompt = rawSavedPrompt.includes("Rules:\n- Output ONLY the raw commit message text")
      ? DEFAULT_PROMPT
      : rawSavedPrompt;
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
    this.modelPopupFocus = cx.focus_handle();
    this.modelSearch = "";
    this.modelHighlightIdx = 0;
    this.modelSearchInput = InputState.new({
      placeholder: tr("set.ai_model_search"),
    });
    this.modelSearchInput.on("change", (_ev, cx) => {
      this.modelSearch = this.modelSearchInput.value();
      this.modelHighlightIdx = 0;
      cx.notify();
    });
    this.modelSearchInput.on("submit", (_ev, cx) => {
      const list = this.filteredModelOptions();
      const pick = list[this.modelHighlightIdx] ?? list[0];
      if (pick) {
        this.model = pick.value;
        this.modelMenuOpen = false;
        this.save();
        this.handle.focus();
        cx.notify();
      }
    });

    this.langMenuOpen = false;
    this.langScroll = ScrollHandle.new();
    this.langPopupFocus = cx.focus_handle();
    this.langSearch = "";
    this.langHighlightIdx = 0;
    this.langSearchInput = InputState.new({
      placeholder: tr("set.lang_search"),
    });
    this.langSearchInput.on("change", (_ev, cx) => {
      this.langSearch = this.langSearchInput.value();
      this.langHighlightIdx = 0;
      cx.notify();
    });
    this.langSearchInput.on("submit", (_ev, cx) => {
      const list = this.filteredLangOptions();
      const pick = list[this.langHighlightIdx] ?? list[0];
      if (pick) {
        setShared("james.langMode", pick.value);
        this.langMenuOpen = false;
        this.handle.focus();
        cx.notify();
      }
    });
    this.omarchyInfo = {
      checked: false,
      supported: Boolean(shared("james-settings.omarchySupported")),
      hookInstalled: false,
      currentTheme: "",
      busy: false,
      statusMsg: "",
    };

    this.promptInput = TextareaState.new({
      placeholder: tr("set.ai_prompt_placeholder"),
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
    this.checkOmarchyStatus(cx);
  }

  checkOmarchyStatus(cx) {
    cx.spawn(async (cx) => {
      try {
        const script =
          'SUPPORTED=0; ' +
          'if [ -d "$HOME/.config/omarchy/hooks/theme-set.d" ] && { command -v omarchy >/dev/null 2>&1 || [ -d "$HOME/.config/omarchy/themes" ] || [ -d "/usr/share/omarchy/themes" ]; }; then SUPPORTED=1; fi; ' +
          'HOOK=0; ' +
          'if [ -x "$HOME/.config/omarchy/hooks/theme-set.d/herdr-theme-sync" ]; then HOOK=1; fi; ' +
          'SLUG=""; ' +
          'if command -v omarchy >/dev/null 2>&1; then SLUG="$(omarchy theme current 2>/dev/null | tr "[:upper:]" "[:lower:]" | tr " " "-")"; fi; ' +
          'if [ -z "$SLUG" ]; then LINK="$HOME/.config/omarchy/current/theme"; if [ -L "$LINK" ] || [ -d "$LINK" ]; then SLUG="$(basename "$(readlink -f "$LINK")")"; fi; fi; ' +
          'printf "%s|%s|%s" "$SUPPORTED" "$HOOK" "$SLUG"';
        const r = await exec("sh", ["-c", script]);
        const [sup, hook, slug] = (r.stdout ?? "").trim().split("|");
        const supported = sup === "1";
        setShared("james-settings.omarchySupported", supported);
        if (!supported && this.section === "omarchy") {
          this.section = "default-agent";
        }
        this.omarchyInfo = {
          ...this.omarchyInfo,
          checked: true,
          supported,
          hookInstalled: hook === "1",
          currentTheme: slug ?? "",
          busy: false,
        };
      } catch {
        this.omarchyInfo = { ...this.omarchyInfo, checked: true, busy: false };
      }
      cx.notify();
    });
  }

  toggleOmarchyHook(cx) {
    if (this.omarchyInfo.busy) return;
    const install = !this.omarchyInfo.hookInstalled;
    this.omarchyInfo = { ...this.omarchyInfo, busy: true, statusMsg: "" };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const cmd = install
          ? 'SCRIPT=""; ' +
            'for s in "$HOME/Code/JamesHerdr/scripts/omarchy-theme-sync.sh" "$HOME/.config/herdr-app/scripts/omarchy-theme-sync.sh"; do ' +
            '  if [ -f "$s" ]; then SCRIPT="$s"; break; fi; ' +
            'done; ' +
            'if [ -z "$SCRIPT" ]; then echo "omarchy-theme-sync.sh not found" >&2; exit 1; fi; ' +
            'mkdir -p "$HOME/.config/omarchy/hooks/theme-set.d" && ' +
            'chmod +x "$SCRIPT" && ' +
            'ln -sfn "$SCRIPT" "$HOME/.config/omarchy/hooks/theme-set.d/herdr-theme-sync" && ' +
            '"$SCRIPT"'
          : 'rm -f "$HOME/.config/omarchy/hooks/theme-set.d/herdr-theme-sync"';
        const r = await exec("sh", ["-c", cmd]);
        if (r.code === 0) {
          if (install && this.omarchyInfo.currentTheme) {
            run("app.theme", { name: this.omarchyInfo.currentTheme });
          }
          this.omarchyInfo = {
            ...this.omarchyInfo,
            hookInstalled: install,
            busy: false,
            statusMsg: install
              ? tr("set.om_hook_installed_msg")
              : tr("set.om_hook_removed_msg"),
          };
        } else {
          this.omarchyInfo = {
            ...this.omarchyInfo,
            busy: false,
            statusMsg: (r.stderr || "Failed to update hook.").trim(),
          };
        }
      } catch (e) {
        this.omarchyInfo = {
          ...this.omarchyInfo,
          busy: false,
          statusMsg: String(e),
        };
      }
      cx.notify();
    });
  }

  syncOmarchyThemeNow(cx) {
    if (this.omarchyInfo.busy) return;
    this.omarchyInfo = { ...this.omarchyInfo, busy: true, statusMsg: "" };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const cmd =
          'SCRIPT=""; ' +
          'for s in "$HOME/Code/JamesHerdr/scripts/omarchy-theme-sync.sh" "$HOME/.config/herdr-app/scripts/omarchy-theme-sync.sh"; do ' +
          '  if [ -f "$s" ]; then SCRIPT="$s"; break; fi; ' +
          'done; ' +
          'if [ -z "$SCRIPT" ]; then echo "omarchy-theme-sync.sh not found" >&2; exit 1; fi; ' +
          'chmod +x "$SCRIPT" && "$SCRIPT" && ' +
          'if command -v omarchy >/dev/null 2>&1; then omarchy theme current 2>/dev/null | tr "[:upper:]" "[:lower:]" | tr " " "-"; ' +
          'else LINK="$HOME/.config/omarchy/current/theme"; if [ -L "$LINK" ] || [ -d "$LINK" ]; then basename "$(readlink -f "$LINK")"; fi; fi';
        const r = await exec("sh", ["-c", cmd]);
        const slug = (r.stdout ?? "").trim().split("\n").pop()?.trim() ?? "";
        if (r.code === 0) {
          if (slug) run("app.theme", { name: slug });
          this.omarchyInfo = {
            ...this.omarchyInfo,
            currentTheme: slug || this.omarchyInfo.currentTheme,
            busy: false,
            statusMsg: slug
              ? tr("set.om_synced_theme", { theme: slug })
              : tr("set.om_synced"),
          };
        } else {
          this.omarchyInfo = {
            ...this.omarchyInfo,
            busy: false,
            statusMsg: (r.stderr || "Sync failed.").trim(),
          };
        }
      } catch (e) {
        this.omarchyInfo = {
          ...this.omarchyInfo,
          busy: false,
          statusMsg: String(e),
        };
      }
      cx.notify();
    });
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
          '  if [ -e "$HOME/.local/share/mise/installs/$mdir/latest" ]; then printf "%s\\n" "$key"; return; fi; ' +
          '  p=$(PATH="$CLEAN_PATH:$HOME/.local/bin:/usr/local/bin:/usr/bin" command -v "$bin" 2>/dev/null || true); ' +
          '  if [ -n "$p" ] && ! { head -c 2 "$p" 2>/dev/null | grep -q "^#!" && grep -q "mise" "$p" 2>/dev/null; }; then ' +
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

  filteredModelOptions() {
    const raw = ["", ...this.discoveredModels];
    if (this.model && !raw.includes(this.model)) {
      raw.splice(1, 0, this.model);
    }
    const q = this.modelSearch.trim().toLowerCase();
    const mapped = raw.map((m) => ({
      value: m,
      label: m || tr("set.ai_auto"),
      meta: "",
    }));
    return q
      ? mapped.filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            o.value.toLowerCase().includes(q)
        )
      : mapped;
  }

  filteredLangOptions() {
    const q = this.langSearch.trim().toLowerCase();
    const mapped = SUPPORTED_LANGS.map((l) => ({
      value: l.code,
      label: l.name,
      meta: l.code === "auto" ? l.englishName : `${l.englishName} · ${l.code}`,
      searchText: `${l.code} ${l.name} ${l.englishName}`.toLowerCase(),
    }));
    return q ? mapped.filter((o) => o.searchText.includes(q)) : mapped;
  }

  handleActiveSelectKey(e, cx) {
    const isModel = this.modelMenuOpen;
    const isLang = this.langMenuOpen;
    if (!isModel && !isLang) return false;

    const options = isModel
      ? this.filteredModelOptions()
      : this.filteredLangOptions();
    const curIdx = isModel ? this.modelHighlightIdx : this.langHighlightIdx;
    const clampedIdx =
      options.length === 0 ? 0 : Math.max(0, Math.min(curIdx, options.length - 1));
    const scrollHandle = isModel ? this.modelScroll : this.langScroll;
    const setIdx = (next) => {
      if (isModel) this.modelHighlightIdx = next;
      else this.langHighlightIdx = next;
    };
    const closeMenu = () => {
      if (isModel) this.modelMenuOpen = false;
      else this.langMenuOpen = false;
      this.handle.focus();
      cx.notify();
    };

    const k = (e.key ?? "").toLowerCase();
    if (k === "escape") {
      cx.stop_propagation();
      closeMenu();
      return true;
    }
    if (k === "down" || k === "arrowdown") {
      cx.stop_propagation();
      if (options.length > 0) {
        const next = (clampedIdx + 1) % options.length;
        setIdx(next);
        scrollHandle.scroll_to_item(next);
        cx.notify();
      }
      return true;
    }
    if (k === "up" || k === "arrowup") {
      cx.stop_propagation();
      if (options.length > 0) {
        const next = (clampedIdx - 1 + options.length) % options.length;
        setIdx(next);
        scrollHandle.scroll_to_item(next);
        cx.notify();
      }
      return true;
    }
    if (k === "enter" || k === "return") {
      cx.stop_propagation();
      const pick = options[clampedIdx];
      if (pick) {
        if (isModel) {
          this.model = pick.value;
          this.save();
        } else {
          setShared("james.langMode", pick.value);
        }
        closeMenu();
      }
      return true;
    }
    return false;
  }

  renderSearchableSelect(t, cfg) {
    const {
      idPrefix,
      open,
      setOpen,
      popupFocus,
      triggerLabel,
      triggerIcon,
      options,
      selectedValue,
      onSelect,
      searchInput,
      scrollHandle,
      highlightIdx,
      emptyText,
    } = cfg;

    const clampedIdx =
      options.length === 0 ? 0 : Math.max(0, Math.min(highlightIdx, options.length - 1));

    const trigger = h_flex()
      .id(`${idPrefix}-trigger`)
      .w_full()
      .h(32)
      .px(10)
      .gap(8)
      .rounded(7)
      .items_center()
      .justify_between()
      .cursor_pointer()
      .border_1()
      .border_color(open ? t.accent : t.border)
      .bg(t.canvas ?? t.raised)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_ev, cx) => {
        cx.stop_propagation();
        const nextOpen = !open;
        setOpen(nextOpen, cx);
      })
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(7)
          .items_center()
          .when(Boolean(triggerIcon), (el) => el.child(triggerIcon))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(12)
              .text_color(t.foreground)
              .child(triggerLabel)
          )
      )
      .child(svg(ICON.chevronDown).size(12).flex_none().text_color(t.muted));

    return Popup.new(`${idPrefix}-popup`, trigger)
      .anchor("bottom_left")
      .when(open, (el) =>
        el.content(
          v_flex()
            .id(`${idPrefix}-surface`)
            .track_focus(popupFocus)
            .w(396)
            .h(Math.min(268, Math.max(110, options.length * 30 + 50)))
            .rounded(8)
            .border_1()
            .border_color(t.border)
            .bg(t.popover ?? t.background)
            .on_mouse_down_out((_e, cx) => {
              setOpen(false, cx);
            })
            .on_key_down((e, cx) => {
              this.handleActiveSelectKey(e, cx);
            })
            .child(
              div()
                .px(6)
                .py(6)
                .border_b(1)
                .border_color(t.border)
                .on_mouse_down("left", (_e, cx) => {
                  cx.stop_propagation();
                  searchInput.focus();
                })
                .child(
                  Input.new(searchInput)
                    .w_full()
                    .h(28)
                    .px(8)
                    .rounded(6)
                    .border_1()
                    .border_color(t.accent)
                    .bg(t.canvas ?? t.background)
                    .text_size(12)
                    .text_color(t.foreground)
                )
            )
            .child(
              div()
                .flex_1()
                .min_h(0)
                .relative()
                .child(
                  v_flex()
                    .id(`${idPrefix}-menu`)
                    .absolute()
                    .inset_0()
                    .p(4)
                    .gap(2)
                    .overflow_y_scroll()
                    .track_scroll(scrollHandle)
                    .when(options.length === 0, (list) =>
                      list.child(
                        div()
                          .px(10)
                          .py(12)
                          .text_size(11.5)
                          .text_color(t.dim)
                          .child(emptyText)
                      )
                    )
                    .children(
                      options.map((opt, idx) => {
                        const active = selectedValue === opt.value;
                        const highlighted = idx === clampedIdx;
                        return h_flex()
                          .id(`${idPrefix}-opt-${idx}`)
                          .h(28)
                          .flex_none()
                          .px(8)
                          .gap(8)
                          .rounded(6)
                          .items_center()
                          .cursor_pointer()
                          .when(active, (s) => s.bg(t.selected))
                          .when(!active && highlighted, (s) => s.bg(t.hover))
                          .hover((s) => s.bg(t.hover))
                          .on_mouse_down("left", (_ev, cx) => {
                            cx.stop_propagation();
                            onSelect(opt.value, cx);
                            setOpen(false, cx);
                          })
                          .child(
                            active
                              ? svg(ICON.check)
                                  .size(12)
                                  .flex_none()
                                  .text_color(t.accent)
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
                              .child(opt.label)
                          )
                          .when(Boolean(opt.meta), (row) =>
                            row.child(
                              div()
                                .flex_none()
                                .text_size(10.5)
                                .text_color(t.dim)
                                .child(opt.meta)
                            )
                          );
                      })
                    )
                )
                .child(
                  Scrollbar.vertical(`${idPrefix}-menu`)
                    .absolute()
                    .inset_0()
                )
            )
        )
      );
  }

  renderModelSelect(t) {
    const options = this.filteredModelOptions();
    const currentLabel = this.model || tr("set.ai_auto");
    return this.renderSearchableSelect(t, {
      idPrefix: "settings-model-select",
      open: this.modelMenuOpen,
      popupFocus: this.modelPopupFocus,
      setOpen: (next, cx) => {
        this.modelMenuOpen = next;
        if (next) {
          this.langMenuOpen = false;
          this.modelSearch = "";
          this.modelSearchInput.set_value("");
          const curIdx = this.filteredModelOptions().findIndex(
            (o) => o.value === this.model
          );
          this.modelHighlightIdx = curIdx >= 0 ? curIdx : 0;
          this.modelSearchInput.focus();
          cx.timer.after(20, () => {
            if (this.modelMenuOpen) {
              this.modelSearchInput.focus();
              this.modelScroll.scroll_to_item(this.modelHighlightIdx);
            }
          });
          cx.timer.after(90, () => {
            if (this.modelMenuOpen) this.modelSearchInput.focus();
          });
        } else {
          this.handle.focus();
        }
        cx.notify();
      },
      triggerLabel: currentLabel,
      triggerIcon: svg(ICON.sparkles).size(12).flex_none().text_color(t.accent),
      options,
      selectedValue: this.model,
      onSelect: (val) => {
        this.model = val;
        this.save();
      },
      searchInput: this.modelSearchInput,
      scrollHandle: this.modelScroll,
      highlightIdx: this.modelHighlightIdx,
      emptyText: tr("set.ai_model_empty"),
    });
  }

  renderLanguageSelect(t) {
    const mode = shared("james.langMode") ?? "auto";
    const active = currentLang();
    const activeObj = SUPPORTED_LANGS.find((l) => l.code === active);
    const selectedObj = SUPPORTED_LANGS.find((l) => l.code === mode);
    const triggerLabel =
      mode === "auto"
        ? `${selectedObj?.name ?? "Auto (System)"} — ${activeObj?.name ?? active}`
        : selectedObj
          ? `${selectedObj.name} (${selectedObj.code})`
          : mode;
    const options = this.filteredLangOptions();

    return this.renderSearchableSelect(t, {
      idPrefix: "settings-lang-select",
      open: this.langMenuOpen,
      popupFocus: this.langPopupFocus,
      setOpen: (next, cx) => {
        this.langMenuOpen = next;
        if (next) {
          this.modelMenuOpen = false;
          this.langSearch = "";
          this.langSearchInput.set_value("");
          const curIdx = this.filteredLangOptions().findIndex(
            (o) => o.value === mode
          );
          this.langHighlightIdx = curIdx >= 0 ? curIdx : 0;
          this.langSearchInput.focus();
          cx.timer.after(20, () => {
            if (this.langMenuOpen) {
              this.langSearchInput.focus();
              this.langScroll.scroll_to_item(this.langHighlightIdx);
            }
          });
          cx.timer.after(90, () => {
            if (this.langMenuOpen) this.langSearchInput.focus();
          });
        } else {
          this.handle.focus();
        }
        cx.notify();
      },
      triggerLabel,
      triggerIcon: null,
      options,
      selectedValue: mode,
      onSelect: (val) => {
        setShared("james.langMode", val);
      },
      searchInput: this.langSearchInput,
      scrollHandle: this.langScroll,
      highlightIdx: this.langHighlightIdx,
      emptyText: tr("set.lang_empty"),
    });
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
        if (this.handleActiveSelectKey(e, cx)) return;
        if (e.key === "escape") {
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
                  .child(tr("set.title"))
              )
          )
          .child(tipAbove("close-settings", "Esc", closeBtn, t))
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
                  .child(tr("set.modules"))
              )
              .child(navItem("default-agent", ICON.sparkles, tr("set.nav_default_agent")))
              .child(navItem("ai-commit", ICON.sliders, tr("set.nav_ai_commit")))
              .child(navItem("files", ICON.sliders, tr("set.nav_files")))
              .child(navItem("language", ICON.refresh, tr("set.nav_language")))
              .when(this.omarchyInfo.supported, (sb) =>
                sb.child(navItem("omarchy", ICON.refresh, tr("set.nav_omarchy")))
              )
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
                        .child(tr("set.da_title"))
                    )
                    .child(
                      div()
                        .text_size(11.5)
                        .text_color(t.muted)
                        .child(tr("set.da_desc"))
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
                          .child(tr("set.ai_provider"))
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
                        .child(tr("set.ai_no_agents"))
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
                              .child(tr("set.ai_model"))
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
                          .child(div().child(tr("set.ai_refresh")))
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
                          .child(tr("set.ai_prompt"))
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
                          .child(div().child(tr("set.ai_reset")))
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
          .when(this.section === "files", (panel) => {
            const autoSave = shared("james-files.autoSave") !== false;
            const delay = Number(shared("james-files.autoSaveDelay") ?? 1000);
            const chip = (id, label, active, onClick) =>
              h_flex()
                .id(id)
                .h(30)
                .px(12)
                .gap(6)
                .rounded(7)
                .items_center()
                .cursor_pointer()
                .border_1()
                .border_color(active ? t.accent : t.border)
                .bg(active ? t.selected : t.raised)
                .text_size(12)
                .font_weight(active ? 500 : 400)
                .text_color(active ? t.foreground : t.muted)
                .hover((s) => s.bg(t.hover))
                .on_mouse_down("left", (_ev, cx) => {
                  cx.stop_propagation();
                  onClick(cx);
                })
                .child(div().child(label))
                .when(active, (el) =>
                  el.child(svg(ICON.check).size(12).text_color(t.accent))
                );
            return panel.child(
              v_flex()
                .flex_1()
                .w_full()
                .min_w(0)
                .h_full()
                .min_h(0)
                .justify_start()
                .p(16)
                .gap(16)
                .overflow_y_scroll()
                .child(
                  v_flex()
                    .w_full()
                    .min_w(0)
                    .gap(4)
                    .child(
                      div()
                        .w_full()
                        .text_size(12.5)
                        .font_weight(600)
                        .text_color(t.foreground)
                        .child(tr("set.files_title"))
                    )
                    .child(
                      div()
                        .w_full()
                        .text_size(11.5)
                        .text_color(t.muted)
                        .child(tr("set.files_desc"))
                    )
                )
                .child(
                  v_flex()
                    .gap(8)
                    .child(
                      div()
                        .text_size(12)
                        .font_weight(600)
                        .text_color(t.foreground)
                        .child(tr("set.files_autosave"))
                    )
                    .child(
                      h_flex()
                        .gap(8)
                        .flex_wrap()
                        .child(
                          chip(
                            "files-autosave-after",
                            tr("set.files_autosave_after"),
                            autoSave,
                            (cx) => {
                              setShared("james-files.autoSave", true);
                              cx.notify();
                            }
                          )
                        )
                        .child(
                          chip(
                            "files-autosave-off",
                            tr("set.files_autosave_off"),
                            !autoSave,
                            (cx) => {
                              setShared("james-files.autoSave", false);
                              cx.notify();
                            }
                          )
                        )
                    )
                )
                .when(autoSave, (col) =>
                  col.child(
                    v_flex()
                      .gap(8)
                      .child(
                        div()
                          .text_size(12)
                          .font_weight(600)
                          .text_color(t.foreground)
                          .child(tr("set.files_delay"))
                      )
                      .child(
                        h_flex()
                          .gap(8)
                          .flex_wrap()
                          .children(
                            [500, 1000, 2000, 3000].map((ms) =>
                              chip(
                                `files-delay-${ms}`,
                                `${ms} ms`,
                                delay === ms,
                                (cx) => {
                                  setShared("james-files.autoSaveDelay", ms);
                                  cx.notify();
                                }
                              )
                            )
                          )
                      )
                  )
                )
                .child(
                  v_flex()
                    .gap(8)
                    .child(
                      div()
                        .text_size(12)
                        .font_weight(600)
                        .text_color(t.foreground)
                        .child(tr("set.files_word_wrap"))
                    )
                    .child(
                      h_flex()
                        .gap(8)
                        .flex_wrap()
                        .child(
                          chip(
                            "files-wrap-on",
                            tr("set.files_on"),
                            Boolean(shared("james-files.wordWrap")),
                            (cx) => {
                              setShared("james-files.wordWrap", true);
                              cx.notify();
                            }
                          )
                        )
                        .child(
                          chip(
                            "files-wrap-off",
                            tr("set.files_off"),
                            !shared("james-files.wordWrap"),
                            (cx) => {
                              setShared("james-files.wordWrap", false);
                              cx.notify();
                            }
                          )
                        )
                    )
                )
            );
          })
          .when(this.section === "language", (panel) => {
            const active = currentLang();
            const activeObj = SUPPORTED_LANGS.find((l) => l.code === active);
            return panel.child(
              v_flex()
                .flex_1()
                .w_full()
                .min_w(0)
                .h_full()
                .min_h(0)
                .justify_start()
                .p(16)
                .gap(16)
                .overflow_y_scroll()
                .child(
                  v_flex()
                    .w_full()
                    .min_w(0)
                    .gap(4)
                    .child(
                      div()
                        .w_full()
                        .text_size(12.5)
                        .font_weight(600)
                        .text_color(t.foreground)
                        .child(tr("set.lang_title"))
                    )
                    .child(
                      div()
                        .w_full()
                        .text_size(11.5)
                        .text_color(t.muted)
                        .child(tr("set.lang_desc"))
                    )
                    .child(
                      div()
                        .w_full()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(
                          tr("set.lang_active", {
                            lang: activeObj
                              ? `${activeObj.name} (${active})`
                              : active,
                          })
                        )
                    )
                )
                .child(this.renderLanguageSelect(t))
            );
          })
          .when(this.section === "omarchy", (panel) => {
            const info = this.omarchyInfo;
            return panel.child(
              v_flex()
                .flex_1()
                .w_full()
                .min_w(0)
                .h_full()
                .min_h(0)
                .justify_start()
                .p(16)
                .gap(16)
                .overflow_y_scroll()
                .child(
                  v_flex()
                    .w_full()
                    .min_w(0)
                    .gap(4)
                    .child(
                      div()
                        .w_full()
                        .text_size(12.5)
                        .font_weight(600)
                        .text_color(t.foreground)
                        .child(tr("set.om_title"))
                    )
                    .child(
                      div()
                        .w_full()
                        .text_size(11.5)
                        .text_color(t.muted)
                        .child(tr("set.om_desc"))
                    )
                )
                .child(
                  v_flex()
                    .w_full()
                    .min_w(0)
                    .p(12)
                    .gap(10)
                    .rounded(8)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.raised)
                    .child(
                      h_flex()
                        .w_full()
                        .min_w(0)
                        .gap(8)
                        .justify_between()
                        .items_center()
                        .child(
                          v_flex()
                            .flex_1()
                            .min_w(0)
                            .gap(2)
                            .child(
                              div()
                                .text_size(12)
                                .font_weight(600)
                                .text_color(t.foreground)
                                .child(tr("set.om_hook_title"))
                            )
                            .child(
                              div()
                                .text_size(11)
                                .text_color(t.muted)
                                .child(
                                  info.supported
                                    ? info.currentTheme
                                      ? tr("set.om_detected_theme", { theme: info.currentTheme })
                                      : tr("set.om_detected")
                                    : info.checked
                                      ? tr("set.om_not_detected")
                                      : tr("set.om_checking")
                                )
                            )
                        )
                        .child(
                          div()
                            .px(8)
                            .py(3)
                            .rounded(5)
                            .border_1()
                            .border_color(info.hookInstalled ? t.accent : t.border)
                            .bg(info.hookInstalled ? t.selected : t.canvas ?? t.raised)
                            .text_size(11)
                            .font_weight(600)
                            .text_color(info.hookInstalled ? t.foreground : t.muted)
                            .child(info.hookInstalled ? tr("set.om_installed") : tr("set.om_not_installed"))
                        )
                    )
                    .child(
                      h_flex()
                        .gap(8)
                        .items_center()
                        .when(info.supported, (row) =>
                          row
                            .child(
                              h_flex()
                                .id("omarchy-hook-toggle")
                                .px(12)
                                .py(6)
                                .gap(6)
                                .rounded(6)
                                .items_center()
                                .cursor_pointer()
                                .border_1()
                                .border_color(info.hookInstalled ? t.border : t.accent)
                                .bg(info.hookInstalled ? t.canvas ?? t.raised : t.selected)
                                .text_size(11.5)
                                .font_weight(600)
                                .text_color(t.foreground)
                                .hover((s) => s.bg(t.hover))
                                .on_mouse_down("left", (_ev, cx) => {
                                  cx.stop_propagation();
                                  this.toggleOmarchyHook(cx);
                                })
                                .child(
                                  div().child(
                                    info.busy
                                      ? tr("set.om_working")
                                      : info.hookInstalled
                                        ? tr("set.om_uninstall")
                                        : tr("set.om_install")
                                  )
                                )
                            )
                            .child(
                              h_flex()
                                .id("omarchy-sync-now")
                                .px(12)
                                .py(6)
                                .gap(6)
                                .rounded(6)
                                .items_center()
                                .cursor_pointer()
                                .border_1()
                                .border_color(t.border)
                                .bg(t.canvas ?? t.raised)
                                .text_size(11.5)
                                .text_color(t.muted)
                                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                                .on_mouse_down("left", (_ev, cx) => {
                                  cx.stop_propagation();
                                  this.syncOmarchyThemeNow(cx);
                                })
                                .child(svg(ICON.refresh).size(12).text_color(t.muted))
                                .child(div().child(tr("set.om_sync_now")))
                            )
                        )
                    )
                    .when(Boolean(info.statusMsg), (box) =>
                      box.child(
                        div()
                          .text_size(11)
                          .text_color(t.muted)
                          .child(info.statusMsg)
                      )
                    )
                )
            );
          })
      );
  }
}
