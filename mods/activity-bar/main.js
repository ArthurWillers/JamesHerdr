import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Popup } from "gpui-base";
import { layout, run, theme } from "herdr";
import { tr } from "./i18n.js";

const ITEMS = [
  {
    id: "files",
    labelKey: "act.files",
    icon: "mods/activity-bar/icons/folder.svg",
  },
  {
    id: "source-control",
    labelKey: "act.source_control",
    icon: "mods/source-control/icons/source-control.svg",
  },
  {
    id: "todos",
    labelKey: "act.todos",
    icon: "mods/activity-bar/icons/todos.svg",
  },
  {
    id: "runbook",
    labelKey: "act.runbook",
    icon: "mods/activity-bar/icons/runbook.svg",
  },
  {
    id: "notes",
    labelKey: "act.notes",
    icon: "mods/activity-bar/icons/notes.svg",
  },
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class ActivityBar extends View {
  init() {
    this.hoveredTip = null;
  }

  render() {
    const t = theme();
    const root = layout();
    const panel = find(root, "panel");
    const body = find(root, "panel-body");
    const activeId = panel && !panel.hidden ? body?.active : null;

    return v_flex()
      .id("activity-bar")
      .size_full()
      .p(4)
      .gap(4)
      .items_center()
      .rounded(10)
      .bg(t.chrome ?? t.background)
      .border_1()
      .border_color(t.border)
      .children(
        ITEMS.map((item) => {
          const on = activeId === item.id;
          const btn = h_flex()
            .id(`activity-${item.id}`)
            .w(30)
            .h(30)
            .rounded(6)
            .relative()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .when(on, (e) => e.bg(t.selected))
            .hover((s) => s.bg(on ? t.selected : t.hover))
            .on_hover((hovered, cx) => {
              const next = hovered ? item.id : (this.hoveredTip === item.id ? null : this.hoveredTip);
              if (next !== this.hoveredTip) {
                this.hoveredTip = next;
                cx.notify();
              }
            })
            .on_mouse_down("left", (_ev, cx) => {
              cx.stop_propagation();
              this.hoveredTip = null;
              if (on) {
                run("layout.hide", { id: "panel" });
              } else {
                run("layout.select", { stack: "panel-body", child: item.id });
                run("layout.show", { id: "panel" });
              }
            })
            .when(on, (e) =>
              e.child(
                div()
                  .absolute()
                  .left(-4)
                  .w(2)
                  .h(16)
                  .rounded(1)
                  .bg(t.accent)
              )
            )
            .child(
              svg(item.icon)
                .size(16)
                .text_color(on ? t.foreground : t.muted)
            );

          return Popup.new(`tip-act-${item.id}`, btn)
            .anchor("bottom_right")
            .when(this.hoveredTip === item.id, (el) =>
              el.content(
                div()
                  .px(8)
                  .py(4)
                  .mb(6)
                  .rounded(6)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.popover ?? t.surface)
                  .text_size(11.5)
                  .text_color(t.foreground)
                  .child(tr(item.labelKey))
              )
            );
        })
      );
  }
}
