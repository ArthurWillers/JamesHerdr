// Project Runbook mod: auto-detected project scripts (package.json, Makefile, Cargo.toml)
// + custom saved commands per Space and General, runnable with 1 click.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Popup } from "gpui-base";
import { spaces, panes, focused, readTextFile, knownAgents, exec, openOverlay, run, theme, shared, setShared, checking, props } from "herdr";
import { tr } from "./i18n.js";

const ICON = {
  play: "mods/activity-bar/icons/runbook.svg",
  plus: "mods/james-chrome/plus.svg",
  close: "mods/james-chrome/x.svg",
  refresh: "mods/source-control/icons/refresh.svg",
  sparkles: "mods/source-control/icons/sparkles.svg",
  edit: "mods/james-chrome/edit.svg",
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

const interactiveShellArgv = (cmd) => [
  "sh",
  "-c",
  'S="${SHELL:-bash}"; exec "$S" -ic \'eval "$1"; echo ""; exec "${SHELL:-bash}"\' _ "$1"',
  "_",
  cmd,
];

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
    this.fixedGeneral = props()?.scope === "general";
    this.tab = this.fixedGeneral ? "general" : "space"; // "space" | "general"
    this.adding = false;
    this.editingId = null;
    this.newKind = "shell"; // "shell" | "agent" | "split"
    this.newAgentKey = "__default__";
    this.splitDir = "right"; // "right" | "down"
    this.splitInputs = [
      InputState.new({ placeholder: `${tr("runbook.terminal")} 1…` }),
      InputState.new({ placeholder: `${tr("runbook.terminal")} 2…` }),
    ];
    this.installedAgents = [];
    this.detected = [];
    this.detectedKey = "";
    this.loadingDetected = false;
    this.nameInput = InputState.new({ placeholder: tr("runbook.name_placeholder") });
    this.cmdInput = InputState.new({ placeholder: tr("runbook.cmd_placeholder") });
    this.cmdInput.on("submit", (_ev, cx) => this.addCommand(cx));
    if (!checking()) {
      this.detectProjectScripts(cx);
      this.loadAgents(cx);
    }
  }

  loadAgents(cx) {
    const { on } = activeSpaceInfo();
    cx.spawn(async (spawnCx) => {
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
        const opts = on ? { on } : undefined;
        const [list, realRes] = await Promise.all([
          knownAgents(opts),
          exec("sh", ["-c", checkScript], opts).catch(() => ({ code: 1, stdout: "" })),
        ]);
        const realBins = new Set(
          (realRes.code === 0 ? realRes.stdout : "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        );
        this.installedAgents = (list ?? []).filter((a) => {
          if (!a.installed) return false;
          if (realRes.code === 0) {
            const bin = a.run?.[0] ?? "";
            return realBins.has(bin) || realBins.has(a.key);
          }
          return true;
        });
        spawnCx.notify();
      } catch {
        // ignore
      }
    });
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

  addSplitSlot(value = "", cx) {
    const inp = InputState.new({
      placeholder: `${tr("runbook.terminal")} ${this.splitInputs.length + 1}…`,
      value,
    });
    this.splitInputs.push(inp);
    if (cx) cx.notify();
  }

  removeSplitSlot(idx, cx) {
    if (this.splitInputs.length <= 2) return;
    this.splitInputs.splice(idx, 1);
    cx.notify();
  }

  pickForSplit(cmd, cx) {
    const emptyIdx = this.splitInputs.findIndex((inp) => !(inp.value() ?? "").trim());
    if (emptyIdx >= 0) {
      this.splitInputs[emptyIdx].set_value(cmd);
    } else {
      this.addSplitSlot(cmd, null);
    }
    cx.notify();
  }

  editCommand(item, cx) {
    this.editingId = item.id;
    this.adding = true;
    this.nameInput.set_value(item.name || "");
    this.newKind = item.kind === "split" ? "split" : item.kind === "agent" ? "agent" : "shell";
    if (this.newKind === "split") {
      this.splitDir = item.splitDir === "down" ? "down" : "right";
      const cmds = Array.isArray(item.cmds) && item.cmds.length > 0 ? item.cmds : [item.cmd || ""];
      while (cmds.length < 2) cmds.push("");
      this.splitInputs = cmds.map((c, idx) =>
        InputState.new({
          placeholder: `${tr("runbook.terminal")} ${idx + 1}…`,
          value: c,
        })
      );
      this.cmdInput.set_value("");
    } else {
      this.cmdInput.set_value(item.cmd || "");
      this.newAgentKey = item.agentKey || "__default__";
    }
    cx.timer.after(20, () => this.nameInput.focus());
    cx.notify();
  }

  addCommand(cx) {
    const bucket = this.currentBucket();
    const list = [...(this.getData()[bucket] ?? [])];

    const upsert = (entry) => {
      if (this.editingId) {
        const idx = list.findIndex((x) => x.id === this.editingId);
        if (idx >= 0) {
          list[idx] = { ...entry, id: this.editingId };
          return;
        }
      }
      list.push(entry);
    };

    if (this.newKind === "split") {
      const cmds = this.splitInputs.map((i) => (i.value() ?? "").trim()).filter(Boolean);
      if (cmds.length < 2) return;
      const name = (this.nameInput.value() ?? "").trim() || cmds.map((c) => c.split(/\s+/)[0]).join(" + ");
      upsert({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        cmd: cmds.join("  ·  "),
        cmds,
        splitDir: this.splitDir,
        kind: "split",
      });
      this.saveList(bucket, list);
      this.nameInput.set_value("");
      this.splitInputs = [
        InputState.new({ placeholder: `${tr("runbook.terminal")} 1…` }),
        InputState.new({ placeholder: `${tr("runbook.terminal")} 2…` }),
      ];
      this.adding = false;
      this.editingId = null;
      cx.notify();
      return;
    }

    const cmd = (this.cmdInput.value() ?? "").trim();
    if (!cmd) return;
    const name = (this.nameInput.value() ?? "").trim() || cmd.split(/\s+/)[0];
    const pickedAgent =
      this.newKind === "agent" && this.newAgentKey !== "__default__"
        ? this.installedAgents.find((a) => a.key === this.newAgentKey)
        : null;
    upsert({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      cmd,
      kind: this.newKind,
      agentKey: this.newKind === "agent" ? this.newAgentKey : null,
      agentName: pickedAgent?.name ?? null,
      agentRun: pickedAgent?.run ?? null,
    });
    this.saveList(bucket, list);
    this.nameInput.set_value("");
    this.cmdInput.set_value("");
    this.adding = false;
    this.editingId = null;
    cx.notify();
  }

  deleteCommand(id, cx) {
    const bucket = this.currentBucket();
    const list = (this.getData()[bucket] ?? []).filter((c) => c.id !== id);
    this.saveList(bucket, list);
    cx.notify();
  }

  runWithAgent(item) {
    const { space, folder } = activeSpaceInfo();
    const def = shared("james.defaultAgent");
    const argv =
      item.agentRun ??
      (item.agentKey && item.agentKey !== "__default__"
        ? this.installedAgents.find((a) => a.key === item.agentKey)?.run
        : null) ??
      def?.run ??
      this.installedAgents[0]?.run;
    if (!argv) {
      openOverlay({
        mod: "james-settings",
        kind: "dialog",
        width: 600,
        height: 500,
        props: { section: "default-agent" },
      });
      return;
    }
    if (this.fixedGeneral) {
      run("layout.select", { stack: "center-stage", child: "work" });
    }
    run("tab.new", {
      name: item.name.slice(0, 28),
      space: space?.id,
      folder: folder || undefined,
      argv,
      task: item.cmd,
    });
  }

  runSplit(item, cx) {
    const cmds = Array.isArray(item.cmds) ? item.cmds.filter(Boolean) : [];
    if (cmds.length === 0) return;
    const { space, folder } = activeSpaceInfo();
    if (this.fixedGeneral) {
      run("layout.select", { stack: "center-stage", child: "work" });
    }
    run("tab.new", {
      name: item.name,
      space: space?.id,
      folder: folder || undefined,
      argv: interactiveShellArgv(cmds[0]),
    });
    const dir = item.splitDir === "down" ? "down" : "right";
    const rest = cmds.slice(1);
    const step = (idx, timerCx) => {
      if (idx >= rest.length) return;
      run("pane.split", {
        direction: dir,
        argv: interactiveShellArgv(rest[idx]),
      });
      if (idx + 1 < rest.length) {
        timerCx.timer.after(110, (nextCx) => step(idx + 1, nextCx));
      }
    };
    if (rest.length > 0) {
      cx.timer.after(130, (timerCx) => step(0, timerCx));
    }
  }

  runCommand(item, cx) {
    if (item.kind === "split") {
      this.runSplit(item, cx);
      return;
    }
    if (item.kind === "agent") {
      this.runWithAgent(item);
      return;
    }
    const { space, folder } = activeSpaceInfo();
    if (this.fixedGeneral) {
      run("layout.select", { stack: "center-stage", child: "work" });
    }
    run("tab.new", {
      name: item.name,
      space: space?.id,
      folder: folder || undefined,
      argv: interactiveShellArgv(item.cmd),
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
        this.runCommand(item, cx);
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
              .when(item.kind === "agent", (el) =>
                el.child(
                  div()
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.selected)
                    .text_size(9.5)
                    .text_color(t.accent)
                    .child(item.agentName || tr("routines.mode_agent"))
                )
              )
              .when(item.kind === "split", (el) =>
                el.child(
                  div()
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.selected)
                    .text_size(9.5)
                    .text_color(t.accent)
                    .child(
                      `${(item.cmds ?? []).length}× ${tr("runbook.split_label")} ${item.splitDir === "down" ? "↓" : "→"}`
                    )
                )
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
      .when(item.kind !== "agent" && item.kind !== "split", (row) => {
        const agBtn = h_flex()
          .id(`rb-ag-${item.id}`)
          .w(24)
          .h(24)
          .rounded(5)
          .flex_none()
          .items_center()
          .justify_center()
          .cursor_pointer()
          .border_1()
          .border_color(t.border)
          .bg(t.background)
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            tipState.id = null;
            this.runWithAgent(item);
          })
          .child(svg(ICON.sparkles).size(11).text_color(t.accent));
        return row.child(agBtn);
      })
      .child(playBtn)
      .when(isCustom, (row) => {
        const editBtn = h_flex()
          .id(`rb-edit-${item.id}`)
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
            this.editCommand(item, cx);
          })
          .child(svg(ICON.edit).size(11).text_color(t.muted));
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
            if (this.editingId === item.id) {
              this.editingId = null;
              this.adding = false;
            }
            this.deleteCommand(item.id, cx);
          })
          .child(svg(ICON.close).size(11).text_color(t.dim));
        return row.child(editBtn).child(delBtn);
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
      .h(26)
      .px(this.fixedGeneral ? 10 : 8)
      .gap(5)
      .rounded(6)
      .items_center()
      .justify_center()
      .flex_none()
      .cursor_pointer()
      .border_1()
      .border_color(this.adding ? t.accent : t.border)
      .bg(this.adding ? t.selected : t.raised)
      .text_size(11.5)
      .font_weight(500)
      .text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_ev, cx) => {
        cx.stop_propagation();
        tipState.id = null;
        if (this.adding && !this.editingId) {
          this.adding = false;
        } else {
          this.editingId = null;
          this.adding = true;
          this.newKind = "shell";
          this.nameInput.set_value("");
          this.cmdInput.set_value("");
          this.splitInputs = [
            InputState.new({ placeholder: `${tr("runbook.terminal")} 1…` }),
            InputState.new({ placeholder: `${tr("runbook.terminal")} 2…` }),
          ];
          cx.timer.after(20, () => this.nameInput.focus());
        }
        cx.notify();
      })
      .child(svg(ICON.plus).size(12).text_color(t.accent))
      .child(div().child(tr("runbook.add_command")));

    const refreshBtn = h_flex()
      .id("rb-refresh")
      .w(26)
      .h(26)
      .rounded(6)
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
      .when(!this.fixedGeneral, (el) =>
        el.rounded(10).overflow_hidden().border_1().border_color(t.border)
      )
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      // Header
      .child(
        h_flex()
          .h(46)
          .flex_none()
          .px(this.fixedGeneral ? 18 : 12)
          .gap(8)
          .items_center()
          .when(!this.fixedGeneral, (el) => el.rounded_t(9))
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
          .when(this.tab === "space", (el) => el.child(refreshBtn))
          .child(addToggleBtn)
      )
      // Scope Tabs
      .when(!this.fixedGeneral, (el) =>
        el.child(
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
            .when(this.newKind !== "split", (form) =>
              form.child(
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
            )
            // Type selector (Shell vs Agent vs Split Multi-Terminal) + Agent picker
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .flex_wrap()
                .child(
                  h_flex()
                    .id("rb-kind-shell")
                    .h(24)
                    .px(9)
                    .rounded(5)
                    .items_center()
                    .cursor_pointer()
                    .border_1()
                    .border_color(this.newKind === "shell" ? t.accent : t.border)
                    .bg(this.newKind === "shell" ? t.selected : t.raised)
                    .text_size(11)
                    .text_color(this.newKind === "shell" ? t.foreground : t.muted)
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.newKind = "shell";
                      cx.notify();
                    })
                    .child("Shell")
                )
                .child(
                  h_flex()
                    .id("rb-kind-agent")
                    .h(24)
                    .px(9)
                    .rounded(5)
                    .items_center()
                    .cursor_pointer()
                    .border_1()
                    .border_color(this.newKind === "agent" ? t.accent : t.border)
                    .bg(this.newKind === "agent" ? t.selected : t.raised)
                    .text_size(11)
                    .text_color(this.newKind === "agent" ? t.foreground : t.muted)
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.newKind = "agent";
                      cx.notify();
                    })
                    .child(tr("dash.agent_label"))
                )
                .child(
                  h_flex()
                    .id("rb-kind-split")
                    .h(24)
                    .px(9)
                    .rounded(5)
                    .items_center()
                    .cursor_pointer()
                    .border_1()
                    .border_color(this.newKind === "split" ? t.accent : t.border)
                    .bg(this.newKind === "split" ? t.selected : t.raised)
                    .text_size(11)
                    .text_color(this.newKind === "split" ? t.foreground : t.muted)
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.newKind = "split";
                      cx.notify();
                    })
                    .child(tr("runbook.split_label"))
                )
                .when(this.newKind === "agent", (row) =>
                  row
                    .child(
                      h_flex()
                        .id("rb-ag-pick-default")
                        .h(24)
                        .px(8)
                        .rounded(5)
                        .items_center()
                        .cursor_pointer()
                        .border_1()
                        .border_color(this.newAgentKey === "__default__" ? t.accent : t.border)
                        .bg(this.newAgentKey === "__default__" ? t.selected : t.background)
                        .text_size(10.5)
                        .text_color(this.newAgentKey === "__default__" ? t.foreground : t.dim)
                        .on_mouse_down("left", (_ev, cx) => {
                          cx.stop_propagation();
                          this.newAgentKey = "__default__";
                          cx.notify();
                        })
                        .child(tr("dash.default_tag"))
                    )
                    .children(
                      this.installedAgents.map((ag) =>
                        h_flex()
                          .id(`rb-ag-pick-${ag.key}`)
                          .h(24)
                          .px(8)
                          .rounded(5)
                          .items_center()
                          .cursor_pointer()
                          .border_1()
                          .border_color(this.newAgentKey === ag.key ? t.accent : t.border)
                          .bg(this.newAgentKey === ag.key ? t.selected : t.background)
                          .text_size(10.5)
                          .text_color(this.newAgentKey === ag.key ? t.foreground : t.dim)
                          .on_mouse_down("left", (_ev, cx) => {
                            cx.stop_propagation();
                            this.newAgentKey = ag.key;
                            cx.notify();
                          })
                          .child(ag.name)
                      )
                    )
                )
            )
            // Split Multi-Terminal Builder
            .when(this.newKind === "split", (form) => {
              const pickables = [
                ...customList.filter((c) => c.kind !== "split" && c.kind !== "agent"),
                ...(this.tab === "space" ? this.detected : []),
              ];
              return form.child(
                v_flex()
                  .gap(6)
                  .pt(2)
                  .children(
                    this.splitInputs.map((inp, idx) =>
                      h_flex()
                        .gap(6)
                        .items_center()
                        .child(
                          Input.new(inp)
                            .flex_1()
                            .h(26)
                            .px(8)
                            .rounded(6)
                            .border_1()
                            .border_color(t.border)
                            .bg(t.canvas ?? t.background)
                            .text_size(11.5)
                            .text_color(t.foreground)
                        )
                        .when(this.splitInputs.length > 2, (row) =>
                          row.child(
                            h_flex()
                              .id(`rb-split-rm-${idx}`)
                              .w(24)
                              .h(24)
                              .rounded(5)
                              .items_center()
                              .justify_center()
                              .cursor_pointer()
                              .hover((s) => s.bg(t.surface))
                              .on_mouse_down("left", (_ev, cx) => {
                                cx.stop_propagation();
                                this.removeSplitSlot(idx, cx);
                              })
                              .child(svg(ICON.close).size(11).text_color(t.dim))
                          )
                        )
                    )
                  )
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .flex_wrap()
                      .child(
                        h_flex()
                          .id("rb-split-add-slot")
                          .h(22)
                          .px(8)
                          .gap(4)
                          .rounded(5)
                          .items_center()
                          .cursor_pointer()
                          .border_1()
                          .border_color(t.border)
                          .bg(t.raised)
                          .text_size(10.5)
                          .text_color(t.foreground)
                          .hover((s) => s.bg(t.hover))
                          .on_mouse_down("left", (_ev, cx) => {
                            cx.stop_propagation();
                            this.addSplitSlot("", cx);
                          })
                          .child(svg(ICON.plus).size(10).text_color(t.accent))
                          .child(div().child(tr("runbook.add_terminal")))
                      )
                      .child(div().flex_1())
                      .child(
                        h_flex()
                          .id("rb-split-dir-right")
                          .h(22)
                          .px(7)
                          .rounded(5)
                          .items_center()
                          .cursor_pointer()
                          .border_1()
                          .border_color(this.splitDir === "right" ? t.accent : t.border)
                          .bg(this.splitDir === "right" ? t.selected : t.raised)
                          .text_size(10.5)
                          .text_color(this.splitDir === "right" ? t.foreground : t.muted)
                          .on_mouse_down("left", (_ev, cx) => {
                            cx.stop_propagation();
                            this.splitDir = "right";
                            cx.notify();
                          })
                          .child("→")
                      )
                      .child(
                        h_flex()
                          .id("rb-split-dir-down")
                          .h(22)
                          .px(7)
                          .rounded(5)
                          .items_center()
                          .cursor_pointer()
                          .border_1()
                          .border_color(this.splitDir === "down" ? t.accent : t.border)
                          .bg(this.splitDir === "down" ? t.selected : t.raised)
                          .text_size(10.5)
                          .text_color(this.splitDir === "down" ? t.foreground : t.muted)
                          .on_mouse_down("left", (_ev, cx) => {
                            cx.stop_propagation();
                            this.splitDir = "down";
                            cx.notify();
                          })
                          .child("↓")
                      )
                  )
                  .when(pickables.length > 0, (box) =>
                    box.child(
                      h_flex()
                        .gap(4)
                        .flex_wrap()
                        .pt(2)
                        .child(
                          div()
                            .w_full()
                            .text_size(10)
                            .text_color(t.dim)
                            .child(tr("runbook.pick_hint"))
                        )
                        .children(
                          pickables.slice(0, 12).map((p) =>
                            h_flex()
                              .id(`rb-pick-${p.id}`)
                              .h(20)
                              .px(6)
                              .rounded(4)
                              .items_center()
                              .cursor_pointer()
                              .border_1()
                              .border_color(t.border)
                              .bg(t.background)
                              .text_size(10)
                              .text_color(t.muted)
                              .hover((s) => s.bg(t.hover).text_color(t.foreground))
                              .on_mouse_down("left", (_ev, cx) => {
                                cx.stop_propagation();
                                this.pickForSplit(p.cmd, cx);
                              })
                              .child(`+ ${p.name}`)
                          )
                        )
                    )
                  )
              );
            })
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
                      this.editingId = null;
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
