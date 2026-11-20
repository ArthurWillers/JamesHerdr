// Project Runbook mod: auto-detected project scripts (package.json, Makefile, Cargo.toml)
// + custom saved commands per Space and General, runnable with 1 click.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Popup } from "gpui-base";
import { spaces, panes, focused, readTextFile, run, theme, shared, setShared, checking } from "herdr";
import { tr } from "./i18n.js";

const ICON = {
  play: "mods/activity-bar/icons/runbook.svg",
  plus: "mods/james-chrome/plus.svg",
  close: "mods/james-chrome/x.svg",
  refresh: "mods/source-control/icons/refresh.svg",
};

const STORE_KEY = "james-runbook.custom";
const GLOBAL_KEY = "__global__";
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

function activeSpaceInfo() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on =
    f?.pane === null
      ? f.terminal?.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : (space?.machine ?? null);
  const folder = pane?.cwd || f?.cwd || space?.folder || "";
  const scopeId = folder || space?.id || GLOBAL_KEY;
  const label = space?.name || folder.split(/[\\/]/).pop() || "Space";
  return { space, folder, on, scopeId, label };
}

export default class JamesRunbook extends View {
  init(_props, cx) {
    this.tab = "space"; // "space" | "general"
    this.adding = false;
    this.detected = [];
    this.detectedKey = "";
    this.loadingDetected = false;
    this.nameInput = InputState.new({ placeholder: tr("runbook.name_placeholder") });
    this.cmdInput = InputState.new({ placeholder: tr("runbook.cmd_placeholder") });
    this.cmdInput.on("submit", (_ev, cx) => this.addCommand(cx));
    if (!checking()) this.detectProjectScripts(cx);
  }

  getData() {
    const raw = shared(STORE_KEY);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }

  saveList(bucketKey, list) {
    setShared(STORE_KEY, { ...this.getData(), [bucketKey]: list });
  }

  currentBucket() {
    return this.tab === "general" ? GLOBAL_KEY : activeSpaceInfo().scopeId;
  }

  detectProjectScripts(cx) {
    const { folder, on } = activeSpaceInfo();
    const dKey = `${on ?? ""}:${folder}`;
    this.detectedKey = dKey;
    if (!folder) {
      this.detected = [];
      return;
    }
    this.loadingDetected = true;
    cx.spawn(async (cx) => {
      const found = [];
      try {
        const [pkgRaw, pnpmLock, bunLock, makefileRaw, cargoRaw] = await Promise.all([
          readTextFile(`${folder}/package.json`, { on }).catch(() => null),
          readTextFile(`${folder}/pnpm-lock.yaml`, { on }).catch(() => null),
          readTextFile(`${folder}/bun.lockb`, { on }).catch(() => null),
          readTextFile(`${folder}/Makefile`, { on }).catch(() => null),
          readTextFile(`${folder}/Cargo.toml`, { on }).catch(() => null),
        ]);
        if (pkgRaw) {
          try {
            const pkg = JSON.parse(pkgRaw);
            const runner = bunLock ? "bun run" : pnpmLock ? "pnpm" : "npm run";
            for (const [k, v] of Object.entries(pkg.scripts ?? {})) {
              found.push({
                id: `pkg-${k}`,
                name: k,
                cmd: `${runner} ${k}`,
                source: "package.json",
                detail: String(v),
              });
            }
          } catch {
            // invalid package.json
          }
        }
        if (makefileRaw) {
          const seen = new Set();
          for (const line of makefileRaw.split("\n")) {
            const m = line.match(/^([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s*:/);
            if (m && !m[1].startsWith(".") && !seen.has(m[1])) {
              seen.add(m[1]);
              found.push({
                id: `make-${m[1]}`,
                name: m[1],
                cmd: `make ${m[1]}`,
                source: "Makefile",
              });
              if (seen.size >= 16) break;
            }
          }
        }
        if (cargoRaw) {
          for (const [name, cmd] of [
            ["cargo check", "cargo check"],
            ["cargo test", "cargo test"],
            ["cargo run", "cargo run"],
            ["cargo build", "cargo build --release"],
          ]) {
            found.push({ id: `cargo-${name}`, name, cmd, source: "Cargo.toml" });
          }
        }
      } finally {
        if (this.detectedKey === dKey) {
          this.detected = found;
          this.loadingDetected = false;
          cx.notify();
        }
      }
    });
  }

  addCommand(cx) {
    const cmd = (this.cmdInput.value() ?? "").trim();
    if (!cmd) return;
    const name = (this.nameInput.value() ?? "").trim() || cmd.split(/\s+/)[0];
    const bucket = this.currentBucket();
    const list = [...(this.getData()[bucket] ?? [])];
    list.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      cmd,
    });
    this.saveList(bucket, list);
    this.nameInput.set_value("");
    this.cmdInput.set_value("");
    this.adding = false;
    cx.notify();
  }

  deleteCommand(id, cx) {
    const bucket = this.currentBucket();
    const list = (this.getData()[bucket] ?? []).filter((c) => c.id !== id);
    this.saveList(bucket, list);
    cx.notify();
  }

  runCommand(item) {
    const { space, folder } = activeSpaceInfo();
    run("tab.new", {
      name: item.name,
      space: space?.id,
      folder: folder || undefined,
      argv: ["sh", "-c", `${item.cmd}; echo ""; exec "\${SHELL:-sh}"`],
    });
  }

  renderRow(item, isCustom, t) {
    const playBtn = h_flex()
      .id(`rb-play-${item.id}`)
      .w(24)
      .h(24)
      .rounded(5)
      .flex_none()
      .items_center()
      .justify_center()
      .cursor_pointer()
      .border_1()
      .border_color(t.accent + "66")
      .bg(t.selected)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_ev, cx) => {
        cx.stop_propagation();
        tipState.id = null;
        this.runCommand(item);
      })
      .child(svg(ICON.play).size(11).text_color(t.accent));

    return h_flex()
      .id(`rb-row-${item.id}`)
      .w_full()
      .px(8)
      .py(6)
      .gap(8)
      .rounded(7)
      .items_center()
      .bg(t.raised)
      .border_1()
      .border_color(t.border)
      .hover((s) => s.bg(t.hover))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                div()
                  .text_size(12.2)
                  .font_weight(500)
                  .text_color(t.foreground)
                  .truncate()
                  .child(item.name)
              )
              .when(Boolean(item.source), (el) =>
                el.child(
                  div()
                    .px(4)
                    .py(1)
                    .rounded(4)
                    .bg(t.canvas ?? t.background)
                    .text_size(9.5)
                    .text_color(t.dim)
                    .child(item.source)
                )
              )
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .truncate()
              .child(item.cmd)
          )
      )
      .child(tipAbove(`rb-run-${item.id}`, tr("runbook.run"), playBtn, t, "bottom_right"))
      .when(isCustom, (row) => {
        const delBtn = h_flex()
          .id(`rb-del-${item.id}`)
          .w(22)
          .h(22)
          .rounded(5)
          .flex_none()
          .items_center()
          .justify_center()
          .cursor_pointer()
          .hover((s) => s.bg(t.surface))
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            tipState.id = null;
            this.deleteCommand(item.id, cx);
          })
          .child(svg(ICON.close).size(11).text_color(t.dim));
        return row.child(
          tipAbove(`rb-rm-${item.id}`, tr("todos.delete"), delBtn, t, "bottom_right")
        );
      });
  }

  render(cx) {
    const info = activeSpaceInfo();
    const dKey = `${info.on ?? ""}:${info.folder}`;
    if (dKey !== this.detectedKey && !checking()) {
      this.detectProjectScripts(cx);
    }

    const t = theme();
    const data = this.getData();
    const customList =
      this.tab === "general"
        ? (data[GLOBAL_KEY] ?? [])
        : (data[info.scopeId] ?? []);

    const tabBtn = (id, label) => {
      const active = this.tab === id;
      return h_flex()
        .id(`rb-tab-${id}`)
        .flex_1()
        .h(28)
        .px(8)
        .rounded(6)
        .items_center()
        .justify_center()
        .cursor_pointer()
        .border_1()
        .border_color(active ? t.accent : t.border)
        .bg(active ? t.selected : t.raised)
        .text_size(12)
        .font_weight(active ? 600 : 400)
        .text_color(active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_ev, cx) => {
          cx.stop_propagation();
          this.tab = id;
          cx.notify();
        })
        .child(label);
    };

    const addToggleBtn = h_flex()
      .id("rb-toggle-add")
      .w(24)
      .h(22)
      .rounded(5)
      .items_center()
      .justify_center()
      .flex_none()
      .cursor_pointer()
      .border_1()
      .border_color(this.adding ? t.accent : t.border)
      .bg(this.adding ? t.selected : t.raised)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_ev, cx) => {
        cx.stop_propagation();
        tipState.id = null;
        this.adding = !this.adding;
        if (this.adding) {
          cx.timer.after(20, () => this.nameInput.focus());
        }
        cx.notify();
      })
      .child(svg(ICON.plus).size(12).text_color(t.foreground));

    const refreshBtn = h_flex()
      .id("rb-refresh")
      .w(24)
      .h(22)
      .rounded(5)
      .items_center()
      .justify_center()
      .flex_none()
      .cursor_pointer()
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_ev, cx) => {
        cx.stop_propagation();
        tipState.id = null;
        this.detectProjectScripts(cx);
      })
      .child(svg(ICON.refresh).size(11).text_color(t.muted));

    return v_flex()
      .id("james-runbook")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      // Header
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(12)
          .gap(6)
          .items_center()
          .rounded_t(9)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome ?? t.background)
          .child(div().font_semibold().child(tr("runbook.title")))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_right()
              .text_size(11.5)
              .text_color(t.dim)
              .child(this.tab === "general" ? tr("todos.general") : info.label)
          )
          .when(this.tab === "space", (el) =>
            el.child(
              tipAbove("rb-refresh-tip", tr("set.ai_refresh"), refreshBtn, t, "bottom_right")
            )
          )
          .child(
            tipAbove("rb-add-tip", tr("runbook.add_command"), addToggleBtn, t, "bottom_right")
          )
      )
      // Scope Tabs
      .child(
        h_flex()
          .px(10)
          .pt(10)
          .pb(8)
          .gap(6)
          .border_b(1)
          .border_color(t.border)
          .child(tabBtn("space", tr("todos.space")))
          .child(tabBtn("general", tr("todos.general")))
      )
      // Add Custom Command Form
      .when(this.adding, (el) =>
        el.child(
          v_flex()
            .p(10)
            .gap(6)
            .border_b(1)
            .border_color(t.border)
            .bg(t.chrome ?? t.raised)
            .child(
              Input.new(this.nameInput)
                .w_full()
                .h(28)
                .px(8)
                .rounded(6)
                .border_1()
                .border_color(t.border)
                .bg(t.canvas ?? t.background)
                .text_size(12)
                .text_color(t.foreground)
            )
            .child(
              Input.new(this.cmdInput)
                .w_full()
                .h(28)
                .px(8)
                .rounded(6)
                .border_1()
                .border_color(t.border)
                .bg(t.canvas ?? t.background)
                .text_size(12)
                .text_color(t.foreground)
            )
            .child(
              h_flex()
                .justify_end()
                .gap(6)
                .child(
                  div()
                    .id("rb-cancel-add")
                    .px(10)
                    .py(4)
                    .rounded(6)
                    .cursor_pointer()
                    .text_size(11.5)
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover))
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.adding = false;
                      cx.notify();
                    })
                    .child(tr("runbook.cancel"))
                )
                .child(
                  div()
                    .id("rb-save-add")
                    .px(12)
                    .py(4)
                    .rounded(6)
                    .cursor_pointer()
                    .border_1()
                    .border_color(t.accent)
                    .bg(t.selected)
                    .text_size(11.5)
                    .font_weight(600)
                    .text_color(t.foreground)
                    .hover((s) => s.bg(t.hover))
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.addCommand(cx);
                    })
                    .child(tr("runbook.save"))
                )
            )
        )
      )
      // Command Lists
      .child(
        v_flex()
          .id("runbook-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(8)
          .gap(10)
          // Custom Commands
          .child(
            v_flex()
              .gap(5)
              .child(
                div()
                  .px(4)
                  .text_size(10.5)
                  .font_weight(600)
                  .text_color(t.dim)
                  .child(tr("runbook.saved_section"))
              )
              .when(customList.length === 0, (c) =>
                c.child(
                  div()
                    .px(6)
                    .py(4)
                    .text_size(11.5)
                    .text_color(t.dim)
                    .child(tr("runbook.empty_saved"))
                )
              )
              .children(customList.map((item) => this.renderRow(item, true, t)))
          )
          // Auto-detected Project Scripts (Space tab only)
          .when(this.tab === "space", (col) =>
            col.child(
              v_flex()
                .gap(5)
                .child(
                  div()
                    .px(4)
                    .text_size(10.5)
                    .font_weight(600)
                    .text_color(t.dim)
                    .child(tr("runbook.detected_section"))
                )
                .when(this.detected.length === 0, (c) =>
                  c.child(
                    div()
                      .px(6)
                      .py(4)
                      .text_size(11.5)
                      .text_color(t.dim)
                      .child(
                        this.loadingDetected
                          ? tr("files.loading_files")
                          : tr("runbook.empty_detected")
                      )
                  )
                )
                .children(this.detected.map((item) => this.renderRow(item, false, t)))
            )
          )
      );
  }
}
