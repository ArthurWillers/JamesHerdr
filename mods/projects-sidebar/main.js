import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import {
  spaces,
  machines,
  panes,
  agents,
  focused,
  run,
  theme,
  layout,
  setAgentOrder,
  openOverlay,
} from "herdr";

const ICON = {
  space: "mods/workspace-chrome/layers.svg",
  monitor: "mods/workspace-chrome/monitor.svg",
  server: "mods/workspace-chrome/server.svg",
  chevronDown: "mods/workspace-chrome/chevron-down.svg",
  chevronRight: "mods/workspace-chrome/chevron-right.svg",
  plus: "mods/workspace-chrome/plus.svg",
  terminal: "mods/workspace-chrome/terminal.svg",
  close: "mods/workspace-chrome/x.svg",
};

const clean = (s) =>
  (s ?? "")
    .replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "")
    .replace(/^\[ [!.] \] /, "")
    .trim();

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    if (
      !current ||
      (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))
    ) {
      leads.set(p.tab, p);
    }
  }
  return leads;
}

function tabTitle(tab, lead) {
  const prog = lead?.program?.name;
  const live = clean(lead?.title);
  const isPath = /^[~/]|^[A-Za-z]:\\/.test(
    (lead?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "")
  );
  const telling =
    live &&
    live !== (lead?.terminal ?? lead?.address) &&
    live !== prog &&
    !isPath &&
    !live.includes("@") &&
    live.toLowerCase() !== lead?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : !tab.named && prog ? prog : tab.name;
}

function spaceStatus(space, agentsByTab) {
  const rank = { blocked: 4, done: 3, working: 2, idle: 1 };
  let best = null;
  for (const tab of space.tabs ?? []) {
    const a = agentsByTab.get(tab.id);
    if (a && (!best || (rank[a.status] ?? 0) > (rank[best] ?? 0))) {
      best = a.status;
    }
  }
  return best;
}

function statusColor(t, status) {
  if (status === "blocked") return t.blocked ?? t.accent;
  if (status === "done") return t.done ?? t.accent;
  if (status === "working") return t.working ?? t.accent;
  return t.muted;
}

function progIcon(p, size, color) {
  if (!p?.icon) return svg(ICON.terminal).size(size).flex_none().text_color(color);
  return p.tint
    ? svg(p.icon).size(size).flex_none().text_color(color)
    : image(p.icon).w(size).h(size).flex_none();
}

export default class ProjectsSidebar extends View {
  init() {
    this.scroll = ScrollHandle.new();
    this.collapsed = new Set();
    this.foldedMachines = new Set();
  }

  toggleSpace(id, cx) {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    cx.notify();
  }

  toggleMachine(m, cx) {
    if (this.foldedMachines.has(m)) this.foldedMachines.delete(m);
    else this.foldedMachines.add(m);
    cx.notify();
  }

  render() {
    const t = theme();
    const sp = spaces();
    const ps = panes();
    const ag = agents();
    const foc = focused();
    const rail = narrow();

    const leads = leadPanes(ps);
    const agentsByTab = new Map();
    for (const a of ag) {
      const pane = ps.find((p) => p.terminal === a.address);
      if (pane && !agentsByTab.has(pane.tab)) agentsByTab.set(pane.tab, a);
    }

    setAgentOrder(ag.map((a) => a.address));

    if (rail) {
      return v_flex()
        .id("projects-rail")
        .size_full()
        .py(8)
        .gap(6)
        .items_center()
        .overflow_y_scroll()
        .track_scroll(this.scroll)
        .children(
          sp.map((s) => {
            const active = foc?.space === s.id;
            const st = spaceStatus(s, agentsByTab);
            return h_flex()
              .id(`rail-space-${s.id}`)
              .w(32)
              .h(32)
              .rounded(7)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .when(active, (e) => e.bg(t.surface))
              .hover((e) => e.bg(t.hover))
              .on_click(() => run("space.select", { id: s.id }))
              .child(
                svg(ICON.space)
                  .size(16)
                  .text_color(st && st !== "idle" ? statusColor(t, st) : active ? t.foreground : t.muted)
              );
          })
        );
    }

    const header = h_flex()
      .id("projects-header")
      .h(28)
      .px(10)
      .items_center()
      .justify_between()
      .child(
        div()
          .text_size(12)
          .font_weight(500)
          .text_color(t.muted)
          .child("Spaces")
      )
      .child(
        h_flex()
          .id("projects-new-space")
          .w(22)
          .h(22)
          .rounded(5)
          .items_center()
          .justify_center()
          .cursor_pointer()
          .hover((e) => e.bg(t.hover))
          .on_click(() => run("space.new"))
          .child(svg(ICON.plus).size(14).text_color(t.muted))
      );

    const rows = [];
    const pushSpace = (s) => {
      const isCollapsed = this.collapsed.has(s.id);
      const isCurrentSpace = foc?.space === s.id;
      const st = spaceStatus(s, agentsByTab);
      const tabs = (s.tabs ?? []).filter((tab) => !tab.settled);

      rows.push(
        h_flex()
          .id(`project-${s.id}`)
          .h(28)
          .px(8)
          .gap(6)
          .rounded(7)
          .items_center()
          .cursor_pointer()
          .when(isCurrentSpace && isCollapsed, (e) => e.bg(t.surface))
          .hover((e) => e.bg(t.hover))
          .on_mouse_down("right", () =>
            openOverlay({
              mod: "menu",
              kind: "popup",
              width: 200,
              height: 260,
              props: { tab: "space", target: { id: s.id } },
            })
          )
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            this.toggleSpace(s.id, cx);
          })
          .child(
            svg(isCollapsed ? ICON.chevronRight : ICON.chevronDown)
              .size(12)
              .flex_none()
              .text_color(t.muted)
          )
          .child(
            svg(ICON.space)
              .size(14)
              .flex_none()
              .text_color(isCurrentSpace ? t.foreground : t.muted)
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(13)
              .font_weight(isCurrentSpace ? 500 : 400)
              .text_color(isCurrentSpace ? t.foreground : t.foreground)
              .child(s.name)
          )
          .when(st && st !== "idle", (e) =>
            e.child(
              div()
                .w(6)
                .h(6)
                .rounded_full()
                .flex_none()
                .bg(statusColor(t, st))
            )
          )
          .child(
            h_flex()
              .id(`project-new-tab-${s.id}`)
              .w(20)
              .h(20)
              .rounded(4)
              .items_center()
              .justify_center()
              .opacity(0.45)
              .hover((e) => e.opacity(1).bg(t.surface))
              .on_mouse_down("left", (_ev, cx) => {
                cx.stop_propagation();
                if (!isCurrentSpace) run("space.select", { id: s.id });
                openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 });
              })
              .child(svg(ICON.plus).size(12).text_color(t.muted))
          )
      );

      if (!isCollapsed) {
        if (tabs.length === 0) {
          rows.push(
            div()
              .id(`project-empty-${s.id}`)
              .pl(32)
              .pr(8)
              .h(24)
              .flex()
              .items_center()
              .text_size(12)
              .text_color(t.muted)
              .child("No chats")
          );
        } else {
          for (const tab of tabs) {
            const lead = leads.get(tab.id);
            const agInfo = agentsByTab.get(tab.id);
            const activeTab = isCurrentSpace && foc?.tab === tab.id;
            const label = tabTitle(tab, lead);

            rows.push(
              h_flex()
                .id(`project-tab-${tab.id}`)
                .h(26)
                .pl(26)
                .pr(6)
                .gap(7)
                .rounded(6)
                .items_center()
                .cursor_pointer()
                .when(activeTab, (e) => e.bg(t.surface))
                .hover((e) => e.bg(t.hover))
                .on_mouse_down("right", (_ev, e) => {
                  e.stop_propagation();
                  openOverlay({
                    mod: "menu",
                    kind: "popup",
                    width: 200,
                    props: { tab: "tab", target: { id: tab.id, space: s.id } },
                  });
                })
                .on_click(() => {
                  if (!isCurrentSpace) run("space.select", { id: s.id });
                  run("tab.select", { id: tab.id });
                })
                .child(
                  progIcon(
                    lead?.program,
                    14,
                    activeTab ? t.foreground : t.muted
                  )
                )
                .when(agInfo?.status === "working", (e) =>
                  e.child(
                    svg("mods/workspace-chrome/spinner.svg")
                      .size(12)
                      .flex_none()
                      .text_color(t.working)
                      .spin(900)
                  )
                )
                .when(agInfo?.status === "blocked" || agInfo?.status === "done", (e) =>
                  e.child(
                    div()
                      .w(6)
                      .h(6)
                      .rounded_full()
                      .flex_none()
                      .bg(statusColor(t, agInfo.status))
                  )
                )
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(12.5)
                    .text_color(activeTab ? t.foreground : t.muted)
                    .child(label)
                )
                .child(
                  h_flex()
                    .id(`project-tab-close-${tab.id}`)
                    .w(18)
                    .h(18)
                    .rounded(4)
                    .items_center()
                    .justify_center()
                    .opacity(0.35)
                    .hover((e) => e.opacity(1).bg(t.surface))
                    .on_mouse_down("left", (_ev, e) => e.stop_propagation())
                    .on_click((_ev, e) => {
                      e.stop_propagation();
                      run("tab.close", { id: tab.id });
                    })
                    .child(svg(ICON.close).size(11).text_color(t.muted))
                )
            );
          }
        }
      }
    };

    const machineList = machines().filter((m) => !m.temporary);
    const remoteNames = [...new Set([
      ...machineList.map((m) => m.name).filter(Boolean),
      ...sp.map((s) => s.machine).filter(Boolean),
    ])].sort();

    if (remoteNames.length === 0) {
      for (const s of sp) pushSpace(s);
    } else {
      for (const m of [null, ...remoteNames]) {
        const mine = sp.filter((s) => (s.machine ?? null) === m);
        const info = machineList.find((k) => k.name === m);
        const connected = !m || info?.state === "connected";
        const folded = this.foldedMachines.has(m);

        rows.push(
          h_flex()
            .id(`machine-head-${m ?? "local"}`)
            .h(26)
            .px(8)
            .gap(7)
            .items_center()
            .rounded(6)
            .text_size(11)
            .text_color(t.dim ?? t.muted)
            .cursor_pointer()
            .hover((e) => e.bg(t.hover))
            .on_mouse_down("left", (_ev, cx) => {
              cx.stop_propagation();
              this.toggleMachine(m, cx);
            })
            .child(svg(m ? ICON.server : ICON.monitor).size(13).flex_none())
            .child(div().flex_1().min_w(0).truncate().child(m ?? "This computer"))
            .when(connected, (e) =>
              e.child(
                h_flex()
                  .id(`machine-add-${m ?? "local"}`)
                  .px(4)
                  .rounded(4)
                  .hover((s) => s.bg(t.surface).text_color(t.foreground))
                  .on_mouse_down("left", (_ev, cx) => {
                    cx.stop_propagation();
                    run("space.new", { machine: m ?? "" });
                  })
                  .child("+")
              )
            )
            .child(div().size(6).rounded(3).flex_none().bg(connected ? (t.ansi2 ?? t.accent) : (t.dim ?? t.muted)))
            .child(svg(folded ? ICON.chevronRight : ICON.chevronDown).size(11).flex_none())
        );

        if (!folded) {
          if (mine.length === 0) {
            rows.push(
              h_flex()
                .id(`machine-empty-${m ?? "local"}`)
                .h(26)
                .px(8)
                .gap(7)
                .items_center()
                .rounded(7)
                .text_size(12)
                .text_color(t.dim ?? t.muted)
                .cursor_pointer()
                .hover((e) => e.bg(t.hover).text_color(t.foreground))
                .on_mouse_down("left", (_ev, cx) => {
                  cx.stop_propagation();
                  run("space.new", { machine: m ?? "" });
                })
                .child(svg(ICON.plus).size(12))
                .child("New space there")
            );
          } else {
            for (const s of mine) pushSpace(s);
          }
        }
      }
    }

    return v_flex()
      .id("projects-sidebar")
      .size_full()
      .min_h(0)
      .px(6)
      .py(6)
      .gap(4)
      .child(header)
      .child(
        v_flex()
          .id("projects-list")
          .flex_1()
          .min_h(0)
          .gap(2)
          .overflow_y_scroll()
          .track_scroll(this.scroll)
          .children(rows)
      );
  }
}
