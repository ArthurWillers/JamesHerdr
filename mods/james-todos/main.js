// To-do list mod with per-Space and General scopes + 1-click launch with Default Agent.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Popup } from "gpui-base";
import { spaces, panes, focused, run, openOverlay, theme, shared, setShared } from "herdr";
import { tr } from "./i18n.js";

const ICON = {
  check: "mods/james-chrome/check.svg",
  plus: "mods/james-chrome/plus.svg",
  close: "mods/james-chrome/x.svg",
  sparkles: "mods/source-control/icons/sparkles.svg",
};

const STORE_KEY = "james-todos.data";
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
  const folder = pane?.cwd || f?.cwd || space?.folder || "";
  const scopeId = folder || space?.id || GLOBAL_KEY;
  const label = space?.name || folder.split(/[\\/]/).pop() || "Space";
  return { space, scopeId, label };
}

export default class JamesTodos extends View {
  init(_props, cx) {
    this.tab = "space"; // "space" | "general"
    this.filter = "all"; // "all" | "pending" | "done"
    this.input = InputState.new({ placeholder: tr("todos.placeholder") });
    this.input.on("submit", (_ev, cx) => {
      this.addTodo(cx);
    });
  }

  getData() {
    const raw = shared(STORE_KEY);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }

  saveList(bucketKey, list) {
    const all = { ...this.getData(), [bucketKey]: list };
    setShared(STORE_KEY, all);
  }

  currentBucket() {
    if (this.tab === "general") return GLOBAL_KEY;
    return activeSpaceInfo().scopeId;
  }

  addTodo(cx) {
    const text = (this.input.value() ?? "").trim();
    if (!text) return;
    const bucket = this.currentBucket();
    const list = [...(this.getData()[bucket] ?? [])];
    list.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      done: false,
    });
    this.saveList(bucket, list);
    this.input.set_value("");
    cx.notify();
  }

  toggleTodo(id, cx) {
    const bucket = this.currentBucket();
    const list = (this.getData()[bucket] ?? []).map((item) =>
      item.id === id ? { ...item, done: !item.done } : item
    );
    this.saveList(bucket, list);
    cx.notify();
  }

  deleteTodo(id, cx) {
    const bucket = this.currentBucket();
    const list = (this.getData()[bucket] ?? []).filter((item) => item.id !== id);
    this.saveList(bucket, list);
    cx.notify();
  }

  clearCompleted(cx) {
    const bucket = this.currentBucket();
    const list = (this.getData()[bucket] ?? []).filter((item) => !item.done);
    this.saveList(bucket, list);
    cx.notify();
  }

  sendToAgent(todo) {
    const def = shared("james.defaultAgent");
    const { space } = activeSpaceInfo();
    if (def?.run) {
      run("tab.new", {
        name: todo.text.slice(0, 28),
        space: space?.id,
        argv: def.run,
        task: todo.text,
      });
    } else {
      openOverlay({
        mod: "james-settings",
        kind: "dialog",
        width: 600,
        height: 500,
        props: { section: "default-agent" },
      });
    }
  }

  render() {
    const t = theme();
    const info = activeSpaceInfo();
    const data = this.getData();
    const spaceList = data[info.scopeId] ?? [];
    const generalList = data[GLOBAL_KEY] ?? [];
    const spacePending = spaceList.filter((x) => !x.done).length;
    const generalPending = generalList.filter((x) => !x.done).length;

    const currentList = this.tab === "general" ? generalList : spaceList;
    const doneCount = currentList.filter((x) => x.done).length;
    const shown = currentList.filter((x) =>
      this.filter === "pending" ? !x.done : this.filter === "done" ? x.done : true
    );

    const tabBtn = (id, label, count) => {
      const active = this.tab === id;
      return h_flex()
        .id(`todos-tab-${id}`)
        .flex_1()
        .h(28)
        .px(8)
        .gap(6)
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
        .child(div().truncate().child(label))
        .when(count > 0, (el) =>
          el.child(
            div()
              .px(5)
              .py(1)
              .rounded(8)
              .bg(active ? t.accent + "33" : t.canvas ?? t.background)
              .text_size(10)
              .text_color(active ? t.foreground : t.dim)
              .child(String(count))
          )
        );
    };

    const filterBtn = (id, label) => {
      const active = this.filter === id;
      return div()
        .id(`todos-filter-${id}`)
        .px(7)
        .py(2)
        .rounded(5)
        .cursor_pointer()
        .text_size(11)
        .bg(active ? t.selected : t.background)
        .text_color(active ? t.foreground : t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_ev, cx) => {
          cx.stop_propagation();
          this.filter = id;
          cx.notify();
        })
        .child(label);
    };

    return v_flex()
      .id("james-todos")
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
          .px(14)
          .gap(8)
          .items_center()
          .rounded_t(9)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome ?? t.background)
          .child(div().font_semibold().child(tr("todos.title")))
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
      )
      // Scope Tabs (Space / General)
      .child(
        h_flex()
          .px(10)
          .pt(10)
          .pb(6)
          .gap(6)
          .child(tabBtn("space", tr("todos.space"), spacePending))
          .child(tabBtn("general", tr("todos.general"), generalPending))
      )
      // Quick Add Input
      .child(
        h_flex()
          .px(10)
          .pb(8)
          .gap(6)
          .items_center()
          .child(
            Input.new(this.input)
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
            h_flex()
              .id("todos-add-btn")
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
                this.addTodo(cx);
              })
              .child(svg(ICON.plus).size(14).text_color(t.foreground))
          )
      )
      // Filter Bar
      .child(
        h_flex()
          .px(10)
          .pb(6)
          .gap(4)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(filterBtn("all", tr("todos.filter_all")))
          .child(filterBtn("pending", tr("todos.filter_pending")))
          .child(filterBtn("done", tr("todos.filter_done")))
          .child(div().flex_1())
          .when(doneCount > 0, (el) =>
            el.child(
              div()
                .id("todos-clear-done")
                .px(6)
                .py(2)
                .rounded(5)
                .cursor_pointer()
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_mouse_down("left", (_ev, cx) => {
                  cx.stop_propagation();
                  this.clearCompleted(cx);
                })
                .child(tr("todos.clear_done"))
            )
          )
      )
      // Todo List
      .child(
        v_flex()
          .id("todos-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(8)
          .gap(4)
          .when(shown.length === 0, (el) =>
            el.child(
              div()
                .p(12)
                .text_size(12)
                .text_color(t.dim)
                .child(tr("todos.empty"))
            )
          )
          .children(
            shown.map((item) => {
              const agentBtn = h_flex()
                .id(`todo-agent-${item.id}`)
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
                  this.sendToAgent(item);
                })
                .child(svg(ICON.sparkles).size(12).text_color(t.accent));

              const delBtn = h_flex()
                .id(`todo-del-${item.id}`)
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
                  this.deleteTodo(item.id, cx);
                })
                .child(svg(ICON.close).size(11).text_color(t.dim));

              return h_flex()
                .id(`todo-row-${item.id}`)
                .w_full()
                .min_h(32)
                .px(8)
                .py(5)
                .gap(8)
                .rounded(7)
                .items_center()
                .bg(t.raised)
                .border_1()
                .border_color(t.border)
                .hover((s) => s.bg(t.hover))
                .child(
                  h_flex()
                    .id(`todo-chk-${item.id}`)
                    .w(16)
                    .h(16)
                    .rounded(4)
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .border_1()
                    .border_color(item.done ? t.accent : t.muted)
                    .bg(item.done ? t.accent : t.canvas ?? t.background)
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.toggleTodo(item.id, cx);
                    })
                    .when(item.done, (c) =>
                      c.child(
                        svg(ICON.check)
                          .size(11)
                          .text_color(t.accent_foreground ?? t.background)
                      )
                    )
                )
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .text_size(12.2)
                    .text_color(item.done ? t.dim : t.foreground)
                    .cursor_pointer()
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.toggleTodo(item.id, cx);
                    })
                    .child(item.text)
                )
                .when(!item.done, (row) =>
                  row.child(
                    tipAbove(
                      `todo-ag-${item.id}`,
                      tr("todos.run_agent"),
                      agentBtn,
                      t,
                      "bottom_right"
                    )
                  )
                )
                .child(
                  tipAbove(
                    `todo-rm-${item.id}`,
                    tr("todos.delete"),
                    delBtn,
                    t,
                    "bottom_right"
                  )
                );
            })
          )
      );
  }
}
