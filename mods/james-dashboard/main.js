// Cockpit-inspired Agent-Agnostic General Dashboard:
// Greeting header + quick actions, 4 rich KPI cards, 2:1 asymmetric grid with
// Needs You spotlight, Active Agents, Spaces, Apps quick-launcher, General To-do, and Notes.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Editor, EditorState, Popup } from "gpui-base";
import { spaces, agents, machines, run, openOverlay, theme, settings, shared, setShared, home } from "herdr";
import { tr, currentLang } from "./i18n.js";

const ICON = {
  check: "mods/james-chrome/check.svg",
  plus: "mods/james-chrome/plus.svg",
  play: "mods/activity-bar/icons/runbook.svg",
  todos: "mods/activity-bar/icons/todos.svg",
  notes: "mods/activity-bar/icons/notes.svg",
  dashboard: "mods/activity-bar/icons/dashboard.svg",
  clock: "mods/activity-bar/icons/routines.svg",
  github: "mods/activity-bar/icons/github.svg",
  sliders: "mods/source-control/icons/sliders.svg",
  sparkles: "mods/source-control/icons/sparkles.svg",
  server: "mods/james-chrome/server.svg",
  monitor: "mods/james-chrome/monitor.svg",
  branch: "mods/james-chrome/branch.svg",
};

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

function greetingKey() {
  const h = new Date().getHours();
  if (h < 12) return "dash.good_morning";
  if (h < 18) return "dash.good_afternoon";
  return "dash.good_evening";
}

function formattedDate() {
  try {
    return new Intl.DateTimeFormat(currentLang(), {
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(new Date());
  } catch {
    return new Date().toDateString().slice(0, 10);
  }
}

export default class JamesDashboard extends View {
  init() {
    this.todoInput = InputState.new({ placeholder: tr("todos.placeholder") });
    this.todoInput.on("submit", (_ev, cx) => this.addGeneralTodo(cx));
    this.newTodoPriority = "medium"; // "high" | "medium" | "low"

    const t = theme();
    const notesData = shared("james-notes.data") ?? {};
    this.lastSyncedNote = notesData[GLOBAL_KEY] ?? "";
    this.suppressNoteChange = false;
    this.noteSaveSeq = 0;

    this.notesEditor = EditorState.new({
      language: "md",
      readonly: false,
      line_numbers: false,
      folding: false,
      soft_wrap: true,
      value: this.lastSyncedNote,
      font_family: settings().font_family,
      font_size: 12,
      syntax: {
        keyword: t.ansi5,
        string: t.ansi2,
        comment: t.dim,
        function: t.ansi4,
        type: t.ansi3,
        number: t.ansi1,
        constant: t.ansi6,
      },
    });
    this.notesEditor.on("change", (_ev, cx) => {
      if (this.suppressNoteChange) return;
      const val = this.notesEditor.value();
      const seq = ++this.noteSaveSeq;
      cx.timer.after(300, (timerCx) => {
        if (this.noteSaveSeq !== seq) return;
        const raw = shared("james-notes.data");
        const all = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        this.lastSyncedNote = val;
        setShared("james-notes.data", { ...all, [GLOBAL_KEY]: val });
        timerCx.notify();
      });
    });
  }

  addGeneralTodo(cx) {
    const text = (this.todoInput.value() ?? "").trim();
    if (!text) return;
    const raw = shared("james-todos.data");
    const all = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const list = [...(all[GLOBAL_KEY] ?? [])];
    list.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      note: "",
      priority: this.newTodoPriority,
      done: false,
    });
    setShared("james-todos.data", { ...all, [GLOBAL_KEY]: list });
    this.todoInput.set_value("");
    cx.notify();
  }

  cycleTodoPriority(id, cx) {
    const order = ["high", "medium", "low"];
    const raw = shared("james-todos.data");
    const all = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const list = (all[GLOBAL_KEY] ?? []).map((item) => {
      if (item.id !== id) return item;
      const cur = item.priority ?? "medium";
      return { ...item, priority: order[(order.indexOf(cur) + 1) % order.length] };
    });
    setShared("james-todos.data", { ...all, [GLOBAL_KEY]: list });
    cx.notify();
  }

  toggleGeneralTodo(id, cx) {
    const raw = shared("james-todos.data");
    const all = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const list = (all[GLOBAL_KEY] ?? []).map((item) =>
      item.id === id ? { ...item, done: !item.done } : item
    );
    setShared("james-todos.data", { ...all, [GLOBAL_KEY]: list });
    cx.notify();
  }

  openGeneralPage(pageId) {
    run("layout.select", { stack: "center-stage", child: pageId });
  }

  runGlobalCommand(item) {
    const space = spaces().find((s) => s.active);
    run("layout.select", { stack: "center-stage", child: "work" });
    run("tab.new", {
      name: item.name,
      space: space?.id,
      folder: space?.folder || undefined,
      argv: [
        "sh",
        "-c",
        'S="${SHELL:-bash}"; exec "$S" -ic \'eval "$1"; echo ""; exec "${SHELL:-bash}"\' _ "$1"',
        "_",
        item.cmd,
      ],
    });
  }

  render() {
    const t = theme();
    const allSpaces = spaces();
    const allAgents = agents();
    const allMachines = machines();
    const totalTabs = allSpaces.reduce((n, s) => n + (s.tabs?.length ?? 0), 0);

    const workingAgents = allAgents.filter((a) => a.status === "working");
    const blockedAgents = allAgents.filter((a) => a.status === "blocked");
    const doneAgents = allAgents.filter((a) => a.status === "done");

    const todoData = shared("james-todos.data") ?? {};
    const globalTodos = (todoData[GLOBAL_KEY] ?? []).filter((x) => !x.done);
    const highPrioCount = globalTodos.filter((x) => x.priority === "high").length;

    const runbookData = shared("james-runbook.custom") ?? {};
    const globalRunbook = runbookData[GLOBAL_KEY] ?? [];

    const notesData = shared("james-notes.data") ?? {};
    const externalNote = notesData[GLOBAL_KEY] ?? "";
    if (externalNote !== this.lastSyncedNote && externalNote !== this.notesEditor.value()) {
      this.lastSyncedNote = externalNote;
      this.suppressNoteChange = true;
      this.notesEditor.set_value(externalNote);
      this.suppressNoteChange = false;
    }

    const subtitle =
      blockedAgents.length > 0 || workingAgents.length > 0
        ? tr("dash.summary_busy", {
            blocked: blockedAgents.length,
            working: workingAgents.length,
          })
        : tr("dash.summary_quiet", {
            spaces: allSpaces.length,
            tabs: totalTabs,
          });

    const statCard = (id, iconPath, label, value, sub, valueColor, onClick) =>
      v_flex()
        .id(id)
        .flex_1()
        .min_w(0)
        .p(14)
        .gap(6)
        .rounded(10)
        .border_1()
        .border_color(t.border)
        .bg(t.background)
        .when(Boolean(onClick), (el) =>
          el
            .cursor_pointer()
            .hover((s) => s.bg(t.raised))
            .on_mouse_down("left", (_ev, cx) => {
              cx.stop_propagation();
              onClick(cx);
            })
        )
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(svg(iconPath).size(13).text_color(t.muted))
            .child(div().text_size(11.5).text_color(t.muted).truncate().child(label))
        )
        .child(
          div()
            .text_size(22)
            .font_weight(700)
            .text_color(valueColor)
            .child(String(value))
        )
        .child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .truncate()
            .child(sub)
        );

    const cardHeader = (title, actionLabel, onAction) =>
      h_flex()
        .h(36)
        .px(12)
        .items_center()
        .justify_between()
        .rounded_t(9)
        .border_b(1)
        .border_color(t.border)
        .bg(t.chrome ?? t.raised)
        .child(
          div()
            .text_size(11)
            .font_weight(600)
            .text_color(t.muted)
            .child(title)
        )
        .when(Boolean(actionLabel && onAction), (el) =>
          el.child(
            div()
              .px(6)
              .py(2)
              .rounded(4)
              .cursor_pointer()
              .text_size(11)
              .text_color(t.accent)
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_ev, cx) => {
                cx.stop_propagation();
                onAction(cx);
              })
              .child(actionLabel)
          )
        );

    const appRow = (id, iconPath, title, rightMeta, rightColor, onClick) =>
      h_flex()
        .id(id)
        .h(34)
        .px(10)
        .gap(10)
        .rounded(7)
        .items_center()
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_ev, cx) => {
          cx.stop_propagation();
          onClick(cx);
        })
        .child(svg(iconPath).size(14).flex_none().text_color(t.muted))
        .child(
          div()
            .flex_1()
            .min_w(0)
            .text_size(12.2)
            .text_color(t.foreground)
            .child(title)
        )
        .child(
          div()
            .text_size(11.5)
            .text_color(rightColor ?? t.dim)
            .child(rightMeta)
        );

    return v_flex()
      .id("james-dashboard")
      .size_full()
      .min_h(0)
      .bg(t.canvas ?? t.background)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        v_flex()
          .id("dashboard-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .px(24)
          .py(20)
          .gap(18)
          // Cockpit-style Greeting Header + Quick Actions
          .child(
            h_flex()
              .w_full()
              .items_end()
              .justify_between()
              .gap(12)
              .child(
                v_flex()
                  .gap(3)
                  .child(
                    div()
                      .text_size(11.5)
                      .text_color(t.dim)
                      .child(formattedDate())
                  )
                  .child(
                    div()
                      .text_size(24)
                      .font_weight(700)
                      .text_color(t.foreground)
                      .child(tr(greetingKey()))
                  )
                  .child(
                    div()
                      .text_size(12.5)
                      .text_color(t.muted)
                      .child(subtitle)
                  )
              )
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(
                    h_flex()
                      .id("dash-new-space")
                      .h(32)
                      .px(12)
                      .gap(6)
                      .rounded(7)
                      .items_center()
                      .cursor_pointer()
                      .border_1()
                      .border_color(t.border)
                      .bg(t.background)
                      .text_size(12)
                      .text_color(t.muted)
                      .hover((s) => s.bg(t.hover).text_color(t.foreground))
                      .on_mouse_down("left", (_ev, cx) => {
                        cx.stop_propagation();
                        run("layout.select", { stack: "center-stage", child: "work" });
                        run("space.new", { folder: home() });
                      })
                      .child(svg(ICON.plus).size(13).text_color(t.accent))
                      .child(div().child(tr("dash.new_space")))
                  )
              )
          )
          // Row 1: 4 Rich KPI Cards
          .child(
            h_flex()
              .w_full()
              .gap(12)
              .child(
                statCard(
                  "dash-kpi-agents",
                  ICON.sparkles,
                  tr("dash.agents_section"),
                  blockedAgents.length > 0
                    ? `${blockedAgents.length} ${tr("dash.needs_you").toLowerCase()}`
                    : `${workingAgents.length} ${tr("dash.working").toLowerCase()}`,
                  tr("dash.total_sub", {
                    total: allAgents.length,
                    done: doneAgents.length,
                  }),
                  blockedAgents.length > 0
                    ? t.blocked
                    : workingAgents.length > 0
                      ? t.working
                      : t.foreground,
                  null
                )
              )
              .child(
                statCard(
                  "dash-kpi-todos",
                  ICON.todos,
                  tr("act.todos"),
                  globalTodos.length,
                  tr("dash.high_prio_sub", { high: highPrioCount }),
                  globalTodos.length > 0 ? t.accent : t.dim,
                  () => this.openGeneralPage("todos-page")
                )
              )
              .child(
                statCard(
                  "dash-kpi-runbook",
                  ICON.play,
                  tr("act.runbook"),
                  globalRunbook.length,
                  tr("dash.saved_count", { count: globalRunbook.length }),
                  globalRunbook.length > 0 ? t.foreground : t.dim,
                  () => this.openGeneralPage("runbook-page")
                )
              )
              .child(
                statCard(
                  "dash-kpi-spaces",
                  ICON.dashboard,
                  tr("sb.spaces"),
                  allSpaces.length,
                  tr("dash.tabs_sub", { tabs: totalTabs }),
                  t.foreground,
                  null
                )
              )
          )
          // Row 2: 2:1 Asymmetric Cockpit Grid
          .child(
            h_flex()
              .w_full()
              .gap(16)
              .items_start()
              // Main Left Column (flex_grow 2)
              .child(
                v_flex()
                  .flex_grow(2)
                  .min_w(0)
                  .gap(16)
                  // Needs You Spotlight (only when agents are blocked)
                  .when(blockedAgents.length > 0, (col) =>
                    col.child(
                      v_flex()
                        .w_full()
                        .p(12)
                        .gap(8)
                        .rounded(10)
                        .border_1()
                        .border_color(t.blocked + "66")
                        .bg(t.blocked + "12")
                        .child(
                          h_flex()
                            .gap(6)
                            .items_center()
                            .child(div().size(7).rounded(4).bg(t.blocked))
                            .child(
                              div()
                                .text_size(11)
                                .font_weight(700)
                                .text_color(t.blocked)
                                .child(`${tr("dash.needs_you_section")} (${blockedAgents.length})`)
                            )
                        )
                        .children(
                          blockedAgents.map((ag, idx) => {
                            const sp = allSpaces.find((s) => s.id === ag.space);
                            return h_flex()
                              .id(`dash-blocked-${idx}-${ag.tab}`)
                              .p(10)
                              .gap(10)
                              .rounded(8)
                              .items_center()
                              .bg(t.background)
                              .border_1()
                              .border_color(t.blocked + "44")
                              .when(Boolean(ag.program?.icon), (r) =>
                                r.child(
                                  ag.program.tint
                                    ? svg(ag.program.icon).size(15).flex_none().text_color(t.blocked)
                                    : image(ag.program.icon).size(15).flex_none()
                                )
                              )
                              .child(
                                v_flex()
                                  .flex_1()
                                  .min_w(0)
                                  .gap(2)
                                  .child(
                                    div()
                                      .text_size(12.5)
                                      .font_weight(600)
                                      .truncate()
                                      .child(ag.program?.name || "Agent")
                                  )
                                  .when(Boolean(sp?.name), (el) =>
                                    el.child(
                                      div()
                                        .text_size(11)
                                        .text_color(t.dim)
                                        .truncate()
                                        .child(sp.name)
                                    )
                                  )
                              )
                              .child(
                                div()
                                  .id(`dash-go-blocked-${idx}`)
                                  .px(10)
                                  .py(5)
                                  .rounded(6)
                                  .cursor_pointer()
                                  .bg(t.blocked)
                                  .text_size(11.5)
                                  .font_weight(600)
                                  .text_color("#ffffff")
                                  .on_mouse_down("left", (_ev, cx) => {
                                    cx.stop_propagation();
                                    run("layout.select", { stack: "center-stage", child: "work" });
                                    if (ag.space) run("space.select", { id: ag.space });
                                    if (ag.tab) run("tab.select", { id: ag.tab });
                                  })
                                  .child(tr("dash.go_to_agent"))
                              );
                          })
                        )
                    )
                  )
                  // Active Agents Card
                  .child(
                    v_flex()
                      .w_full()
                      .rounded(10)
                      .border_1()
                      .border_color(t.border)
                      .bg(t.background)
                      .child(cardHeader(tr("dash.agents_section"), null, null))
                      .child(
                        v_flex()
                          .p(10)
                          .gap(6)
                          .when(allAgents.length === 0, (c) =>
                            c.child(
                              div()
                                .p(6)
                                .text_size(12)
                                .text_color(t.dim)
                                .child(tr("sb.no_chats"))
                            )
                          )
                          .children(
                            allAgents.map((ag, idx) => {
                              const sp = allSpaces.find((s) => s.id === ag.space);
                              const stColor =
                                ag.status === "blocked"
                                  ? t.blocked
                                  : ag.status === "working"
                                    ? t.working
                                    : ag.status === "done"
                                      ? t.done
                                      : t.dim;
                              return h_flex()
                                .id(`dash-ag-${idx}-${ag.tab}`)
                                .px(10)
                                .py(8)
                                .gap(10)
                                .rounded(7)
                                .items_center()
                                .cursor_pointer()
                                .bg(t.raised)
                                .border_1()
                                .border_color(t.border)
                                .hover((s) => s.bg(t.hover))
                                .on_mouse_down("left", (_ev, cx) => {
                                  cx.stop_propagation();
                                  run("layout.select", { stack: "center-stage", child: "work" });
                                  if (ag.space) run("space.select", { id: ag.space });
                                  if (ag.tab) run("tab.select", { id: ag.tab });
                                })
                                .when(Boolean(ag.program?.icon), (r) =>
                                  r.child(
                                    ag.program.tint
                                      ? svg(ag.program.icon).size(14).flex_none().text_color(t.muted)
                                      : image(ag.program.icon).size(14).flex_none()
                                  )
                                )
                                .child(
                                  v_flex()
                                    .flex_1()
                                    .min_w(0)
                                    .gap(1)
                                    .child(
                                      div()
                                        .text_size(12.5)
                                        .font_weight(500)
                                        .truncate()
                                        .child(ag.program?.name || "Agent")
                                    )
                                    .when(Boolean(sp?.name), (el) =>
                                      el.child(
                                        div()
                                          .text_size(11)
                                          .text_color(t.dim)
                                          .truncate()
                                          .child(sp.name)
                                      )
                                    )
                                )
                                .child(div().size(7).rounded(4).flex_none().bg(stColor));
                            })
                          )
                      )
                  )
                  // General To-do Card
                  .child(
                    v_flex()
                      .w_full()
                      .rounded(10)
                      .border_1()
                      .border_color(t.border)
                      .bg(t.background)
                      .child(
                        cardHeader(tr("dash.todos_section"), tr("dash.open_all"), () =>
                          this.openGeneralPage("todos-page")
                        )
                      )
                      .child(
                        v_flex()
                          .p(10)
                          .gap(8)
                          .child(
                            h_flex()
                              .gap(6)
                              .items_center()
                              .child(
                                Input.new(this.todoInput)
                                  .flex_1()
                                  .h(30)
                                  .px(10)
                                  .rounded(7)
                                  .border_1()
                                  .border_color(t.border)
                                  .bg(t.canvas ?? t.raised)
                                  .text_size(12)
                                  .text_color(t.foreground)
                              )
                              .child(
                                (() => {
                                  const order = ["high", "medium", "low"];
                                  const color =
                                    this.newTodoPriority === "high"
                                      ? "#f14c4c"
                                      : this.newTodoPriority === "low"
                                        ? "#73c991"
                                        : "#4daafc";
                                  return h_flex()
                                    .id("dash-todo-prio-pick")
                                    .h(30)
                                    .px(9)
                                    .gap(5)
                                    .rounded(7)
                                    .flex_none()
                                    .items_center()
                                    .cursor_pointer()
                                    .border_1()
                                    .border_color(t.border)
                                    .bg(t.raised)
                                    .hover((s) => s.bg(t.hover))
                                    .on_mouse_down("left", (_ev, cx) => {
                                      cx.stop_propagation();
                                      this.newTodoPriority =
                                        order[(order.indexOf(this.newTodoPriority) + 1) % order.length];
                                      cx.notify();
                                    })
                                    .child(div().size(7).rounded(4).bg(color))
                                    .child(
                                      div()
                                        .text_size(11)
                                        .text_color(t.foreground)
                                        .child(tr(`todos.prio_${this.newTodoPriority}`))
                                    );
                                })()
                              )
                              .child(
                                h_flex()
                                  .id("dash-todo-add")
                                  .w(30)
                                  .h(30)
                                  .rounded(7)
                                  .flex_none()
                                  .items_center()
                                  .justify_center()
                                  .cursor_pointer()
                                  .border_1()
                                  .border_color(t.accent)
                                  .bg(t.selected)
                                  .hover((s) => s.bg(t.hover))
                                  .on_mouse_down("left", (_ev, cx) => {
                                    cx.stop_propagation();
                                    this.addGeneralTodo(cx);
                                  })
                                  .child(svg(ICON.plus).size(13).text_color(t.foreground))
                              )
                          )
                          .when(globalTodos.length === 0, (col) =>
                            col.child(
                              div()
                                .p(6)
                                .text_size(12)
                                .text_color(t.dim)
                                .child(tr("todos.empty"))
                            )
                          )
                          .children(
                            globalTodos.slice(0, 6).map((item) => {
                              const prioColor =
                                item.priority === "high"
                                  ? "#f14c4c"
                                  : item.priority === "low"
                                    ? "#73c991"
                                    : "#4daafc";
                              return h_flex()
                                .id(`dash-todo-${item.id}`)
                                .px(10)
                                .py(7)
                                .gap(8)
                                .rounded(7)
                                .items_center()
                                .bg(t.raised)
                                .border_1()
                                .border_color(t.border)
                                .hover((s) => s.bg(t.hover))
                                .child(
                                  h_flex()
                                    .id(`dash-chk-${item.id}`)
                                    .w(15)
                                    .h(15)
                                    .rounded(4)
                                    .flex_none()
                                    .items_center()
                                    .justify_center()
                                    .cursor_pointer()
                                    .border_1()
                                    .border_color(t.muted)
                                    .bg(t.canvas ?? t.background)
                                    .on_mouse_down("left", (_ev, cx) => {
                                      cx.stop_propagation();
                                      this.toggleGeneralTodo(item.id, cx);
                                    })
                                )
                                .child(
                                  h_flex()
                                    .id(`dash-todo-prio-${item.id}`)
                                    .px(6)
                                    .py(2)
                                    .gap(4)
                                    .rounded(5)
                                    .flex_none()
                                    .items_center()
                                    .cursor_pointer()
                                    .bg(t.canvas ?? t.background)
                                    .border_1()
                                    .border_color(t.border)
                                    .hover((s) => s.bg(t.hover))
                                    .on_mouse_down("left", (_ev, cx) => {
                                      cx.stop_propagation();
                                      this.cycleTodoPriority(item.id, cx);
                                    })
                                    .child(div().size(6).rounded(3).bg(prioColor))
                                    .child(
                                      div()
                                        .text_size(10)
                                        .text_color(t.muted)
                                        .child(tr(`todos.prio_${item.priority ?? "medium"}`))
                                    )
                                )
                                .child(
                                  v_flex()
                                    .flex_1()
                                    .min_w(0)
                                    .gap(1)
                                    .child(div().text_size(12.2).truncate().child(item.text))
                                    .when(Boolean(item.note?.trim()), (el) =>
                                      el.child(
                                        div()
                                          .text_size(10.5)
                                          .text_color(t.dim)
                                          .truncate()
                                          .child(item.note.trim().split("\n")[0])
                                      )
                                    )
                                );
                            })
                          )
                      )
                  )
              )
              // Right Side Column (flex_grow 1): Apps + Global Runbook + General Notes + Spaces
              .child(
                v_flex()
                  .flex_grow(1)
                  .min_w(0)
                  .gap(16)
                  // Cockpit-style Apps Quick-Nav Card
                  .child(
                    v_flex()
                      .w_full()
                      .rounded(10)
                      .border_1()
                      .border_color(t.border)
                      .bg(t.background)
                      .child(cardHeader(tr("dash.apps_section"), null, null))
                      .child(
                        v_flex()
                          .p(6)
                          .gap(2)
                          .child(
                            appRow(
                              "dash-app-todos",
                              ICON.todos,
                              tr("act.todos"),
                              tr("dash.open_count", { count: globalTodos.length }),
                              globalTodos.length > 0 ? t.accent : t.dim,
                              () => this.openGeneralPage("todos-page")
                            )
                          )
                          .child(
                            appRow(
                              "dash-app-runbook",
                              ICON.play,
                              tr("act.runbook"),
                              tr("dash.saved_count", { count: globalRunbook.length }),
                              t.dim,
                              () => this.openGeneralPage("runbook-page")
                            )
                          )
                          .child(
                            appRow(
                              "dash-app-notes",
                              ICON.notes,
                              tr("act.notes"),
                              `${(this.notesEditor.value() ?? "").length} ch`,
                              t.dim,
                              () => this.openGeneralPage("notes-page")
                            )
                          )
                          .child(
                            (() => {
                              const rts = Array.isArray(shared("james-routines.data"))
                                ? shared("james-routines.data")
                                : [];
                              const failed = rts.filter((r) => r.enabled && r.lastStatus === "error").length;
                              const active = rts.filter((r) => r.enabled).length;
                              return appRow(
                                "dash-app-routines",
                                ICON.clock,
                                tr("routines.title"),
                                failed > 0
                                  ? `${failed} ${tr("routines.status_error").toLowerCase()}`
                                  : tr("routines.active_count", { count: active }),
                                failed > 0 ? "#f14c4c" : active > 0 ? t.accent : t.dim,
                                () => this.openGeneralPage("routines-page")
                              );
                            })()
                          )
                          .child(
                            (() => {
                              const gh = shared("james-github.cache") ?? {};
                              const mine = Array.isArray(gh.mine) ? gh.mine : [];
                              const revs = Array.isArray(gh.reviews) ? gh.reviews : [];
                              const repoCi = Array.isArray(gh.repoCi) ? gh.repoCi : [];
                              const failing = [...mine, ...revs, ...repoCi].filter(
                                (p) => (p.ciState ?? p.state) === "FAILURE" || (p.ciState ?? p.state) === "ERROR"
                              ).length;
                              const total = mine.length + revs.length;
                              return appRow(
                                "dash-app-github",
                                ICON.github,
                                tr("gh.title"),
                                failing > 0
                                  ? `${failing} ${tr("gh.ci_fail").toLowerCase()}`
                                  : revs.length > 0
                                    ? `${revs.length} ${tr("gh.reviews_short")}`
                                    : total > 0
                                      ? tr("dash.open_count", { count: total })
                                      : "→",
                                failing > 0 ? "#f14c4c" : revs.length > 0 ? t.accent : t.dim,
                                () => this.openGeneralPage("github-page")
                              );
                            })()
                          )
                          .child(
                            appRow(
                              "dash-app-settings",
                              ICON.sliders,
                              tr("set.title"),
                              "→",
                              t.dim,
                              () =>
                                openOverlay({
                                  mod: "james-settings",
                                  kind: "dialog",
                                  width: 600,
                                  height: 500,
                                })
                            )
                          )
                      )
                  )
                  // Global Runbook Quick-Run Card
                  .when(globalRunbook.length > 0, (col) =>
                    col.child(
                      v_flex()
                        .w_full()
                        .rounded(10)
                        .border_1()
                        .border_color(t.border)
                        .bg(t.background)
                        .child(
                          cardHeader(tr("dash.runbook_section"), tr("dash.open_all"), () =>
                            this.openGeneralPage("runbook-page")
                          )
                        )
                        .child(
                          div()
                            .p(10)
                            .child(
                              h_flex()
                                .gap(6)
                                .flex_wrap()
                                .children(
                                  globalRunbook.map((cmd) => {
                                    const btn = h_flex()
                                      .id(`dash-rb-${cmd.id}`)
                                      .h(28)
                                      .px(10)
                                      .gap(6)
                                      .rounded(7)
                                      .items_center()
                                      .cursor_pointer()
                                      .border_1()
                                      .border_color(t.border)
                                      .bg(t.raised)
                                      .text_size(11.5)
                                      .text_color(t.foreground)
                                      .hover((s) => s.bg(t.hover))
                                      .on_mouse_down("left", (_ev, cx) => {
                                        cx.stop_propagation();
                                        tipState.id = null;
                                        this.runGlobalCommand(cmd);
                                      })
                                      .child(svg(ICON.play).size(10).text_color(t.accent))
                                      .child(div().child(cmd.name));
                                    return tipAbove(
                                      `dash-rb-tip-${cmd.id}`,
                                      cmd.cmd,
                                      btn,
                                      t,
                                      "bottom_center"
                                    );
                                  })
                                )
                            )
                        )
                    )
                  )
                  // General Notes Card
                  .child(
                    v_flex()
                      .w_full()
                      .rounded(10)
                      .border_1()
                      .border_color(t.border)
                      .bg(t.background)
                      .child(
                        cardHeader(tr("dash.notes_section"), tr("dash.open_all"), () =>
                          this.openGeneralPage("notes-page")
                        )
                      )
                      .child(
                        div()
                          .w_full()
                          .h(160)
                          .p(6)
                          .child(Editor.new(this.notesEditor).size_full())
                      )
                  )
                  // Spaces Card
                  .child(
                    v_flex()
                      .w_full()
                      .rounded(10)
                      .border_1()
                      .border_color(t.border)
                      .bg(t.background)
                      .child(cardHeader(tr("dash.spaces_section"), null, null))
                      .child(
                        v_flex()
                          .p(8)
                          .gap(5)
                          .children(
                            allSpaces.map((sp) => {
                              const mObj = allMachines.find((m) => m.name === sp.machine);
                              const ready = !sp.machine || mObj?.layout === "ready";
                              return h_flex()
                                .id(`dash-sp-${sp.id}`)
                                .px(8)
                                .py(6)
                                .gap(8)
                                .rounded(7)
                                .items_center()
                                .cursor_pointer()
                                .bg(sp.active ? t.selected : t.raised)
                                .border_1()
                                .border_color(sp.active ? t.accent : t.border)
                                .hover((s) => s.bg(t.hover))
                                .on_mouse_down("left", (_ev, cx) => {
                                  cx.stop_propagation();
                                  run("layout.select", { stack: "center-stage", child: "work" });
                                  run("space.select", { id: sp.id });
                                })
                                .child(
                                  svg(sp.machine ? ICON.server : ICON.monitor)
                                    .size(13)
                                    .flex_none()
                                    .text_color(ready ? t.muted : t.dim)
                                )
                                .child(
                                  div()
                                    .flex_1()
                                    .min_w(0)
                                    .truncate()
                                    .text_size(12)
                                    .font_weight(sp.active ? 600 : 400)
                                    .child(sp.name)
                                )
                                .when(Boolean(sp.branch), (el) =>
                                  el.child(
                                    h_flex()
                                      .gap(4)
                                      .items_center()
                                      .text_size(10.5)
                                      .text_color(t.dim)
                                      .child(svg(ICON.branch).size(10).text_color(t.dim))
                                      .child(div().child(sp.branch))
                                  )
                                );
                            })
                          )
                      )
                  )
              )
          )
      );
  }
}
