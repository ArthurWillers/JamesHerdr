// Spaces and agents in one block, with JamesHerdr Cockpit Dock at top and Routines ticker.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  spaces,
  agents,
  focused,
  theme,
  layout,
  run,
  exec,
  notify as appNotify,
  shared,
  setShared,
  setAgentOrder,
  checking,
} from "herdr";
import { Spaces } from "./spaces.js";
import { Agents } from "./agents.js";
import { findNode } from "./find-node.js";
import { TEXT, Badge, Rail } from "./ui.js";

function notify(opts) {
  appNotify(opts);
  const q = shared("better-alerts.queue");
  setShared("better-alerts.queue", [...(Array.isArray(q) ? q : []), opts]);
}

const TABS = ["spaces", "agents"];

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

export class Lists {
  init(props, cx) {
    this.spaces = new Spaces();
    this.spaces.init(props, cx);
    this.agents = new Agents();
    this.agents.init(props, cx);
    this.runningRoutines = new Set();
    const saved = localStorage.getItem("lists.tab");
    this.tab = TABS.includes(saved) ? saved : "spaces";
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
        !this.runningRoutines.has(r.id),
    );
    if (due.length === 0) return;

    const allSpaces = spaces();
    const updated = raw.map((r) =>
      due.some((d) => d.id === r.id) ? { ...r, nextRunAt: computeNextRoutineRun(r, now) } : r,
    );
    setShared("james-routines.data", updated);

    const patchRoutine = (id, patch) => {
      const cur = shared("james-routines.data");
      if (!Array.isArray(cur)) return;
      setShared(
        "james-routines.data",
        cur.map((x) => (x.id === id ? { ...x, ...patch } : x)),
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
        patchRoutine(r.id, { lastRunAt: now, lastStatus: "ok", runCount: (r.runCount || 0) + 1 });
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
          patchRoutine(r.id, { lastRunAt: now, lastStatus: "ok", runCount: (r.runCount || 0) + 1 });
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
                title: `Routines: ${r.name}`,
                body: output.split("\n")[0] || "Failed",
              });
            }
            spawnCx.notify();
          }
        });
      }
    }
  }

  pick(tab, cx) {
    this.tab = tab;
    localStorage.setItem("lists.tab", tab);
    cx.notify();
  }

  cockpitDock(t) {
    const centerActive = findNode(layout(), "center-stage")?.active;
    const ag = agents();
    const blockedCount = ag.filter((a) => a.status === "blocked").length;
    const globalTodoCount = ((shared("james-todos.data") ?? {})["__global__"] ?? []).filter(
      (x) => !x.done,
    ).length;
    const routinesList = Array.isArray(shared("james-routines.data"))
      ? shared("james-routines.data")
      : [];
    const failedRoutines = routinesList.filter((r) => r.enabled && r.lastStatus === "error").length;
    const activeRoutines = routinesList.filter((r) => r.enabled).length;

    const ghCache = shared("james-github.cache") ?? {};
    const ghIgnored = new Set(
      Array.isArray(shared("james-github.ignored")) ? shared("james-github.ignored") : [],
    );
    const ghMine = (Array.isArray(ghCache.mine) ? ghCache.mine : []).filter((p) => !ghIgnored.has(p.id));
    const ghReviews = (Array.isArray(ghCache.reviews) ? ghCache.reviews : []).filter(
      (p) => !ghIgnored.has(p.id),
    );
    const ghRepoCi = (Array.isArray(ghCache.repoCi) ? ghCache.repoCi : []).filter(
      (p) => !ghIgnored.has(p.id),
    );
    const ghFailing = [...ghMine, ...ghReviews, ...ghRepoCi].filter(
      (p) => (p.ciState ?? p.state) === "FAILURE" || (p.ciState ?? p.state) === "ERROR",
    ).length;
    const ghBadge = ghFailing > 0 ? ghFailing : ghReviews.length;
    const ghColor = ghFailing > 0 ? "#f14c4c" : t.accent;

    const dockItem = (pageId, iconPath, label, count, color) => {
      const active = centerActive === pageId;
      return h_flex()
        .id(`dock-${pageId}`)
        .flex_1()
        .min_w(0)
        .h(30)
        .rounded(6)
        .relative()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .tooltip(label)
        .when(active, (e) => e.bg(t.selected))
        .hover((e) => e.bg(active ? t.selected : t.hover))
        .on_mouse_down("left", (_ev, cx) => {
          cx.stop_propagation();
          run("layout.select", { stack: "center-stage", child: pageId });
        })
        .child(svg(iconPath).size(14).text_color(active ? t.accent : t.muted))
        .when(count > 0, (e) =>
          e.child(
            div()
              .absolute()
              .top(2)
              .right(3)
              .px(3)
              .min_w(13)
              .h(13)
              .flex()
              .items_center()
              .justify_center()
              .rounded(7)
              .bg(color ?? t.accent)
              .text_size(9)
              .font_weight(700)
              .text_color(t.accent_foreground ?? "#ffffff")
              .child(String(count > 99 ? "99+" : count)),
          ),
        );
    };

    return div()
      .px(8)
      .pt(4)
      .pb(2)
      .flex_none()
      .child(
        h_flex()
          .id("sidebar-cockpit-dock")
          .w_full()
          .h(36)
          .p(3)
          .gap(2)
          .items_center()
          .rounded(8)
          .border_1()
          .border_color(t.border)
          .bg(t.raised)
          .child(dockItem("dashboard-page", "mods/activity-bar/icons/dashboard.svg", "Dashboard", blockedCount, t.blocked))
          .child(dockItem("todos-page", "mods/activity-bar/icons/todos.svg", "To-do (General)", globalTodoCount, t.accent))
          .child(dockItem("runbook-page", "mods/activity-bar/icons/runbook.svg", "Runbook (General)", 0, null))
          .child(dockItem("notes-page", "mods/activity-bar/icons/notes.svg", "Notes (General)", 0, null))
          .child(
            dockItem(
              "routines-page",
              "mods/activity-bar/icons/routines.svg",
              "Routines",
              failedRoutines > 0 ? failedRoutines : activeRoutines,
              failedRoutines > 0 ? "#f14c4c" : t.accent,
            ),
          )
          .child(dockItem("github-page", "mods/activity-bar/icons/github.svg", "GitHub", ghBadge, ghColor)),
      );
  }

  render() {
    const t = theme();
    const collapsed = this.spaces.collapsed();
    const root = v_flex()
      .id("better-sidebar-lists")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(TEXT.body)
      .on_size_change((size, cx) => this.spaces.resized(size, cx));
    this.spaces.under = null;
    this.spaces.quiet = null;
    this.spaces.above = null;
    if (!this.spaces.settings.combined || collapsed)
      return root
        .when(!collapsed, (r) => r.child(this.cockpitDock(t)))
        .child(
          v_flex()
            .flex_1()
            .min_h(0)
            .child(this.spaces.header(t, collapsed))
            .child(this.spaces.body(t, collapsed)),
        )
        .child(v_flex().flex_1().min_h(0).child(this.agents.render()));

    const view = this.agents.readView();
    root.child(this.cockpitDock(t)).child(this.tabBar(t, view));
    if (this.tab !== "spaces") return root.child(this.agents.render({ view, heading: false }));

    const nested = { ...view, sort: { id: "grouped" }, byPriority: false, nested: true };
    const order = [];
    const all = view.model;
    const pinned = view.groups.find((g) => g.id === "pinned");
    const pins = pinned?.members.map((a) => a.address) ?? [];
    order.push(...pins);
    this.spaces.above = () => (pinned ? this.agents.groupRows(pinned, 0, view, t) : []);
    const nest = (lines, row) => h_flex().children(lines.map((l) => Rail(l))).child(row.flex_1().min_w(0));
    const shownTab = focused()?.tab;
    const plain = (tab) => !all.some((a) => a.tab === tab.id);
    this.spaces.under = ({ w, tree, kids }) => {
      const items = w.tabs.flatMap((tab) =>
        plain(tab)
          ? tab.settled ? [] : [{ tab }]
          : all.filter((a) => a.tab === tab.id && !pins.includes(a.address)).map((a) => ({ a })),
      );
      order.push(...items.filter((x) => x.a).map((x) => x.a.address));
      const before = tree ? [tree.startsWith("└") ? "" : "│"] : [];
      return items.flatMap((x, i) => {
        const last = i === items.length - 1 && !kids;
        const [row, ...subs] = x.a
          ? this.agents.agentWithSubs(x.a, i, nested, t)
          : [this.agents.tabRow(w, x.tab, x.tab.id === shownTab, t)];
        return [nest([...before, last ? "└" : "├"], row), ...subs.map((s) => nest([...before, last ? "" : "│"], s))];
      });
    };
    this.spaces.quiet = (w) =>
      all.some((a) => a.space === w.id && a.focused) || w.tabs.some((tab) => tab.id === shownTab && plain(tab));
    const body = this.spaces.body(t, false);
    setAgentOrder(order);
    return root.child(body);
  }

  tabBar(t, view) {
    const tab = (id, label, count) =>
      h_flex()
        .id(`lists-tab-${id}`)
        .px(10)
        .h(24)
        .gap(5)
        .justify_center()
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(TEXT.label)
        .font_medium()
        .text_color(this.tab === id ? t.foreground : t.dim)
        .when(this.tab === id, (el) => el.bg(t.selected))
        .when(this.tab !== id, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => this.pick(id, cx))
        .child(label)
        .when(count !== null, (el) => el.child(Badge(count)));
    return h_flex()
      .px(8)
      .pt(6)
      .pb(6)
      .mb(4)
      .border_b(1)
      .border_color(t.border)
      .flex_none()
      .gap(6)
      .items_center()
      .child(
        h_flex()
          .flex_1()
          .gap(2)
          .child(tab("spaces", "Spaces", null))
          .child(tab("agents", "Agents", view.count)),
      )
      .child(this.tab === "spaces" ? this.spaces.headerButtons() : this.agents.sortMenu());
  }
}
