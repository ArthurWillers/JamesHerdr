// Multi-lane commit graph layout and cell renderer, inspired by git-panel & herdr-git-graph.
import { div } from "gpui-kit";

export const GRAPH_ROW = 26;
export const GRAPH_MAX = 112;

const UNITS = { minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" };

export function age(when) {
  const m = /^(\d+) (second|minute|hour|day|week|month|year)/.exec(when ?? "");
  return !m ? when ?? "" : m[2] === "second" ? "now" : m[1] + UNITS[m[2]];
}

export const laneWidth = (n) => (n <= 7 ? 12 : Math.max(6, Math.floor(84 / n)));
export const laneColor = (t, i) => [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1][i % 6];

// `%D` with --decorate=full: refs/heads/x, refs/remotes/o/x, tag: refs/tags/x, HEAD -> refs/heads/x, HEAD.
function parseFullRefs(raw) {
  const refs = [];
  let isHead = false;
  for (let r of raw ? raw.split(", ") : []) {
    if (r.startsWith("HEAD")) {
      isHead = true;
      if (!r.includes(" -> ")) continue;
      r = r.split(" -> ")[1];
    }
    if (r.startsWith("tag: refs/tags/")) refs.push({ name: r.slice(15), kind: "tag" });
    else if (r.startsWith("refs/heads/")) refs.push({ name: r.slice(11), kind: "local" });
    else if (r.startsWith("refs/remotes/") && !r.endsWith("/HEAD"))
      refs.push({ name: r.slice(13), kind: "remote" });
  }
  const local = new Set(refs.filter((r) => r.kind === "local").map((r) => r.name));
  return {
    isHead,
    refs: refs.filter(
      (r) => r.kind !== "remote" || !local.has(r.name.slice(r.name.indexOf("/") + 1))
    ),
  };
}

// Expects format: %H%x1f%P%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s%x1f%b%x1e
export function parseGraphLog(stdout) {
  return stdout
    .split("\x1e")
    .map((rec) => rec.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [fullHash, parents, short, author, when, rawRefs, subject, body] = rec.split("\x1f");
      return {
        fullHash: (fullHash ?? "").trim(),
        hash: (short ?? "").trim(),
        parents: parents ? parents.trim().split(" ").filter(Boolean) : [],
        author: author ?? "",
        time: when ?? "",
        subject: subject ?? "",
        body: (body ?? "").trim(),
        ...parseFullRefs(rawRefs ?? ""),
      };
    });
}

// Assigns a lane column to every commit and records crossing/forking/merging edges.
export function layoutGraph(commits) {
  const lanes = [];
  const free = () => {
    const i = lanes.indexOf(null);
    return i < 0 ? lanes.length : i;
  };
  let width = 1;
  for (const c of commits) {
    const above = lanes.flatMap((h, i) => (h ? [i] : []));
    let col = lanes.indexOf(c.fullHash);
    c.tip = col < 0;
    if (col < 0) col = free();
    c.col = col;
    c.through = [];
    c.into = [];
    c.out = [];
    for (const i of above) {
      if (lanes[i] !== c.fullHash) c.through.push(i);
      else if (i !== col) c.into.push(i);
    }
    for (const i of c.into) lanes[i] = null;
    lanes[col] = c.parents[0] ?? null;
    for (const p of c.parents.slice(1)) {
      let k = lanes.indexOf(p);
      const fresh = k < 0;
      if (fresh) {
        k = free();
        lanes[k] = p;
      }
      c.out.push({ k, fresh });
    }
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    c.below = lanes.flatMap((h, i) => (h ? [i] : []));
    width = Math.max(
      width,
      col + 1,
      lanes.length,
      ...c.through.map((i) => i + 1),
      ...c.into.map((i) => i + 1)
    );
  }
  return width;
}

// One row of the commit graph: 2px lane lines and rounded fork/merge corners.
export function graphCell(c, n, L, t, fill) {
  const x = (i) => i * L + L / 2;
  const mid = GRAPH_ROW / 2;
  const R = L / 2;
  const col = x(c.col);
  const line = (i, top, h) =>
    div().absolute().left(x(i) - 1).top(top).w(2).h(h).bg(laneColor(t, i));
  const flat = (from, to, i) =>
    div()
      .absolute()
      .left(Math.min(from, to))
      .top(mid - 1)
      .w(Math.abs(to - from))
      .h(2)
      .bg(laneColor(t, i));
  const corner = (i, down) => {
    const right = x(i) > col;
    const e = div()
      .absolute()
      .w(R + 2)
      .h(down ? GRAPH_ROW - mid + 1 : mid + 1)
      .top(down ? mid - 1 : 0)
      .left(right ? x(i) - R - 1 : x(i) - 1)
      .border_color(laneColor(t, i))
      .when(down, (el) => el.border_t(2))
      .when(!down, (el) => el.border_b(2));
    if (right) {
      return e
        .border_r(2)
        .when(down, (el) => el.rounded_tr(R + 1))
        .when(!down, (el) => el.rounded_br(R + 1));
    }
    return e
      .border_l(2)
      .when(down, (el) => el.rounded_tl(R + 1))
      .when(!down, (el) => el.rounded_bl(R + 1));
  };
  const edge = (i) => (x(i) > col ? x(i) - R - 1 : x(i) + R + 1);

  const parts = c.through.map((i) => line(i, 0, GRAPH_ROW));
  for (const j of c.into) parts.push(flat(col, edge(j), j), corner(j, false));
  for (const { k, fresh } of c.out) {
    parts.push(...(fresh ? [flat(col, edge(k), k), corner(k, true)] : [flat(col, x(k), k)]));
  }
  if (!c.tip) parts.push(line(c.col, 0, mid));
  if (c.parents.length) parts.push(line(c.col, mid, GRAPH_ROW - mid));

  const tint = laneColor(t, c.col);
  const dot = c.isHead
    ? div()
        .size(12)
        .rounded_full()
        .border_2()
        .border_color(tint)
        .bg(fill)
        .flex()
        .items_center()
        .justify_center()
        .child(div().size(4).rounded_full().bg(tint))
    : c.parents.length > 1
    ? div().size(8).rounded_full().border_2().border_color(tint).bg(fill)
    : div().size(8).rounded_full().bg(tint);
  const s = c.isHead ? 12 : 8;
  parts.push(dot.absolute().left(col - s / 2).top(mid - s / 2));

  return div()
    .relative()
    .flex_none()
    .w(Math.min(n * L, GRAPH_MAX))
    .h(GRAPH_ROW)
    .overflow_hidden()
    .children(parts);
}
