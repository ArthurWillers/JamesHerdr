// Multi-lane commit graph layout and smooth Bezier cell renderer, adapted from herdr-git-graph.
import { div, PathBuilder } from "gpui-kit";

export const GRAPH_ROW = 26;
export const GRAPH_PAD = 4;
export const GRAPH_MAX = 112;

const UNITS = { minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" };

export function age(when) {
  const m = /^(\d+) (second|minute|hour|day|week|month|year)/.exec(when ?? "");
  return !m ? when ?? "" : m[2] === "second" ? "now" : m[1] + UNITS[m[2]];
}

export const laneWidth = (n) => (n <= 7 ? 12 : Math.max(8, Math.floor(84 / n)));
export const laneX = (lane, L) => GRAPH_PAD + lane * L + L / 2;
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

// Lays commits out on lanes, producing Bezier segments [fromLane, fromY, toLane, toY, colorLane].
export function layoutGraph(commits) {
  const lanes = [];
  const free = () => {
    const i = lanes.indexOf(null);
    return i < 0 ? lanes.length : i;
  };
  let width = 1;
  for (const c of commits) {
    const before = lanes.slice();
    const segments = [];
    let lane = before.indexOf(c.fullHash);
    if (lane < 0) {
      lane = free();
      lanes[lane] = c.fullHash;
    }
    before.forEach((hash, j) => {
      if (!hash) return;
      if (hash === c.fullHash) {
        segments.push([j, 0, lane, 0.5, j]);
        if (j !== lane) lanes[j] = null;
      } else {
        segments.push([j, 0, j, 1, j]);
      }
    });
    const [first, ...rest] = c.parents;
    lanes[lane] = first ?? null;
    if (first) segments.push([lane, 0.5, lane, 1, lane]);
    for (const parent of rest) {
      let k = lanes.indexOf(parent);
      if (k < 0) {
        k = free();
        lanes[k] = parent;
      }
      segments.push([lane, 0.5, k, 1, k]);
    }
    width = Math.max(width, before.length, lanes.length);
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    c.col = lane;
    c.segments = segments;
    c.below = lanes.flatMap((h, i) => (h ? [i] : []));
  }
  return width;
}

// One row of the commit graph: smooth cubic-bezier paths + crisp ring/dot (herdr-git-graph style).
export function graphCell(c, n, L, t, fill) {
  const x = (lane) => laneX(lane, L);
  const y = (v) => v * GRAPH_ROW;
  const paths = new Map();

  for (const [a, ya, b, yb, colorIdx] of c.segments ?? []) {
    const color = laneColor(t, colorIdx);
    let p = paths.get(color)?.p ?? PathBuilder.stroke(1.75);
    p = p.move_to(x(a), y(ya));
    if (a === b) {
      p = p.line_to(x(b), y(yb));
    } else {
      const mid = (y(ya) + y(yb)) / 2;
      p = p.cubic_bezier_to(x(b), y(yb), x(a), mid, x(b), mid);
    }
    paths.set(color, { p, color });
  }

  const color = laneColor(t, c.col);
  const ring = c.isHead || c.parents.length > 1;
  const dot = div()
    .absolute()
    .left(x(c.col) - 4)
    .top(GRAPH_ROW / 2 - 4)
    .size(8)
    .rounded(4)
    .when(ring, (e) => e.bg(fill).border_2().border_color(color))
    .when(!ring, (e) => e.bg(color));

  const w = Math.min(GRAPH_PAD * 2 + n * L, GRAPH_MAX);
  return div()
    .relative()
    .flex_none()
    .w(w)
    .h(GRAPH_ROW)
    .overflow_hidden()
    .children(
      [...paths.values()].map(({ p, color: stroke }) =>
        window.paint_path(p.build(), stroke).absolute().top(0).left(0).size_full()
      )
    )
    .child(dot);
}
