// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, shared, setShared } from "herdr";
import { tr } from "./i18n.js";

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() {
    this.hovered = false;
    this.dragCandidate = null;
    this.dragging = false;
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  detachToTab(terminal, cx) {
    if (!terminal) return;
    run("terminal.park", { terminal });
    let attempts = 0;
    const attach = (timerCx) => {
      attempts++;
      const stillOpen = panes().some((x) => x.terminal === terminal);
      if (stillOpen && attempts < 30) {
        timerCx.timer.after(40, attach);
        return;
      }
      run("terminal.keep", { terminal, place: "tab" });
    };
    cx.timer.after(40, attach);
  }

  button(t, id, iconPath, tip, fn) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        fn(cx);
      })
      .child(svg(iconPath).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const siblings = panes().filter((x) => x.tab === p.tab);
    const canDetach = siblings.length > 1 && Boolean(p.terminal);
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(this.dragging, (el) => el.cursor_grabbing().border_color(t.accent))
      .when(bottom, (el) => el.border_t(1).rounded_b(9))
      .when(!bottom, (el) => el.border_b(1).rounded_t(9))
      .when(!this.dragging, (el) => el.border_color(t.border))
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_mouse_down("left", (e, cx) => {
        run("pane.focus", { pane });
        if (!canDetach) return;
        this.dragCandidate = {
          pane,
          terminal: p.terminal,
          tab: p.tab,
          name,
          startX: e.position?.x ?? 0,
          startY: e.position?.y ?? 0,
        };
        this.dragging = false;
      })
      .on_window_mouse_move((e, cx) => {
        if (!this.dragCandidate) return;
        const dx = Math.abs((e.position?.x ?? 0) - this.dragCandidate.startX);
        const dy = Math.abs((e.position?.y ?? 0) - this.dragCandidate.startY);
        if (!this.dragging && (dx > 6 || dy > 6)) {
          this.dragging = true;
          setShared("james.dragPane", {
            pane: this.dragCandidate.pane,
            terminal: this.dragCandidate.terminal,
            tab: this.dragCandidate.tab,
            name: this.dragCandidate.name,
            at: Date.now(),
          });
          cx.notify();
        }
      })
      .on_window_mouse_up("left", (_e, cx) => {
        if (!this.dragCandidate && !this.dragging) return;
        const wasDragging = this.dragging;
        this.dragCandidate = null;
        this.dragging = false;
        if (wasDragging) {
          cx.timer.after(60, () => {
            if (shared("james.dragPane")?.pane === pane) {
              setShared("james.dragPane", null);
            }
          });
        }
        cx.notify();
      })
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child(tr("pane.needs_you"))))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered && !this.dragging, el => el
        .when(canDetach, (d) =>
          d.child(this.button(t, `ph-detach-${pane}`, "mods/james-pane/detach.svg", tr("pane.detach_tab"), (cx) => this.detachToTab(p.terminal, cx)))
        )
        .child(this.button(t, `ph-r-${pane}`, "mods/pane/split-right.svg", "Split right", () => run("pane.split", { direction: "right", pane })))
        .child(this.button(t, `ph-d-${pane}`, "mods/pane/split-down.svg", "Split down", () => run("pane.split", { direction: "down", pane })))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "mods/pane/unzoom.svg" : "mods/pane/zoom.svg", p.zoomed ? "Unzoom" : "Zoom", () => run("pane.zoom", { pane })))
        .child(this.button(t, `ph-x-${pane}`, "mods/pane/close.svg", "Close", () => run("pane.close", { pane }))));
  }
}
