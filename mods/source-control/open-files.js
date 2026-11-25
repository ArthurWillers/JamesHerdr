// Opens a file in Better Files' viewer, the same way its own tree does: one shared
// "preview" tab per space, reused on every click, and an existing tab when the file is
// already open. Mirrors better-files/actions/open.js through its shared registry
// (`better-files.viewers`), because a mod can't import from another mod's folder.
import { panes, run, shared, setShared, spaces } from "herdr";

const VIEWERS = "better-files.viewers";
const OPENING_MS = 1500;

const entries = () => shared(VIEWERS) ?? {};
const baseName = (path) => path.split("/").filter(Boolean).pop() ?? path;

function setViewer(id, change) {
  const all = entries();
  setShared(VIEWERS, { ...all, [id]: { ...all[id], ...change } });
}

const tabIsLive = (tab) =>
  panes().some((p) => p.tab === tab && p.mod === "better-files");

const isLive = (entry) =>
  entry.tab ? tabIsLive(entry.tab) : Date.now() - (entry.at ?? 0) < OPENING_MS;

function liveViewers(space) {
  const where = new Map(
    spaces().flatMap((s) => (s.tabs ?? []).map((t) => [t.id, s.id]))
  );
  const wrongTab = (entry) =>
    Boolean(entry.tab) && (where.get(entry.tab) ?? entry.space) !== entry.space;
  return Object.entries(entries()).filter(
    ([, entry]) => entry.space === space && isLive(entry) && !wrongTab(entry)
  );
}

function newViewer(file, space, preview) {
  const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const others = panes()
    .filter((p) => p.mod === "better-files")
    .map((p) => p.tab);
  setViewer(id, { space, file, preview, tab: null, others, at: Date.now() });
  run("tab.new", {
    space,
    name: baseName(file.path),
    mod: "better-files",
    props: { mode: "viewer", viewer: id, space, file },
  });
}

// root: the Git top level; relative: the path Git reports; on: the machine, or null.
// keep: open in a tab of its own instead of the shared preview tab.
export function openInBetterFiles({ root, relative, on = null, keep = false }) {
  const space = spaces().find((s) => s.active)?.id;
  if (!space || !root || !relative) return false;
  const file = { path: `${root}/${relative}`, root, on: on ?? null };
  const viewers = liveViewers(space);
  const open = viewers.find(([, entry]) => entry.file?.path === file.path);
  if (open) {
    if (keep) setViewer(open[0], { preview: false });
    if (open[1].tab) run("tab.select", { id: open[1].tab });
    return true;
  }
  const preview = !keep && viewers.find(([, entry]) => entry.preview);
  if (preview) {
    const [id, entry] = preview;
    setViewer(id, { file });
    if (entry.tab) {
      run("tab.rename", { id: entry.tab, name: baseName(file.path) });
      run("tab.select", { id: entry.tab });
    }
    return true;
  }
  newViewer(file, space, !keep);
  return true;
}
