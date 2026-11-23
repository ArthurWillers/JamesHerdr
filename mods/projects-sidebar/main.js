import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, Popup } from "gpui-base";
import { tr } from "./i18n.js";
import {
  spaces,
  machines,
  panes,
  agents,
  focused,
  run,
  exec,
  notify,
  theme,
  layout,
  setAgentOrder,
  openOverlay,
  shared,
  setShared,
  checking,
  home,
  settings,
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

function computeNextRoutineRun(routine, fromMs = Date.now()) {
  if (!routine.enabled) return null;
  if (routine.scheduleType === "daily") {
    const m = /^(\d{1,2}):(\d{2})$/.exec((routine.dailyTime || "09:00").trim());
    const hh = m ? Math.min(23, Math.max(0, Number(m[1]))) : 9;
    const mm = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0;
    const d = new Date(fromMs);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= fromMs + 1000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const mins = Math.max(1, Number(routine.intervalMinutes) || 30);
  return fromMs + mins * 60 * 1000;
}

export default class ProjectsSidebar extends View {
  init(_props, cx) {
    this.scroll = ScrollHandle.new();
    this.collapsed = new Set();
    this.foldedMachines = new Set();
    this.runningRoutines = new Set();
    this.dragTab = null;
    this.draggingTab = false;
    this.dragStart = null;
    this.dragPos = null;
    this.dragOverTab = null;
    if (!checking()) {
      cx.timer.every(15000, (timerCx) => this.tickRoutines(timerCx));
    }
  }

  tickRoutines(cx) {
    const raw = shared("james-routines.data");
    if (!Array.isArray(raw) || raw.length === 0) return;
    const now = Date.now();
    const due = raw.filter(
      (r) =>
        r.enabled &&
        r.engine !== "os" &&
        r.nextRunAt &&
        now >= r.nextRunAt &&
        !this.runningRoutines.has(r.id)
    );
    if (due.length === 0) return;

    const allSpaces = spaces();
    let updated = raw.map((r) => {
      if (!due.some((d) => d.id === r.id)) return r;
      return { ...r, nextRunAt: computeNextRoutineRun(r, now) };
    });
    setShared("james-routines.data", updated);

    const patchRoutine = (id, patch) => {
      const cur = shared("james-routines.data");
      if (!Array.isArray(cur)) return;
      setShared(
        "james-routines.data",
        cur.map((x) => (x.id === id ? { ...x, ...patch } : x))
      );
    };

    for (const r of due) {
      const sp = r.spaceId ? allSpaces.find((s) => s.id === r.spaceId) : null;
      const folder = sp?.folder || undefined;

      if (r.mode === "terminal") {
        run("tab.new", {
          name: r.name,
          space: sp?.id,
          folder,
          argv: [
            "sh",
            "-c",
            'S="${SHELL:-bash}"; exec "$S" -ic \'eval "$1"; echo ""; exec "${SHELL:-bash}"\' _ "$1"',
            "_",
            r.cmd,
          ],
        });
        patchRoutine(r.id, {
          lastRunAt: now,
          lastStatus: "ok",
          runCount: (r.runCount || 0) + 1,
        });
      } else if (r.mode === "agent") {
        const def = shared("james.defaultAgent");
        const argv = r.agentRun ?? def?.run;
        if (argv) {
          run("tab.new", {
            name: r.name.slice(0, 28),
            space: sp?.id,
            folder,
            argv,
            task: r.cmd,
          });
          patchRoutine(r.id, {
            lastRunAt: now,
            lastStatus: "ok",
            runCount: (r.runCount || 0) + 1,
          });
        }
      } else {
        this.runningRoutines.add(r.id);
        cx.spawn(async (spawnCx) => {
          let status = "ok";
          let output = "";
          try {
            const opts = {};
            if (folder) opts.cwd = folder;
            if (r.machine) opts.on = r.machine;
            const res = await exec("sh", ["-c", r.cmd], Object.keys(opts).length ? opts : undefined);
            output = [res?.stdout, res?.stderr].filter(Boolean).join("\n").trim().slice(-1200);
            if (res && typeof res.code === "number" && res.code !== 0) status = "error";
          } catch (err) {
            status = "error";
            output = String(err?.message || err || "Failed").slice(-1200);
          } finally {
            this.runningRoutines.delete(r.id);
            patchRoutine(r.id, {
              lastRunAt: Date.now(),
              lastStatus: status,
              lastOutput: output,
              runCount: (r.runCount || 0) + 1,
            });
            if (status === "error") {
              notify({
                title: `${tr("routines.title")}: ${r.name}`,
                body: output.split("\n")[0] || tr("routines.status_error"),
              });
            }
            spawnCx.notify();
          }
        });
      }
    }
  }

  mergeTabs(fromTabId, toTabId, spaceId, cx) {
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
      run("layout.select", { stack: "center-stage", child: "work" });
      if (spaceId) run("space.select", { id: spaceId });
      run("tab.select", { id: toTabId });
      timerCx.timer.after(40, () => {
        for (const term of fromTerms) {
          run("terminal.keep", { terminal: term, place: "right" });
        }
      });
    };
    cx.timer.after(40, attach);
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
    const findNode = (node, id) => {
      if (node?.id === id) return node;
      for (const child of node?.children ?? []) {
        const found = findNode(child, id);
        if (found) return found;
      }
      return null;
    };
    const centerActive = findNode(layout(), "center-stage")?.active;
    const onCenterPage =
      centerActive === "dashboard-page" ||
      centerActive === "todos-page" ||
      centerActive === "runbook-page" ||
      centerActive === "notes-page" ||
      centerActive === "routines-page" ||
      centerActive === "github-page";

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

    const newSpaceBtn = h_flex()
      .id("projects-new-space")
      .w(22)
      .h(22)
      .rounded(5)
      .items_center()
      .justify_center()
      .cursor_pointer()
      .hover((e) => e.bg(t.hover))
      .on_click(() => {
        run("layout.select", { stack: "center-stage", child: "work" });
        run("space.new", { folder: home() });
      })
      .child(svg(ICON.plus).size(14).text_color(t.muted));

    const blockedCount = ag.filter((a) => a.status === "blocked").length;
    const globalTodoCount = (
      (shared("james-todos.data") ?? {})["__global__"] ?? []
    ).filter((x) => !x.done).length;
    const routinesList = Array.isArray(shared("james-routines.data"))
      ? shared("james-routines.data")
      : [];
    const failedRoutinesCount = routinesList.filter((r) => r.enabled && r.lastStatus === "error").length;
    const activeRoutinesCount = routinesList.filter((r) => r.enabled).length;
    const ghCache = shared("james-github.cache") ?? {};
    const ghMine = Array.isArray(ghCache.mine) ? ghCache.mine : [];
    const ghReviews = Array.isArray(ghCache.reviews) ? ghCache.reviews : [];
    const ghFailingCount = [...ghMine, ...ghReviews].filter(
      (p) => p.ciState === "FAILURE" || p.ciState === "ERROR"
    ).length;
    const ghBadgeCount = ghFailingCount > 0 ? ghFailingCount : ghReviews.length;
    const ghBadgeColor = ghFailingCount > 0 ? "#f14c4c" : t.accent;

    const dockItem = (pageId, iconPath, label, badgeCount, badgeColor) => {
      const active = centerActive === pageId;
      const btn = h_flex()
        .id(`sidebar-dock-${pageId}`)
        .w_full()
        .h(30)
        .rounded(6)
        .relative()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .when(active, (e) => e.bg(t.selected))
        .hover((e) => e.bg(active ? t.selected : t.hover))
        .on_mouse_down("left", (_ev, cx) => {
          cx.stop_propagation();
          tipState.id = null;
          run("layout.select", { stack: "center-stage", child: pageId });
        })
        .child(
          svg(iconPath)
            .size(15)
            .text_color(active ? t.accent : t.muted)
        )
        .when(badgeCount > 0, (e) =>
          e.child(
            div()
              .absolute()
              .top(2)
              .right(6)
              .px(4)
              .min_w(14)
              .h(14)
              .flex()
              .items_center()
              .justify_center()
              .rounded(7)
              .bg(badgeColor ?? t.accent)
              .text_size(9.5)
              .font_weight(700)
              .text_color(t.accent_foreground ?? "#ffffff")
              .child(String(badgeCount > 99 ? "99+" : badgeCount))
          )
        );
      return div()
        .flex_1()
        .min_w(0)
        .child(tipAbove(`dock-${pageId}`, label, btn, t, "bottom_center"));
    };

    const cockpitDock = h_flex()
      .id("sidebar-cockpit-dock")
      .w_full()
      .h(38)
      .p(3)
      .gap(4)
      .items_center()
      .rounded(9)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .child(
        dockItem(
          "dashboard-page",
          "mods/activity-bar/icons/dashboard.svg",
          tr("act.dashboard"),
          blockedCount,
          t.blocked
        )
      )
      .child(
        dockItem(
          "todos-page",
          "mods/activity-bar/icons/todos.svg",
          `${tr("act.todos")} (${tr("todos.general")})`,
          globalTodoCount,
          t.accent
        )
      )
      .child(
        dockItem(
          "runbook-page",
          "mods/activity-bar/icons/runbook.svg",
          `${tr("act.runbook")} (${tr("todos.general")})`,
          0,
          null
        )
      )
      .child(
        dockItem(
          "notes-page",
          "mods/activity-bar/icons/notes.svg",
          `${tr("act.notes")} (${tr("todos.general")})`,
          0,
          null
        )
      )
      .child(
        dockItem(
          "routines-page",
          "mods/activity-bar/icons/routines.svg",
          tr("routines.title"),
          failedRoutinesCount > 0 ? failedRoutinesCount : activeRoutinesCount,
          failedRoutinesCount > 0 ? "#f14c4c" : t.accent
        )
      )
      .child(
        dockItem(
          "github-page",
          "mods/activity-bar/icons/github.svg",
          tr("gh.title"),
          ghBadgeCount,
          ghBadgeColor
        )
      );

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
          .child(tr("sb.spaces"))
      )
      .child(tipAbove("new-space", tr("sb.new_space"), newSpaceBtn, t));

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
            run("layout.select", { stack: "center-stage", child: "work" });
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
            tipAbove(
              `new-tab-${s.id}`,
              tr("sb.new_tab_or_agent"),
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
                  openOverlay({
                    mod: "james-new-menu",
                    kind: "popup",
                    width: 250,
                    height: 512,
                  });
                })
                .child(svg(ICON.plus).size(12).text_color(t.muted)),
              t
            )
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
              .child(tr("sb.no_chats"))
          );
        } else {
          for (const tab of tabs) {
            const lead = leads.get(tab.id);
            const agInfo = agentsByTab.get(tab.id);
            const activeTab = isCurrentSpace && foc?.tab === tab.id;
            const label = tabTitle(tab, lead);

            const isDragSource = this.draggingTab && this.dragTab?.id === tab.id;
            const isDropTarget =
              this.draggingTab &&
              this.dragTab &&
              this.dragTab.id !== tab.id &&
              this.dragTab.spaceId === s.id &&
              this.dragOverTab === tab.id;

            rows.push(
              h_flex()
                .id(`project-tab-${tab.id}`)
                .h(26)
                .pl(26)
                .pr(6)
                .gap(7)
                .rounded(6)
                .items_center()
                .when(this.draggingTab, (e) => e.cursor_grabbing())
                .when(!this.draggingTab, (e) => e.cursor_pointer())
                .border_1()
                .border_color(isDropTarget ? t.accent : isDragSource ? t.accent + "55" : t.chrome)
                .when(isDropTarget, (e) => e.bg(t.selected))
                .when(isDragSource, (e) => e.bg(t.canvas ?? t.chrome))
                .when(!isDropTarget && !isDragSource && activeTab && !onCenterPage, (e) => e.bg(t.surface))
                .hover((e) => e.bg(isDropTarget ? t.selected : isDragSource ? t.canvas ?? t.chrome : t.hover))
                .on_hover((hovered, cx) => {
                  if (!this.dragTab || this.dragTab.id === tab.id || this.dragTab.spaceId !== s.id) return;
                  const next = hovered ? tab.id : this.dragOverTab === tab.id ? null : this.dragOverTab;
                  if (next !== this.dragOverTab) {
                    this.dragOverTab = next;
                    cx.notify();
                  }
                })
                .on_mouse_down("left", (ev, cx) => {
                  cx.stop_propagation();
                  this.dragTab = { id: tab.id, spaceId: s.id, name: label };
                  this.draggingTab = false;
                  this.dragStart = ev.position ?? null;
                  this.dragOverTab = null;
                  cx.notify();
                })
                .on_mouse_up("left", (_ev, cx) => {
                  cx.stop_propagation();
                  const from = this.dragTab;
                  const wasDragging = this.draggingTab;
                  this.dragTab = null;
                  this.draggingTab = false;
                  this.dragStart = null;
                  this.dragPos = null;
                  this.dragOverTab = null;
                  if (from && from.id !== tab.id && from.spaceId === s.id) {
                    this.mergeTabs(from.id, tab.id, s.id, cx);
                  } else if (!wasDragging) {
                    run("layout.select", { stack: "center-stage", child: "work" });
                    if (!isCurrentSpace) run("space.select", { id: s.id });
                    run("tab.select", { id: tab.id });
                  }
                  cx.notify();
                })
                .on_mouse_down("right", (_ev, e) => {
                  e.stop_propagation();
                  openOverlay({
                    mod: "menu",
                    kind: "popup",
                    width: 200,
                    props: { tab: "tab", target: { id: tab.id, space: s.id } },
                  });
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
                  tipAbove(
                    `close-tab-${tab.id}`,
                    tr("sb.close_tab"),
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
                      .child(svg(ICON.close).size(11).text_color(t.muted)),
                    t
                  )
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
            .child(div().flex_1().min_w(0).truncate().child(m ?? tr("sb.this_computer")))
            .when(connected, (e) =>
              e.child(
                h_flex()
                  .id(`machine-add-${m ?? "local"}`)
                  .px(4)
                  .rounded(4)
                  .hover((s) => s.bg(t.surface).text_color(t.foreground))
                  .on_mouse_down("left", (_ev, cx) => {
                    cx.stop_propagation();
                    run("layout.select", { stack: "center-stage", child: "work" });
                    run("space.new", m ? { machine: m } : { machine: "", folder: home() });
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
                  run("layout.select", { stack: "center-stage", child: "work" });
                  run("space.new", m ? { machine: m } : { machine: "", folder: home() });
                })
                .child(svg(ICON.plus).size(12))
                .child(tr("sb.new_space_there"))
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
      .relative()
      .px(6)
      .py(6)
      .gap(4)
      .when(this.draggingTab, (e) => e.cursor_grabbing())
      .on_mouse_move((ev, cx) => {
        if (!this.dragTab) return;
        if (!this.draggingTab && this.dragStart && ev.position) {
          const dx = Math.abs(ev.position.x - this.dragStart.x);
          const dy = Math.abs(ev.position.y - this.dragStart.y);
          if (dx > 4 || dy > 4) this.draggingTab = true;
        }
        if (this.draggingTab && ev.local_position) {
          this.dragPos = ev.local_position;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.dragTab || this.dragOverTab || this.draggingTab) {
          this.dragTab = null;
          this.draggingTab = false;
          this.dragStart = null;
          this.dragPos = null;
          this.dragOverTab = null;
          cx.notify();
        }
      })
      .child(cockpitDock)
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
      )
      .when(this.draggingTab && Boolean(this.dragPos) && Boolean(this.dragTab), (el) => {
        const zoom = settings().zoom || 1;
        const hasTag = Boolean(this.dragOverTab);
        const estW = Math.min(190, Math.max(52, (this.dragTab.name?.length ?? 4) * 7 + (hasTag ? 54 : 22)));
        return el.child(
          h_flex()
            .absolute()
            .left(Math.max(4, Math.round(this.dragPos.x / zoom - estW / 2)))
            .top(Math.max(4, Math.round(this.dragPos.y / zoom - 13)))
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
            .child(div().max_w(130).truncate().child(this.dragTab.name))
            .when(hasTag, (b) =>
              b.child(div().text_size(10).text_color(t.accent).child(tr("tabs.drop_split")))
            )
        );
      })
      .child(
        h_flex()
          .id("james-settings-open")
          .h(30)
          .px(10)
          .gap(9)
          .rounded(7)
          .items_center()
          .cursor_pointer()
          .text_size(12.5)
          .text_color(t.muted)
          .hover((e) => e.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            openOverlay({
              mod: "james-settings",
              kind: "dialog",
              width: 600,
              height: 500,
            });
          })
          .child(
            svg("mods/source-control/icons/sliders.svg")
              .size(14)
              .flex_none()
              .text_color(t.muted)
          )
          .child(div().truncate().child(tr("sb.settings")))
      );
  }
}
