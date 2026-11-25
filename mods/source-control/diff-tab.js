// The diff tab: a centre tab that shows one file's diff (working tree, staged, or a commit),
// opened from the Source Control panel. One reusable tab per space, like Better Changes:
// the panel publishes what to show in shared("james-changes.diff-tabs")[space], and the
// tab's own copy of this mod follows it.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Scrollbar, v_virtual_list } from "gpui-base";
import {
  spaces,
  panes,
  exec,
  readTextFile,
  theme,
  settings,
  shared,
  setShared,
  run,
  checking,
} from "herdr";
import { tr } from "./i18n.js";
import { openInBetterFiles } from "./open-files.js";
import { followFileIcons, fileIcon, isLight } from "./file-icons.js";
import { WHOLE_FILE_LINES, languageOf, syntaxColors, tokenizeLine } from "./syntax.js";

const TABS_KEY = "james-changes.diff-tabs";
const MOD = "source-control";
const TAB_OPEN_TIMEOUT_MS = 1500;
const SYNC_MS = 300;
const LIVE_MS = 2500;
const MAX_LINES = 1500;
const MAX_LENGTH = 4000;
const CHAR_WIDTH = 0.62;
const GUTTERS = 10;

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

const ICON = {
  diff: "mods/source-control/icons/diff.svg",
  split: "mods/source-control/icons/diff-split.svg",
  file: "mods/source-control/icons/file.svg",
  open: "mods/workspace-chrome/file-text.svg",
};

const codeFont = () => settings().font_family ?? "JetBrains Mono";
const codeSize = () => Math.max(11, Math.min(16, (settings().font_size ?? 14) - 1));
const rowHeight = () => Math.round(codeSize() * 1.5);
const baseName = (path) => String(path ?? "").split("/").pop() || "";

const expandTabs = (text) =>
  text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd(s.length - 1 - ((s.length - 1) % 4) + 4));

function diffRows(lines) {
  let oldLine = 0;
  let newLine = 0;
  const out = [];
  for (const text of lines) {
    if (
      text.startsWith("diff --git ") ||
      text.startsWith("index ") ||
      text.startsWith("new file mode ") ||
      text.startsWith("deleted file mode ") ||
      text.startsWith("similarity index ") ||
      text.startsWith("rename from ") ||
      text.startsWith("rename to ") ||
      text.startsWith("--- ") ||
      text.startsWith("+++ ")
    )
      continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      out.push({ kind: "@", text });
      continue;
    }
    const kind = text[0];
    if (kind === "-") out.push({ kind, old: oldLine++, text: expandTabs(text.slice(1)) });
    else if (kind === "+") out.push({ kind, next: newLine++, text: expandTabs(text.slice(1)) });
    else if (kind === " ")
      out.push({ kind, old: oldLine++, next: newLine++, text: expandTabs(text.slice(1)) });
    else out.push({ kind: "", text });
  }
  return out;
}

// Side by side: each replacement block is aligned by position; context sits on both sides.
function splitDiffRows(rows) {
  const paired = [];
  const removed = [];
  const added = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      paired.push({ kind: "pair", left: removed[i] ?? null, right: added[i] ?? null });
    removed.length = 0;
    added.length = 0;
  };
  for (const row of rows) {
    if (row.kind === "-") removed.push(row);
    else if (row.kind === "+") added.push(row);
    else {
      flush();
      paired.push(row.kind === " " ? { kind: "pair", left: row, right: row } : row);
    }
  }
  flush();
  return paired;
}

function diffTabOf(space) {
  const ids = new Set((spaces().find((s) => s.id === space)?.tabs ?? []).map((t) => t.id));
  return panes().find((p) => p.mod === MOD && ids.has(p.tab))?.tab;
}

// From the panel: show `target` in this space's diff tab, opening it when there is none.
// target: { root, on, path, staged, fresh, status, commit?, subject? }
export function openDiffTab(target) {
  const space = spaces().find((s) => s.active);
  if (!space || !target?.root || !target?.path) return;
  const entries = shared(TABS_KEY) ?? {};
  const old = entries[space.id];
  const tab = diffTabOf(space.id);
  const selected = { ...target, at: Date.now() };
  const name = baseName(target.path);
  // Published before the tab opens so its copy sees the latest pick; the pending time keeps
  // rapid clicks from opening two tabs.
  setShared(TABS_KEY, {
    ...entries,
    [space.id]: { target: selected, pending: tab ? null : old?.pending ?? Date.now() },
  });
  if (tab) {
    run("tab.rename", { id: tab, name });
    run("tab.select", { id: tab });
  } else if (!old?.pending || Date.now() - old.pending > TAB_OPEN_TIMEOUT_MS) {
    run("tab.new", {
      space: space.id,
      name,
      mod: MOD,
      props: { mode: "diff", space: space.id, target: selected },
    });
  }
}

export const diffTabMethods = {
  initDiffTab(p, cx) {
    this.mode = "diff";
    this.diffSpace = p.space;
    this.diffLayout = localStorage.getItem("diff-layout") === "split" ? "split" : "inline";
    this.target = null;
    this.targetId = null;
    this.rows = [];
    this.pairedRows = [];
    this.diffWidth = 300;
    this.splitOffset = 0;
    this.diffToken = 0;
    this.lastRaw = null;
    if (checking()) return;

    setShared("mod-icons", { ...(shared("mod-icons") ?? {}), [MOD]: ICON.diff });
    // A reopened tab (after a restart) shows what it last showed.
    const entries = shared(TABS_KEY) ?? {};
    if (this.diffSpace && !entries[this.diffSpace]) {
      let target = p.target ?? null;
      try {
        const saved = JSON.parse(localStorage.getItem(`diff.target.${this.diffSpace}`) ?? "null");
        if (saved?.root && saved?.path) target = saved;
      } catch {
        // Bad saved state: the props still say what to show.
      }
      if (target) setShared(TABS_KEY, { ...entries, [this.diffSpace]: { target, pending: null } });
    }
    followFileIcons(this, cx);
    this.syncTarget(cx);
    cx.timer.every(SYNC_MS, (timerCx) => this.syncTarget(timerCx));
    // Working-tree and staged diffs change under you; commits never do.
    cx.timer.every(LIVE_MS, (timerCx) => {
      if (this.target && !this.target.commit && !this.diffLoading) this.loadDiff(timerCx, true);
    });
  },

  syncTarget(cx) {
    const entry = (shared(TABS_KEY) ?? {})[this.diffSpace];
    const target = entry?.target;
    if (!target) return;
    const id = JSON.stringify(target);
    if (id === this.targetId) return;
    if (entry.pending && diffTabOf(this.diffSpace))
      setShared(TABS_KEY, { ...shared(TABS_KEY), [this.diffSpace]: { ...entry, pending: null } });
    localStorage.setItem(`diff.target.${this.diffSpace}`, JSON.stringify(target));
    this.targetId = id;
    this.target = target;
    this.rows = [];
    this.pairedRows = [];
    this.syntaxFor = null;
    this.splitOffset = 0;
    this.diffNote = null;
    this.lastRaw = null;
    this.add = 0;
    this.del = 0;
    this.loadDiff(cx);
    cx.notify();
  },

  loadDiff(cx, quiet = false) {
    const target = this.target;
    if (!target) return;
    const token = ++this.diffToken;
    const { root, on } = target;
    const git = (args) => exec("git", [...READ, ...args], { cwd: root, on: on ?? undefined });
    if (!quiet) this.diffLoading = true;
    cx.spawn(async (cx) => {
      let lines = null;
      let note = null;
      try {
        if (target.commit) {
          const r = await git([
            "show", "--no-ext-diff", "--no-color", "--diff-merges=first-parent",
            "--format=", target.commit, "--", target.path,
          ]);
          if (r.code !== 0) throw new Error(r.stderr || "git show failed");
          lines = r.stdout.replace(/\n$/, "").split("\n");
        } else {
          let fresh = Boolean(target.fresh);
          if (!target.staged && !fresh) {
            const tracked = await git(["ls-files", "--error-unmatch", "--", target.path]);
            fresh = tracked.code !== 0;
          }
          if (fresh) {
            const text = await readTextFile(`${root}/${target.path}`, { on }).catch(() => null);
            if (text === null) note = "Cannot preview this file (binary, too large, or unreadable)";
            else if (text.includes("\0")) note = "Binary file · no text diff";
            else {
              const body = text.slice(0, 400000).replace(/\n$/, "").split("\n");
              lines = [`@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)];
            }
          } else {
            const r = await git([
              "diff", ...(target.staged ? ["--cached"] : []),
              "--no-ext-diff", "--no-color", "--", target.path,
            ]);
            if (r.code !== 0) throw new Error(r.stderr || "git diff failed");
            lines = r.stdout.replace(/\n$/, "").split("\n");
          }
        }
      } catch (e) {
        note = String(e?.message ?? e).trim();
      }
      if (token !== this.diffToken) return;
      this.diffLoading = false;
      const raw = JSON.stringify([lines, note]);
      if (raw === this.lastRaw) return;
      this.lastRaw = raw;
      if (lines) {
        const first = lines.findIndex((l) => l.startsWith("@@"));
        if (first < 0) {
          note = lines.some((l) => l.startsWith("Binary files"))
            ? "Binary file changed"
            : target.commit || lines.join("").trim()
            ? "No text diff (mode or rename only)"
            : "No changes";
          lines = [];
        } else lines = lines.slice(first);
      }
      this.showLines(lines ?? []);
      this.diffNote = note;
      cx.notify();
    });
    if (!quiet) cx.notify();
  },

  showLines(lines) {
    this.truncated = lines.length > MAX_LINES;
    const visible = lines
      .slice(0, MAX_LINES)
      .map((l) => (l.length > MAX_LENGTH ? `${l.slice(0, MAX_LENGTH)}…` : l));
    this.rows = diffRows(visible);
    this.pairedRows = splitDiffRows(this.rows);
    this.syntaxFor = null;
    this.add = this.rows.filter((r) => r.kind === "+").length;
    this.del = this.rows.filter((r) => r.kind === "-").length;
    this.diffWidth = Math.max(
      300,
      ...this.rows.map((r) => ((r.text?.length ?? 0) * CHAR_WIDTH + GUTTERS) * codeSize())
    );
  },

  setDiffLayout(layout, cx) {
    this.diffLayout = layout;
    localStorage.setItem("diff-layout", layout);
    this.splitOffset = 0;
    cx.notify();
  },

  // ── Syntax colours, worked out once per diff ──────────────────────────────
  highlightRows() {
    const language = languageOf(this.target?.path);
    const runs = new Map();
    let before = null;
    let after = null;
    try {
      if (this.rows.length <= WHOLE_FILE_LINES)
        for (const row of this.rows) {
          if (row.kind === "@") {
            before = after = null;
            continue;
          }
          if (!["+", "-", " "].includes(row.kind)) continue;
          const result = tokenizeLine(row.text ?? "", language, row.kind === "-" ? before : after);
          runs.set(row, result.runs);
          if (row.kind === "-") before = result.state;
          else if (row.kind === " ") before = after = result.state;
          else after = result.state;
        }
    } catch {
      runs.clear();
    }
    this.syntaxFor = this.rows;
    this.syntaxRuns = runs;
  },

  runsOf(row) {
    if (!row || ["@", ""].includes(row.kind)) return null;
    if (this.syntaxFor !== this.rows) this.highlightRows();
    const runs = this.syntaxRuns.get(row);
    if (runs) return runs;
    try {
      return tokenizeLine(row.text ?? "", languageOf(this.target?.path)).runs;
    } catch {
      return null;
    }
  },

  codeText(row, color, t) {
    const runs = this.runsOf(row);
    if (!runs) return div().text_color(color).child(row?.text || " ");
    const colors = syntaxColors(t);
    return h_flex().children(
      runs.map((r) =>
        div()
          .flex_none()
          .whitespace_nowrap()
          .text_color(colors[r.kind] ?? t.foreground)
          .child(r.text || " ")
      )
    );
  },

  rowLook(kind, t) {
    if (kind === "+") return { color: t.ansi2, background: `${t.ansi2}26` };
    if (kind === "-") return { color: t.ansi1, background: `${t.ansi1}26` };
    return { color: t.foreground, background: null };
  },

  gutter(value, t) {
    return div()
      .w(codeSize() * 3.2)
      .flex_none()
      .text_right()
      .text_color(t.dim)
      .child(value === undefined || value === null ? "" : String(value));
  },

  hunkRow(row, t) {
    return div()
      .h(rowHeight())
      .px(12)
      .w_full()
      .flex()
      .items_center()
      .bg(t.raised)
      .text_color(row.kind === "@" ? t.accent : t.dim)
      .whitespace_nowrap()
      .child(row.text);
  },

  inlineRow(row, t) {
    if (row.kind === "@" || row.kind === "") return this.hunkRow(row, t);
    const { color, background } = this.rowLook(row.kind, t);
    const sign = row.kind === "+" || row.kind === "-" ? row.kind : "";
    return h_flex()
      .h(rowHeight())
      .w_full()
      .gap(8)
      .items_center()
      .when(Boolean(background), (el) => el.bg(background))
      .child(this.gutter(row.old, t))
      .child(this.gutter(row.next, t))
      .child(div().w(codeSize()).flex_none().text_color(color).child(sign))
      .child(div().flex_1().min_w(0).whitespace_nowrap().child(this.codeText(row, color, t)));
  },

  splitRow(row, t) {
    if (row.kind !== "pair") return this.hunkRow(row, t);
    const side = (entry, line, right) => {
      const { color, background } = this.rowLook(entry?.kind, t);
      const sign = entry?.kind === "+" || entry?.kind === "-" ? entry.kind : "";
      return h_flex()
        .flex_1()
        .min_w(0)
        .h_full()
        .gap(6)
        .items_center()
        .overflow_hidden()
        .when(right, (el) => el.border_l(1).border_color(t.border))
        .when(Boolean(background), (el) => el.bg(background))
        .when(!entry, (el) => el.bg(t.raised))
        .child(this.gutter(entry ? line : null, t))
        .child(div().w(codeSize()).flex_none().text_color(color).child(sign))
        .child(
          div()
            .flex_1()
            .min_w(0)
            .overflow_hidden()
            .child(
              div()
                .w(this.diffWidth)
                .flex_none()
                .ml(-this.splitOffset)
                .whitespace_nowrap()
                .when(Boolean(entry), (el) => el.child(this.codeText(entry, color, t)))
            )
        );
    };
    return h_flex()
      .h(rowHeight())
      .w_full()
      .child(side(row.left, row.left?.old, false))
      .child(side(row.right, row.right?.next, true));
  },

  // ── Drawing ───────────────────────────────────────────────────────────────
  diffFileIcon(path, t, size = 14) {
    const picture = fileIcon(this.fileIcons, path, { light: isLight(t.background) });
    if (picture) return image(picture).size(size).flex_none();
    return svg(ICON.file).size(size).flex_none().text_color(t.dim);
  },

  layoutToggle(t) {
    const option = (id, icon, label) => {
      const active = this.diffLayout === id;
      return h_flex()
        .id(`sc-diff-layout-${id}`)
        .h(22)
        .px(7)
        .gap(5)
        .items_center()
        .rounded(5)
        .cursor_pointer()
        .text_size(11.5)
        .text_color(active ? t.foreground : t.muted)
        .when(active, (el) => el.bg(t.raised))
        .hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (_ev, cx) => {
          cx.stop_propagation();
          this.setDiffLayout(id, cx);
        })
        .child(svg(icon).size(12).text_color(active ? t.accent : t.muted))
        .child(div().child(label));
    };
    return h_flex()
      .flex_none()
      .p(2)
      .gap(2)
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .child(option("inline", ICON.diff, tr("sc.diff_inline")))
      .child(option("split", ICON.split, tr("sc.diff_split")));
  },

  renderDiffHeader(t) {
    const target = this.target;
    const parts = String(target?.path ?? "").split("/");
    const name = parts.pop() || tr("sc.no_file");
    const scope = target?.commit
      ? target.short || target.commit.slice(0, 7)
      : target?.staged
      ? tr("sc.staged_badge")
      : tr("sc.working_tree_badge");
    const canOpen = Boolean(target?.root) && target?.status !== "D";

    return h_flex()
      .h(36)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome ?? t.background)
      .child(this.diffFileIcon(target ? `${target.root}/${target.path}` : "", t))
      .child(
        div()
          .flex_none()
          .max_w(280)
          .truncate()
          .text_size(13)
          .font_weight(500)
          .text_color(t.foreground)
          .child(name)
      )
      .child(
        div()
          .flex_none()
          .px(6)
          .py(1)
          .rounded(4)
          .border_1()
          .border_color(target?.commit ? (t.ansi5 ?? t.accent) + "66" : t.border)
          .text_size(10.5)
          .font_weight(600)
          .text_color(target?.commit ? t.ansi5 ?? t.accent : t.muted)
          .child(scope)
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(11.5)
          .text_color(t.dim)
          .child([parts.join("/"), target?.subject].filter(Boolean).join(" · "))
      )
      .when(this.add > 0, (el) =>
        el.child(div().text_size(11.5).text_color(t.ansi2).child(`+${this.add}`))
      )
      .when(this.del > 0, (el) =>
        el.child(div().text_size(11.5).text_color(t.ansi1).child(`−${this.del}`))
      )
      .child(this.layoutToggle(t))
      .when(canOpen, (el) =>
        el.child(
          h_flex()
            .id("sc-diff-open-file")
            .h(26)
            .px(8)
            .gap(5)
            .items_center()
            .rounded(6)
            .border_1()
            .border_color(t.border)
            .bg(t.raised)
            .cursor_pointer()
            .text_size(11.5)
            .text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_ev, cx) => {
              cx.stop_propagation();
              openInBetterFiles({ root: target.root, relative: target.path, on: target.on });
              cx.notify();
            })
            .child(svg(ICON.open).size(12).text_color(t.muted))
            .child(div().child(tr("sc.open_file")))
        )
      );
  },

  renderDiffBody(t) {
    const split = this.diffLayout === "split";
    const rows = split ? this.pairedRows : this.rows;
    const listId = `sc-diff-${this.targetId}-${this.diffLayout}`;
    const list = v_virtual_list(
      listId,
      rows.length,
      rowHeight(),
      (i) => String(i),
      (range) =>
        rows
          .slice(range.start, range.end)
          .map((row) => (split ? this.splitRow(row, t) : this.inlineRow(row, t)))
    ).size_full();

    const scroller = split
      ? div()
          .id("sc-diff-split")
          .size_full()
          .child(list)
          .on_scroll_wheel((e, cx) => {
          const delta = e.delta.x || (e.modifiers?.shift ? e.delta.y : 0);
          if (!delta) return;
          const furthest = Math.max(0, (this.diffWidth || 300) - 160);
          this.splitOffset = Math.max(0, Math.min(furthest, this.splitOffset - delta));
          cx.stop_propagation();
          cx.notify();
        })
      : div()
          .id("sc-diff-x")
          .size_full()
          .overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(list));

    return div()
      .flex_1()
      .min_h(0)
      .relative()
      .bg(t.canvas ?? t.background)
      .font_family(codeFont())
      .text_size(codeSize())
      .child(scroller)
      .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0());
  },

  renderDiffTab() {
    const t = theme();
    const message = (text, error = false) =>
      div()
        .px(14)
        .py(10)
        .flex_none()
        .text_size(12)
        .text_color(error ? t.ansi1 : t.dim)
        .child(text);
    const split = this.diffLayout === "split";
    return v_flex()
      .id("sc-diff-tab")
      .size_full()
      .min_h(0)
      .overflow_hidden()
      .bg(t.background)
      .text_color(t.foreground)
      .child(this.renderDiffHeader(t))
      .when(!this.target, (el) => el.child(message(tr("sc.no_file"))))
      .when(Boolean(this.diffNote), (el) =>
        el.child(message(this.diffNote, /fatal|error|failed/i.test(this.diffNote)))
      )
      .when(this.diffLoading && !this.rows.length && !this.diffNote, (el) =>
        el.child(message(tr("sc.loading_diff")))
      )
      .when(split && this.rows.length > 0, (el) =>
        el.child(
          h_flex()
            .h(24)
            .flex_none()
            .border_b(1)
            .border_color(t.border)
            .text_size(11)
            .text_color(t.muted)
            .child(div().flex_1().px(12).child(tr("sc.diff_before")))
            .child(
              div()
                .flex_1()
                .h_full()
                .flex()
                .items_center()
                .px(12)
                .border_l(1)
                .border_color(t.border)
                .child(tr("sc.diff_after"))
            )
        )
      )
      .when(this.rows.length > 0, (el) => el.child(this.renderDiffBody(t)))
      .when(Boolean(this.truncated), (el) =>
        el.child(message(tr("sc.diff_truncated", { count: MAX_LINES.toLocaleString() })))
      );
  },
};
