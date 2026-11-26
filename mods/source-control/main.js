import { View, div, svg, image } from "gpui-kit";
import { tr } from "./i18n.js";
import { openInBetterFiles } from "./open-files.js";
import { followFileIcons, fileIcon, isLight } from "./file-icons.js";
import { openDiffTab, diffTabMethods } from "./diff-tab.js";
import {
  GRAPH_ROW,
  GRAPH_PAD,
  GRAPH_MAX,
  age,
  laneWidth,
  laneX,
  laneColor,
  parseGraphLog,
  layoutGraph,
  graphCell,
} from "./graph-lanes.js";
import {
  v_flex,
  h_flex,
  Input,
  InputState,
  TextareaState,
  Textarea,
  Popup,
} from "gpui-base";
import {
  spaces,
  panes,
  focused,
  exec,
  readTextFile,
  watchFolder,
  theme,
  shared,
  setShared,
  openOverlay,
  checking,
  notify,
  props,
} from "herdr";

const DEFAULT_PROMPT =
  "Analyze the git diff below and write a git commit message following the Conventional Commits specification:\n" +
  "1. First line: <type>(<optional scope>): <concise summary in imperative mood, max 72 chars>\n" +
  "2. Second line: blank\n" +
  "3. Body: concise bullet points (- ...) explaining the key changes and why they were made.";

const DEFAULT_IGNORE =
  "package-lock.json, pnpm-lock.yaml, yarn.lock, Cargo.lock, bun.lockb, *.min.js, *.map";

const FIXED_RULES =
  "Rules (mandatory):\n" +
  "- Output ONLY the raw commit message text (no markdown code fences, no commentary, no intro/outro).\n" +
  "- Do NOT run any commands, tools, or modify any files.";

const MAX_FILES = 1000;
const MAX_COMMITS = 100;

const ICON = {
  branch: "mods/workspace-chrome/branch.svg",
  chevronDown: "mods/workspace-chrome/chevron-down.svg",
  chevronRight: "mods/workspace-chrome/chevron-right.svg",
  plus: "mods/workspace-chrome/plus.svg",
  minus: "mods/workspace-chrome/minus.svg",
  check: "mods/workspace-chrome/check.svg",
  spinner: "mods/workspace-chrome/spinner.svg",
  close: "mods/workspace-chrome/x.svg",
  sparkles: "mods/source-control/icons/sparkles.svg",
  undo: "mods/source-control/icons/undo.svg",
  arrowDown: "mods/source-control/icons/arrow-down.svg",
  arrowUp: "mods/source-control/icons/arrow-up.svg",
  refresh: "mods/source-control/icons/refresh.svg",
  cloud: "mods/source-control/icons/cloud.svg",
  sliders: "mods/source-control/icons/sliders.svg",
  file: "mods/workspace-chrome/file-text.svg",
  diff: "mods/source-control/icons/diff.svg",
  fileFallback: "mods/source-control/icons/file.svg",
  folder: "mods/source-control/icons/folder.svg",
  list: "mods/source-control/icons/list.svg",
  listTree: "mods/source-control/icons/list-tree.svg",
  stash: "mods/source-control/icons/stash.svg",
};

const GIT_STATUS_KEYS = {
  M: "sc.status_M",
  A: "sc.status_A",
  D: "sc.status_D",
  U: "sc.status_U",
  R: "sc.status_R",
  C: "sc.status_C",
  T: "sc.status_T",
  "!": "sc.status_conflict",
};

const gitStatusLabel = (code) =>
  GIT_STATUS_KEYS[code] ? tr(GIT_STATUS_KEYS[code]) : code;

const statusColor = (t, code) =>
  code === "A" || code === "U"
    ? t.ansi2
    : code === "D" || code === "!"
    ? t.ansi1
    : t.ansi3;

const COMMIT_MODES = [
  { id: "commit", labelKey: "sc.commit" },
  { id: "push", labelKey: "sc.commit_push" },
  { id: "amend", labelKey: "sc.commit_amend" },
];

const DRAFTS_KEY = "james-changes.drafts";
const GEN_KEY = "james-changes.generating";
const LAST_REPO_KEY = "james-changes.lastRepoBySpace";
const GEN_TIMEOUT_MS = 180000;

const repoKeyOf = (root, on) =>
  root ? JSON.stringify({ root, on: on ?? null }) : null;

const parentDir = (p) => {
  if (!p) return null;
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : "/";
};

function getDraft(rk) {
  if (!rk) return "";
  return (shared(DRAFTS_KEY) ?? {})[rk] ?? "";
}

function setDraft(rk, text) {
  if (!rk) return;
  const all = { ...(shared(DRAFTS_KEY) ?? {}) };
  if (text) all[rk] = text;
  else delete all[rk];
  setShared(DRAFTS_KEY, all);
}

function isRepoGenerating(rk) {
  if (!rk) return false;
  const entry = (shared(GEN_KEY) ?? {})[rk];
  if (!entry) return false;
  return Date.now() - (entry.at ?? 0) < GEN_TIMEOUT_MS;
}

function setRepoGenerating(rk, active) {
  if (!rk) return;
  const all = { ...(shared(GEN_KEY) ?? {}) };
  if (active) all[rk] = { at: Date.now() };
  else delete all[rk];
  setShared(GEN_KEY, all);
}

function rememberSpaceRepo(spaceId, info) {
  if (!spaceId || !info?.root) return;
  const all = { ...(shared(LAST_REPO_KEY) ?? {}) };
  all[spaceId] = { cwd: info.cwd || info.root, root: info.root, on: info.on ?? null };
  setShared(LAST_REPO_KEY, all);
}

function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const spaceId = space?.id;
  const defaultOn =
    f?.pane === null
      ? f.terminal?.includes("/")
        ? f.terminal.split("/")[0]
        : space?.machine ?? null
      : space?.machine ?? null;

  if (pane?.mod === "better-files") {
    const viewers = Object.values(shared("better-files.viewers") ?? {});
    const match =
      viewers.find((v) => v.tab && v.tab === pane.tab && v.file) ??
      viewers.find((v) => v.space === spaceId && v.file);
    if (match?.file) {
      return {
        cwd: match.file.root || parentDir(match.file.path) || space?.folder,
        on: match.file.on ?? defaultOn,
        spaceId,
        fromMod: true,
      };
    }
  }

  if (pane?.mod === "source-control") {
    const target = (shared("james-changes.diff-tabs") ?? {})[spaceId]?.target;
    if (target?.root) {
      return {
        cwd: target.root,
        on: target.on ?? defaultOn,
        spaceId,
        fromMod: true,
      };
    }
  }

  if (pane?.mod) {
    const last = (shared(LAST_REPO_KEY) ?? {})[spaceId];
    if (last?.root) {
      return { cwd: last.root, on: last.on ?? defaultOn, spaceId, fromMod: true };
    }
    return { cwd: space?.folder, on: defaultOn, spaceId, fromMod: true };
  }

  const cwd = pane?.cwd || f?.cwd;
  if (cwd) {
    return { cwd, on: defaultOn, spaceId, fromMod: false };
  }

  const last = (shared(LAST_REPO_KEY) ?? {})[spaceId];
  if (last?.root) {
    return { cwd: last.root, on: last.on ?? defaultOn, spaceId, fromMod: true };
  }
  return { cwd: space?.folder, on: defaultOn, spaceId, fromMod: false };
}

const key = () => {
  const { cwd, on } = location();
  return JSON.stringify({ cwd, on });
};

const READ = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
];

const countLines = (text) =>
  text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

function cleanAiOutput(raw) {
  let text = (raw ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = /^```(?:text|markdown|gitcommit|commit)?\s*\n([\s\S]*?)\n```$/i.exec(
    text
  );
  if (fence) text = fence[1].trim();
  return text;
}

export default class JamesChanges extends View {
  init(_props, cx) {
    const p = props() ?? _props ?? {};
    if (p.mode === "diff") {
      this.initDiffTab(p, cx);
      return;
    }

    this.conflicts = [];
    this.staged = [];
    this.unstaged = [];
    this.stashes = [];
    this.commits = [];
    this.lanes = 1;
    this.commitFiles = {}; // fullHash -> [{ path, status, add, del }]
    this.expandedCommit = null;
    this.expandedBodyHashes = new Set();
    this.copiedHash = null;
    this.branchFromCommit = null;
    this.branchNameInput = InputState.new({ placeholder: "New branch name…" });
    this.branchNameInput.on("submit", (_e, cx) => {
      if (this.branchFromCommit) {
        this.createBranchFromCommit(this.branchFromCommit, cx);
      }
    });
    this.branch = "";
    this.ahead = 0;
    this.behind = 0;
    this.hasUpstream = false;

    this.collapsed = new Set();
    this.tree = localStorage.getItem("sc.tree") === "1";
    this.allBranches = localStorage.getItem("sc.allBranches") !== "0";

    this.commitHeight = shared("james-changes.commitHeight") ?? 74;
    this.caps = { staged: 160, work: 220 };
    try {
      const saved = JSON.parse(localStorage.getItem("sc.caps") ?? "{}");
      if (saved.staged >= 84) this.caps.staged = saved.staged;
      if (saved.work >= 84) this.caps.work = saved.work;
    } catch {}
    this.listHeight = null;
    this.drag = null;
    this.resizingCommit = null;
    this.hoverCommitResizer = false;

    this.hot = null;
    this.wheelAt = 0;
    this.asking = null; // { text, actions: [args[]] }
    this.commitMode = "commit"; // "commit" | "push" | "amend"
    this.showCommitMenu = false;
    this.repoKey = null;
    this.spaceId = null;
    this.message = "";
    this.open = null; // { path, staged, commit? }
    this.lastOpened = null;
    this.handle = cx.focus_handle();

    this.input = TextareaState.new({
      placeholder: tr("sc.composer_placeholder"),
      rows: 3,
    });
    this.input.on("change", (_e, cx) => {
      const prev = Boolean(this.message.trim());
      this.message = this.input.value();
      if (this.repoKey) setDraft(this.repoKey, this.message);
      if (prev !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("focus", (_e, cx) => {
      this.typing = true;
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      this.typing = false;
      cx.notify();
    });

    if (checking()) return;
    followFileIcons(this, cx);
    this.refresh(cx);
    cx.timer.every(10000, (timerCx) => this.refresh(timerCx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch {
        this.watched = null;
      }
    });
  }

  isGenerating() {
    return isRepoGenerating(this.repoKey);
  }

  switchRepo(nextRepoKey) {
    if (this.repoKey === nextRepoKey) return;
    if (this.repoKey) setDraft(this.repoKey, this.message);
    this.repoKey = nextRepoKey;
    this.conflicts = [];
    this.staged = [];
    this.unstaged = [];
    this.stashes = [];
    this.commits = [];
    this.lanes = 1;
    this.commitFiles = {};
    this.expandedCommit = null;
    this.branchFromCommit = null;
    this.open = null;
    this.lastOpened = null;
    this.asking = null;
    this.note = null;
    this.watched = null;
    const savedDraft = getDraft(nextRepoKey);
    this.message = savedDraft;
    this.input.set_value(savedDraft);
  }

  refresh(cx) {
    if (this.loading) {
      this.dirty = true;
      return;
    }
    if (this.busy) return;
    const loc = location();
    const { cwd, on, spaceId, fromMod } = loc;
    const context = key();
    this.context = context;
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], {
          cwd,
          on,
        });
        if (key() !== context) return;
        if (top.code !== 0) {
          // If focus is on a mod tab (e.g., file viewer / notes) and we already have a repo
          // in this space, keep showing that repo instead of flashing "Not a git repository".
          if (fromMod && this.root && this.spaceId === spaceId) {
            return;
          }
          this.switchRepo(null);
          this.root = null;
          this.spaceId = spaceId;
          this.error = tr("sc.not_git");
          return;
        }
        const root = top.stdout.trim();
        const nextRepoKey = repoKeyOf(root, on);
        if (nextRepoKey !== this.repoKey) {
          this.switchRepo(nextRepoKey);
        } else if (!this.typing) {
          const savedDraft = getDraft(nextRepoKey);
          if (savedDraft && savedDraft !== this.message) {
            this.message = savedDraft;
            this.input.set_value(savedDraft);
          }
        }
        this.spaceId = spaceId;
        rememberSpaceRepo(spaceId, { cwd, root, on });
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });

        const logArgs = [
          "log",
          "--topo-order",
          "--decorate=full",
          "-n",
          String(MAX_COMMITS),
          ...(this.allBranches ? ["--branches", "--remotes", "--tags", "HEAD"] : ["HEAD"]),
          "--format=%H%x1f%P%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s%x1f%b%x1e",
        ];

        const [status, head, branchRes, upstreamRes, logRes] = await Promise.all([
          git([
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
          ]),
          git(["rev-parse", "--verify", "HEAD"]),
          git(["symbolic-ref", "--short", "HEAD"]),
          git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
          git(logArgs),
        ]);

        if (status.code !== 0) throw new Error(status.stderr);

        this.branch =
          branchRes.code === 0 ? branchRes.stdout.trim() : "detached";
        if (upstreamRes.code === 0) {
          const [a, b] = upstreamRes.stdout.trim().split(/\s+/);
          this.ahead = Number(a) || 0;
          this.behind = Number(b) || 0;
          this.hasUpstream = true;
        } else {
          this.ahead = 0;
          this.behind = 0;
          this.hasUpstream = false;
        }

        const [cachedNum, workNum, unpushedRes, stashRes] = await Promise.all([
          git(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
          git(["diff", "--numstat", "-z", "--no-renames"]),
          this.hasUpstream && this.ahead > 0
            ? git(["rev-list", "@{upstream}..HEAD"])
            : Promise.resolve({ code: 1, stdout: "" }),
          git(["stash", "list", "--format=%gd%x1f%gs%x1f%cr"]),
        ]);

        const parseStats = (res) => {
          const map = {};
          if (res.code !== 0) return map;
          for (const entry of res.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const p = parts.join("\t");
            map[p] = {
              add: Number(a) || 0,
              del: Number(d) || 0,
              binary: a === "-",
            };
          }
          return map;
        };

        const stagedStats = parseStats(cachedNum);
        const unstagedStats = parseStats(workNum);

        const conflicts = [];
        const staged = [];
        const unstaged = [];
        const entries = status.stdout.split("\0").filter(Boolean);

        for (const entry of entries.slice(0, MAX_FILES)) {
          const x = entry[0];
          const y = entry[1];
          const path = entry.slice(3);
          const fresh = x === "?" && y === "?";
          const isConflict =
            x === "U" ||
            y === "U" ||
            (x === "A" && y === "A") ||
            (x === "D" && y === "D");

          if (isConflict) {
            conflicts.push({
              path,
              status: "!",
              conflict: true,
              staged: false,
              fresh: false,
              add: 0,
              del: 0,
            });
            continue;
          }

          if (!fresh && x !== " " && x !== "?") {
            const stat = stagedStats[path] ?? { add: 0, del: 0 };
            staged.push({
              path,
              status: x,
              staged: true,
              fresh: false,
              ...stat,
            });
          }
          if (fresh || (y !== " " && y !== "?")) {
            const stat = unstagedStats[path] ?? { add: 0, del: 0 };
            unstaged.push({
              path,
              status: fresh ? "U" : y,
              staged: false,
              fresh,
              ...stat,
            });
          }
        }

        const stashes =
          stashRes.code === 0
            ? stashRes.stdout
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean)
                .map((line) => {
                  const [ref, msg, time] = line.split("\x1f");
                  return {
                    ref: ref ?? "",
                    message: msg ?? "",
                    time: time ?? "",
                  };
                })
            : [];

        const freshFiles = unstaged.filter((f) => f.fresh).slice(0, 100);
        if (freshFiles.length > 0) {
          await Promise.all(
            freshFiles.map(async (f) => {
              const txt = await readTextFile(`${root}/${f.path}`, { on }).catch(
                () => null
              );
              if (txt !== null && !txt.includes("\0")) {
                f.add = countLines(txt);
              }
            })
          );
        }

        const unpushedSet = new Set(
          unpushedRes.code === 0
            ? unpushedRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
            : []
        );
        const commits =
          head.code === 0 && logRes.code === 0
            ? parseGraphLog(logRes.stdout).map((c) => ({
                ...c,
                unpushed: unpushedSet.has(c.fullHash),
              }))
            : [];
        const lanes = commits.length ? layoutGraph(commits) : 1;

        if (key() !== context) return;
        this.root = root;
        this.on = on;
        this.hasHead = head.code === 0;
        this.conflicts = conflicts;
        this.staged = staged;
        this.unstaged = unstaged;
        this.stashes = stashes;
        this.commits = commits;
        this.lanes = lanes;
        this.error = null;
        this.watch(root, cx);

        const allFiles = [...conflicts, ...staged, ...unstaged];
        if (
          this.open &&
          !this.open.commit &&
          !allFiles.some(
            (f) => f.path === this.open.path && f.staged === this.open.staged
          )
        ) {
          this.open = null;
        }
      } catch (e) {
        if (key() === context) this.error = String(e);
      } finally {
        this.loading = false;
        if (this.dirty) {
          this.dirty = false;
          this.refresh(cx);
        }
        cx.notify();
      }
    });
  }

  // Diffs open in a centre tab (see diff-tab.js); `this.open` marks the row.
  pickFile(path, staged, cx, commit = null) {
    const list = commit
      ? this.commitFiles[commit] ?? []
      : staged
      ? this.staged
      : this.unstaged;
    const file = list.find((f) => f.path === path);
    const c = commit
      ? this.commits.find((x) => x.fullHash === commit || x.hash === commit)
      : null;
    this.open = { path, staged, commit };
    this.note = null;
    openDiffTab({
      root: this.root,
      on: this.on ?? null,
      path,
      staged: Boolean(staged),
      fresh: Boolean(file?.fresh),
      status: file?.status ?? null,
      commit: c?.fullHash ?? commit,
      short: c?.hash ?? commit,
      subject: c?.subject ?? null,
      peers: list.map((x) => ({
        path: x.path,
        staged: Boolean(staged),
        fresh: Boolean(x.fresh),
        status: x.status ?? null,
      })),
    });
    cx.notify();
  }

  // Working-tree files open in Better Files' viewer (its gutter marks the changes).
  // Deleted files have nothing on disk, so they fall back to the centre diff tab.
  openFile(f, cx, keep = false) {
    if (f.status === "D" || !this.root) {
      this.pickFile(f.path, f.staged, cx);
      return;
    }
    openInBetterFiles({ root: this.root, relative: f.path, on: this.on, keep });
    this.lastOpened = f.path;
    cx.notify();
  }

  fileIconEl(path, color, t, size = 15) {
    const picture = fileIcon(this.fileIcons, path, {
      light: isLight(t.background),
    });
    if (picture) return image(picture).size(size).flex_none();
    return svg(ICON.fileFallback).size(size).flex_none().text_color(color);
  }

  folderIconEl(path, open, t, size = 15) {
    const picture = fileIcon(this.fileIcons, path, {
      dir: true,
      open,
      light: isLight(t.background),
    });
    if (picture) return image(picture).size(size).flex_none();
    return svg(ICON.folder).size(size).flex_none().text_color(t.muted);
  }

  toggleCommitExpand(fullHash, cx) {
    if (this.expandedCommit === fullHash) {
      this.expandedCommit = null;
      if (this.open?.commit === fullHash) this.open = null;
      cx.notify();
      return;
    }
    this.expandedCommit = fullHash;
    if (this.commitFiles[fullHash]) {
      cx.notify();
      return;
    }
    const root = this.root;
    const on = this.on;
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        const [statRes, statusRes] = await Promise.all([
          exec(
            "git",
            [
              ...READ,
              "show",
              "--diff-merges=first-parent",
              "--numstat",
              "--format=",
              "-z",
              fullHash,
            ],
            { cwd: root, on }
          ),
          exec(
            "git",
            [
              ...READ,
              "show",
              "--diff-merges=first-parent",
              "--name-status",
              "--format=",
              "-z",
              fullHash,
            ],
            { cwd: root, on }
          ),
        ]);
        const statusMap = {};
        if (statusRes.code === 0) {
          const tokens = statusRes.stdout.split("\0").filter(Boolean);
          for (let i = 0; i < tokens.length; ) {
            const code = tokens[i][0] || "M";
            if ((code === "R" || code === "C") && i + 2 < tokens.length) {
              statusMap[tokens[i + 2]] = code;
              i += 3;
            } else if (i + 1 < tokens.length) {
              statusMap[tokens[i + 1]] = code;
              i += 2;
            } else {
              break;
            }
          }
        }
        const files = [];
        if (statRes.code === 0) {
          const entries = statRes.stdout.split("\0");
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!entry) continue;
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            let path = parts.join("\t");
            // With -z, renames/copies emit `add\tdel\t` followed by oldPath and newPath.
            if (!path && i + 2 < entries.length) {
              path = entries[i + 2];
              i += 2;
            }
            if (!path) continue;
            files.push({
              path,
              status: statusMap[path] ?? "M",
              add: Number(a) || 0,
              del: Number(d) || 0,
            });
          }
        }
        if (key() === context) {
          this.commitFiles[fullHash] = files;
          cx.notify();
        }
      } catch {
        if (key() === context) {
          this.commitFiles[fullHash] = [];
          cx.notify();
        }
      }
    });
    cx.notify();
  }

  gitActions(argsList, cx, label = "Git command") {
    if (!this.root || this.busy || !argsList.length) return;
    const root = this.root;
    const on = this.on;
    const isRemoteOp = label === "Pull" || label === "Push" || label === "Fetch";
    const branchName = this.branch || "current branch";
    this.busy = true;
    this.busyAction = label;
    this.note = null;
    this.asking = null;
    if (isRemoteOp) {
      notify({
        title: tr("sc.in_progress", { action: label }),
        body:
          label === "Push"
            ? tr("sc.pushing_msg", { branch: branchName })
            : label === "Pull"
            ? tr("sc.pulling_msg", { branch: branchName })
            : tr("sc.fetching_msg"),
      });
    }
    cx.spawn(async (cx) => {
      try {
        for (const args of argsList) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0)
            throw new Error((r.stderr || r.stdout || `${label} failed`).trim());
        }
        if (isRemoteOp) {
          notify({
            title: tr("sc.completed", { action: label }),
            body:
              label === "Push"
                ? tr("sc.pushed_ok")
                : label === "Pull"
                ? tr("sc.pulled_ok")
                : tr("sc.fetched_ok"),
          });
        }
      } catch (e) {
        this.note = String(e);
        if (isRemoteOp) {
          notify({
            title: tr("sc.failed", { action: label }),
            body: String(e),
            level: "error",
          });
        }
      } finally {
        this.busy = false;
        this.busyAction = null;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  gitAction(args, cx, label = "Git command") {
    this.gitActions([args], cx, label);
  }

  stageFile(path, cx) {
    this.gitAction(["add", "--", path], cx, "Stage");
  }

  unstageFile(path, cx) {
    this.gitAction(
      this.hasHead
        ? ["reset", "HEAD", "--", path]
        : ["rm", "--cached", "--", path],
      cx,
      "Unstage"
    );
  }

  stageAll(cx) {
    this.gitAction(["add", "-A"], cx, "Stage all");
  }

  unstageAll(cx) {
    this.gitAction(
      this.hasHead ? ["reset", "HEAD"] : ["rm", "-r", "--cached", "."],
      cx,
      "Unstage all"
    );
  }

  askConfirm(text, confirmLabel, actions, label, cx) {
    this.asking = { text, confirmLabel, actions, label };
    cx.notify();
  }

  askDiscard(files, cx) {
    const tracked = files.filter((f) => !f.fresh).map((f) => f.path);
    const fresh = files.filter((f) => f.fresh).map((f) => f.path);
    const actions = [
      ...(tracked.length ? [["checkout", "--", ...tracked]] : []),
      ...(fresh.length ? [["clean", "-f", "--", ...fresh]] : []),
    ];
    if (!actions.length) return;
    const one = files.length === 1 ? files[0].path.split("/").pop() : null;
    const text = one
      ? fresh.length
        ? `Delete untracked file "${one}"?`
        : `Discard changes to "${one}"?`
      : `Discard ${tracked.length} changed${
          fresh.length ? ` and delete ${fresh.length} untracked` : ""
        } files?`;
    this.askConfirm(
      `${text} This cannot be undone.`,
      tr("sc.confirm_discard"),
      actions,
      "Discard changes",
      cx
    );
  }

  stashPush(cx) {
    this.gitAction(
      ["stash", "push", "-u", "-m", `WIP on ${this.branch || "HEAD"}`],
      cx,
      "Stash"
    );
  }

  stashApply(ref, cx) {
    this.gitAction(["stash", "apply", ref], cx, "Apply stash");
  }

  stashPop(ref, cx) {
    this.gitAction(["stash", "pop", ref], cx, "Pop stash");
  }

  askStashDrop(ref, cx) {
    this.askConfirm(
      `Drop ${ref}? This cannot be undone.`,
      "Drop",
      [["stash", "drop", ref]],
      "Drop stash",
      cx
    );
  }

  createBranchFromCommit(fullHash, cx) {
    const name = this.branchNameInput.value().trim();
    if (!name || name.startsWith("-")) return;
    this.branchFromCommit = null;
    this.branchNameInput.set_value("");
    this.gitAction(["switch", "-c", name, fullHash], cx, "Create branch");
  }

  selectCommitMode(modeId, cx) {
    this.commitMode = modeId;
    this.showCommitMenu = false;
    if (
      modeId === "amend" &&
      !this.message.trim() &&
      this.root &&
      this.hasHead
    ) {
      const root = this.root;
      const on = this.on;
      cx.spawn(async (cx) => {
        const r = await exec("git", [...READ, "log", "-1", "--format=%B"], {
          cwd: root,
          on,
        });
        if (r.code === 0 && !this.message.trim()) {
          const msg = r.stdout.trim();
          this.message = msg;
          this.input.set_value(msg);
          if (this.repoKey) setDraft(this.repoKey, msg);
          cx.notify();
        }
      });
    }
    cx.notify();
  }

  runCommit(cx) {
    const isAmend = this.commitMode === "amend";
    const andPush = this.commitMode === "push";
    const allFiles = [...this.staged, ...this.unstaged];
    if (
      !this.message.trim() ||
      !this.root ||
      this.busy ||
      this.loading ||
      this.context !== key() ||
      (allFiles.length === 0 && !isAmend)
    )
      return;

    const root = this.root;
    const on = this.on;
    const targetRepoKey = this.repoKey;
    const message = this.message.trim();
    const shouldStageAll = this.staged.length === 0 && !isAmend;
    const commitArgs = [
      "commit",
      ...(isAmend ? ["--amend"] : []),
      "-m",
      message,
    ];

    this.busy = true;
    this.busyAction = andPush ? "Push" : "Commit";
    this.note = null;
    this.showCommitMenu = false;
    if (andPush) {
      notify({
        title: tr("sc.commit_push_progress"),
        body: tr("sc.commit_push_progress_body", {
          branch: this.branch || "changes",
        }),
      });
    }
    cx.spawn(async (cx) => {
      try {
        if (shouldStageAll) {
          const addRes = await exec("git", ["add", "-A"], { cwd: root, on });
          if (addRes.code !== 0)
            throw new Error((addRes.stderr || addRes.stdout).trim());
        }
        const comRes = await exec("git", commitArgs, { cwd: root, on });
        if (comRes.code !== 0)
          throw new Error((comRes.stderr || comRes.stdout).trim());

        setDraft(targetRepoKey, "");
        if (this.repoKey === targetRepoKey) {
          this.message = "";
          this.input.set_value("");
          if (this.commitMode === "amend") this.commitMode = "commit";
        }

        if (andPush) {
          const pushArgs = this.hasUpstream
            ? ["push"]
            : ["push", "-u", "origin", "HEAD"];
          const pushRes = await exec("git", pushArgs, { cwd: root, on });
          if (pushRes.code !== 0)
            throw new Error((pushRes.stderr || pushRes.stdout).trim());
          notify({
            title: tr("sc.commit_push_done"),
            body: tr("sc.commit_push_done_body"),
          });
        }
      } catch (e) {
        if (this.repoKey === targetRepoKey)
          this.note = `${
            andPush ? tr("sc.commit_push") : tr("sc.commit")
          }: ${e}`;
        if (andPush) {
          notify({
            title: tr("sc.commit_push_fail"),
            body: String(e),
            level: "error",
          });
        }
      } finally {
        this.busy = false;
        this.busyAction = null;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  generateAiCommit(cx) {
    if (!this.root || !this.repoKey || this.isGenerating()) return;
    const aiCfg = shared("james-changes.ai") ?? {};
    const provider = (aiCfg.provider || "").trim();
    if (!provider) {
      openOverlay({
        mod: "james-settings",
        kind: "dialog",
        width: 600,
        height: 500,
        props: { section: "ai-commit" },
      });
      return;
    }
    const targetRepoKey = this.repoKey;
    const root = this.root;
    const on = this.on;
    const useStaged = this.staged.length > 0;
    const freshSnapshot = this.unstaged.filter((u) => u.fresh).slice(0, 12);
    const model = (aiCfg.model || "").trim();
    const ollamaUrl = ((aiCfg.ollamaUrl || "").trim() || "http://127.0.0.1:11434").replace(/\/+$/, "");
    const activeSpace = spaces().find((s) => s.active);
    const spaceKey = activeSpace?.folder || root || activeSpace?.id || "";
    const spaceCfg =
      aiCfg.spaces?.[spaceKey] ??
      aiCfg.spaces?.[root] ??
      (activeSpace?.id ? aiCfg.spaces?.[activeSpace.id] : null) ??
      {};
    const promptText = (
      spaceCfg.prompt?.trim() ||
      aiCfg.prompt?.trim() ||
      DEFAULT_PROMPT
    ).trim();
    const rawGlobalIgnore =
      aiCfg.ignore !== undefined ? aiCfg.ignore : DEFAULT_IGNORE;
    const ignorePatterns = [rawGlobalIgnore, spaceCfg.ignore || ""]
      .join(",")
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const excludeSpec = ignorePatterns.length
      ? ["--", ".", ...ignorePatterns.map((p) => `:(glob,exclude)${p}`)]
      : [];

    setRepoGenerating(targetRepoKey, true);
    this.note = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const [statusRes, statRes, diffRes] = await Promise.all([
          exec(
            "git",
            useStaged
              ? [...READ, "diff", "--cached", "--name-status"]
              : [...READ, "status", "--short"],
            { cwd: root, on }
          ),
          exec(
            "git",
            useStaged
              ? [...READ, "diff", "--cached", "--stat", ...excludeSpec]
              : [...READ, "diff", "HEAD", "--stat", ...excludeSpec],
            { cwd: root, on }
          ),
          exec(
            "git",
            useStaged
              ? [
                  ...READ,
                  "diff",
                  "--cached",
                  "--no-color",
                  "--no-ext-diff",
                  ...excludeSpec,
                ]
              : [
                  ...READ,
                  "diff",
                  "HEAD",
                  "--no-color",
                  "--no-ext-diff",
                  ...excludeSpec,
                ],
            { cwd: root, on }
          ),
        ]);

        let diffText = (diffRes.stdout || "").trim();
        if (!useStaged && !diffText && freshSnapshot.length > 0) {
          const previews = [];
          for (const f of freshSnapshot) {
            const content = await readTextFile(`${root}/${f.path}`, {
              on,
            }).catch(() => "");
            previews.push(
              `--- New file: ${f.path} ---\n${(content ?? "").slice(0, 1200)}`
            );
          }
          diffText = previews.join("\n\n");
        }

        const statusOut = (statusRes.stdout || "").trim();
        const statOut = (statRes.stdout || "").trim();
        if (!diffText && !statusOut && !statOut) {
          throw new Error("No uncommitted changes to analyze.");
        }
        if (!diffText && statusOut) {
          diffText =
            "(Diff omitted by ignore patterns; analyze git status above.)";
        }

        const MAX_DIFF = 16000;
        let balancedDiff = diffText;
        if (diffText.length > MAX_DIFF) {
          const chunks = diffText.split(/(?=^diff --git )/m).filter(Boolean);
          if (chunks.length > 1) {
            const perFile = Math.max(600, Math.floor(MAX_DIFF / chunks.length));
            balancedDiff = chunks
              .map((c) =>
                c.length > perFile
                  ? c.slice(0, perFile) + "\n… (file diff truncated)"
                  : c
              )
              .join("\n")
              .slice(0, MAX_DIFF);
          } else {
            balancedDiff = diffText.slice(0, MAX_DIFF);
          }
        }

        const fullPrompt =
          `${promptText}\n\n` +
          `${FIXED_RULES}\n\n` +
          `Git status (${useStaged ? "staged only" : "working tree"}):\n${statusOut}\n\n` +
          (statOut ? `Diff stat:\n${statOut}\n\n` : "") +
          `Git diff:\n${balancedDiff}`;

        const pathPrefix =
          'export PATH="$HOME/.local/share/mise/installs/antigravity-cli/latest:$HOME/.local/share/mise/command-wrappers/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:$PATH"; ';

        let cmd;
        if (provider === "agy") {
          cmd =
            pathPrefix +
            'REAL_HOME="$HOME"; ' +
            "TMP_HOME=$(mktemp -d /tmp/agy-commit-XXXXXX); " +
            'trap \'rm -rf "$TMP_HOME"\' EXIT INT TERM; ' +
            'ln -s "$REAL_HOME/.config" "$TMP_HOME/.config" 2>/dev/null || true; ' +
            'ln -s "$REAL_HOME/.local" "$TMP_HOME/.local" 2>/dev/null || true; ' +
            'mkdir -p "$TMP_HOME/.gemini/antigravity-cli"; ' +
            'ln -s "$REAL_HOME/.gemini/config" "$TMP_HOME/.gemini/config" 2>/dev/null || true; ' +
            'ln -s "$REAL_HOME/.gemini/oauth_creds.json" "$TMP_HOME/.gemini/oauth_creds.json" 2>/dev/null || true; ' +
            'ln -s "$REAL_HOME/.gemini/google_accounts.json" "$TMP_HOME/.gemini/google_accounts.json" 2>/dev/null || true; ' +
            'ln -s "$REAL_HOME/.gemini/antigravity-cli/settings.json" "$TMP_HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null || true; ' +
            'HOME="$TMP_HOME" agy -p "$AI_PROMPT" --disable-slash-commands --log-file "$TMP_HOME/run.log"' +
            (model ? ' --model "$AI_MODEL"' : "");
        } else if (provider === "claude") {
          cmd =
            pathPrefix +
            `claude -p "$AI_PROMPT" --no-session-persistence` +
            (model ? ` --model "$AI_MODEL"` : "");
        } else if (provider === "codex") {
          cmd =
            pathPrefix +
            `codex exec --ephemeral "$AI_PROMPT"` +
            (model ? ` -m "$AI_MODEL"` : "");
        } else if (provider === "ollama") {
          cmd =
            pathPrefix +
            'M="$AI_MODEL"; ' +
            'if [ -z "$M" ]; then ' +
            '  M=$(curl -sf --max-time 3 "$OLLAMA_URL/api/tags" 2>/dev/null | jq -r ".models[0].name // empty" 2>/dev/null || true); ' +
            'fi; ' +
            'if [ -z "$M" ]; then ' +
            '  echo "Could not find an Ollama model at $OLLAMA_URL (make sure ollama serve is running and a model is pulled)." >&2; exit 1; ' +
            'fi; ' +
            'PAYLOAD=$(jq -nc --arg model "$M" --arg prompt "$AI_PROMPT" "{model: \\$model, prompt: \\$prompt, stream: false}"); ' +
            'RESP=$(curl -sS --max-time 120 -H "Content-Type: application/json" -d "$PAYLOAD" "$OLLAMA_URL/api/generate") || exit 1; ' +
            'ERR=$(printf "%s" "$RESP" | jq -r ".error // empty" 2>/dev/null || true); ' +
            'if [ -n "$ERR" ]; then printf "%s\\n" "$ERR" >&2; exit 1; fi; ' +
            'printf "%s" "$RESP" | jq -r ".response // empty"';
        } else {
          cmd =
            pathPrefix +
            `opencode run "$AI_PROMPT"` +
            (model ? ` -m "$AI_MODEL"` : "");
        }

        const r = await exec(
          "env",
          [
            `AI_PROMPT=${fullPrompt}`,
            `AI_MODEL=${model}`,
            `OLLAMA_URL=${ollamaUrl}`,
            "sh",
            "-c",
            cmd,
          ],
          { cwd: root, on, timeout: 120000 }
        );

        if (r.code !== 0) {
          throw new Error(
            (r.stderr || r.stdout || `${provider} failed`).trim()
          );
        }

        const generated = cleanAiOutput(r.stdout);
        if (!generated) throw new Error("LLM returned an empty response.");

        setDraft(targetRepoKey, generated);
        if (this.repoKey === targetRepoKey) {
          this.message = generated;
          this.input.set_value(generated);
        } else {
          notify({
            title: "AI Commit Ready",
            body: generated.split("\n")[0],
          });
        }
      } catch (e) {
        if (this.repoKey === targetRepoKey) {
          this.note = `AI generation error: ${e}`;
        } else {
          notify({
            title: "AI Commit Failed",
            body: String(e),
            level: "error",
          });
        }
      } finally {
        setRepoGenerating(targetRepoKey, false);
        cx.notify();
      }
    });
  }

  // ── UI helpers ────────────────────────────────────────────────────────────
  flip(id, cx) {
    this.collapsed.has(id) ? this.collapsed.delete(id) : this.collapsed.add(id);
    cx.notify();
  }

  setHover(id, on, cx) {
    const next = on ? id : this.hot === id ? null : this.hot;
    if (next === this.hot) return;
    this.hot = next;
    if (Date.now() - this.wheelAt > 250) cx.notify();
  }

  endDrag(cx) {
    if (!this.drag) return;
    const moved = this.drag.moved;
    this.drag = null;
    if (moved) localStorage.setItem("sc.caps", JSON.stringify(this.caps));
    cx.notify();
  }

  iconBtn(id, iconPath, tip, fn, t, { spin = false, color = null, size = 13 } = {}) {
    return div()
      .id(id)
      .size(22)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(5)
      .cursor_pointer()
      .text_color(color ?? t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .active((s) => s.bg(t.selected))
      .tooltip(tip)
      .on_mouse_down("left", (_ev, cx) => {
        cx.stop_propagation();
        fn(cx);
      })
      .child(svg(iconPath).size(size).when(spin, (e) => e.spin(900)));
  }

  // ── Header: Title + Branch + Pull/Push Sync + List/Tree + Refresh ─────────
  renderHeader(t) {
    const { cwd, spaceId } = location();
    const pulling = this.busy && this.busyAction === "Pull";
    const pushing = this.busy && this.busyAction === "Push";

    const syncPill = (id, iconPath, count, tip, running, onDown) => {
      const hot = count > 0;
      return h_flex()
        .id(id)
        .h(22)
        .px(hot ? 6 : 5)
        .gap(3)
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(5)
        .cursor_pointer()
        .when(hot, (e) => e.bg(t.accent + "22"))
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .active((s) => s.bg(t.selected))
        .tooltip(tip)
        .on_mouse_down("left", (_ev, cx) => {
          cx.stop_propagation();
          onDown(cx);
        })
        .child(
          running
            ? svg(ICON.spinner).size(12).text_color(t.accent).spin(900)
            : svg(iconPath)
                .size(12)
                .text_color(hot ? t.accent : t.muted)
        )
        .when(hot, (e) =>
          e.child(
            div()
              .text_size(10.5)
              .font_weight(600)
              .text_color(t.accent)
              .child(String(count))
          )
        );
    };

    return h_flex()
      .h(40)
      .flex_none()
      .pl(12)
      .pr(8)
      .gap(4)
      .items_center()
      .rounded_t(9)
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome ?? t.background)
      .child(
        div()
          .flex_none()
          .font_semibold()
          .text_size(13)
          .text_color(t.foreground)
          .child(tr("sc.title"))
      )
      .child(
        h_flex()
          .id("sc-branch-btn")
          .flex_1()
          .min_w(0)
          .h(24)
          .px(6)
          .gap(4)
          .rounded(5)
          .items_center()
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(tr("sc.switch_branch"))
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            openOverlay({
              mod: "worktree",
              kind: "dialog",
              width: 560,
              height: 480,
              props: { space: spaceId, folder: cwd, action: "open" },
            });
          })
          .child(svg(ICON.branch).size(12).flex_none().text_color(t.accent))
          .child(
            div()
              .min_w(0)
              .truncate()
              .text_size(12)
              .font_weight(500)
              .text_color(t.accent)
              .child(this.branch || "git")
          )
      )
      .child(
        syncPill(
          "sc-hdr-pull",
          ICON.arrowDown,
          this.behind,
          this.behind > 0 ? `${tr("sc.pull")} (${this.behind})` : tr("sc.pull"),
          pulling,
          (cx) => this.gitAction(["pull", "--ff-only"], cx, "Pull")
        )
      )
      .child(
        syncPill(
          "sc-hdr-push",
          ICON.arrowUp,
          this.ahead,
          this.ahead > 0 ? `${tr("sc.push")} (${this.ahead})` : tr("sc.push"),
          pushing,
          (cx) =>
            this.gitAction(
              this.hasUpstream ? ["push"] : ["push", "-u", "origin", "HEAD"],
              cx,
              "Push"
            )
        )
      )
      .child(
        this.iconBtn(
          "sc-view-toggle",
          this.tree ? ICON.list : ICON.listTree,
          this.tree ? tr("sc.view_list") : tr("sc.view_tree"),
          (cx) => {
            this.tree = !this.tree;
            localStorage.setItem("sc.tree", this.tree ? "1" : "0");
            cx.notify();
          },
          t
        )
      )
      .child(
        this.iconBtn(
          "sc-refresh-btn",
          ICON.refresh,
          tr("sc.refresh"),
          (cx) => this.refresh(cx),
          t,
          { spin: Boolean(this.loading) }
        )
      );
  }

  // ── Commit Composer ───────────────────────────────────────────────────────
  renderComposer(t, canCommit, activeModeObj) {
    const generating = this.isGenerating();
    const dropdownArrowBtn = h_flex()
      .id("sc-commit-dropdown-btn")
      .w(28)
      .h_full()
      .items_center()
      .justify_center()
      .cursor_pointer()
      .hover((s) => s.opacity(0.85))
      .tooltip(tr("sc.more_commit_actions"))
      .on_mouse_down("left", (_ev, cx) => {
        cx.stop_propagation();
        this.showCommitMenu = !this.showCommitMenu;
        cx.notify();
      })
      .child(
        svg(ICON.chevronDown)
          .size(12)
          .text_color(canCommit ? t.solid_foreground : t.muted)
      );

    const splitCommitButton = h_flex()
      .id("sc-commit-split-bar")
      .h(29)
      .w_full()
      .rounded(7)
      .overflow_hidden()
      .border_1()
      .border_color(canCommit ? t.accent : t.border)
      .bg(canCommit ? t.solid : t.raised)
      .child(
        h_flex()
          .id("sc-commit-main-btn")
          .flex_1()
          .h_full()
          .gap(6)
          .items_center()
          .justify_center()
          .text_size(12)
          .font_weight(500)
          .text_color(canCommit ? t.solid_foreground : t.dim)
          .when(canCommit, (e) =>
            e.cursor_pointer().hover((s) => s.opacity(0.9))
          )
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            this.runCommit(cx);
          })
          .child(
            this.busy && (this.busyAction === "Commit" || this.busyAction === "Push")
              ? svg(ICON.spinner)
                  .size(12)
                  .text_color(canCommit ? t.solid_foreground : t.dim)
                  .spin(900)
              : svg(ICON.check)
                  .size(13)
                  .text_color(canCommit ? t.solid_foreground : t.dim)
          )
          .child(
            div().child(
              this.busy ? tr("sc.working") : tr(activeModeObj.labelKey)
            )
          )
      )
      .child(
        div()
          .w(1)
          .h_full()
          .bg(canCommit ? t.background + "44" : t.border)
      )
      .child(dropdownArrowBtn);

    return v_flex()
      .flex_none()
      .px(8)
      .pt(8)
      .pb(6)
      .gap(6)
      .border_b(1)
      .border_color(t.border)
      .bg(t.background)
      .child(
        div()
          .id("sc-commit-input-wrapper")
          .h(this.commitHeight)
          .p(7)
          .relative()
          .rounded(8)
          .border_1()
          .border_color(this.typing ? t.accent : t.border)
          .when(!this.typing, (e) =>
            e.hover((s) => s.border_color(t.input ?? t.muted))
          )
          .bg(t.canvas ?? t.background)
          .cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(
            Textarea.new(this.input)
              .size_full()
              .text_size(12)
              .text_color(t.foreground)
          )
          .when(this.message.length > 0, (el) => {
            const firstLen = this.message.split("\n")[0].length;
            const over = firstLen > 72;
            return el.child(
              div()
                .absolute()
                .left(8)
                .bottom(7)
                .text_size(10)
                .text_color(over ? t.ansi3 : t.dim)
                .child(`${firstLen}/72`)
            );
          })
          .child(
            h_flex()
              .absolute()
              .right(6)
              .bottom(6)
              .gap(4)
              .items_center()
              .child(
                h_flex()
                  .id("sc-ai-space-cfg")
                  .w(22)
                  .h(22)
                  .rounded(5)
                  .items_center()
                  .justify_center()
                  .border_1()
                  .border_color(t.border)
                  .bg(t.raised)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .tooltip("AI Commit Settings")
                  .on_mouse_down("left", (_ev, cx) => {
                    cx.stop_propagation();
                    const activeSpace = spaces().find((s) => s.active);
                    const spaceKey =
                      activeSpace?.folder ||
                      this.root ||
                      activeSpace?.id ||
                      "__global__";
                    openOverlay({
                      mod: "james-settings",
                      kind: "dialog",
                      width: 600,
                      height: 500,
                      props: { section: "ai-commit", spaceKey },
                    });
                  })
                  .child(svg(ICON.sliders).size(11).text_color(t.muted))
              )
              .child(
                h_flex()
                  .id("sc-ai-generate-btn")
                  .h(22)
                  .px(8)
                  .gap(4)
                  .rounded(5)
                  .items_center()
                  .border_1()
                  .border_color(t.border)
                  .bg(t.raised)
                  .text_size(11)
                  .text_color(generating ? t.accent : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_mouse_down("left", (_ev, cx) => {
                    cx.stop_propagation();
                    this.generateAiCommit(cx);
                  })
                  .child(
                    generating
                      ? svg(ICON.spinner).size(11).text_color(t.accent).spin(900)
                      : svg(ICON.sparkles).size(11).text_color(t.accent)
                  )
                  .child(
                    div().child(
                      generating ? tr("sc.generating") : tr("sc.generate")
                    )
                  )
              )
          )
          .child(
            div()
              .id("sc-textarea-edge-resizer")
              .absolute()
              .left(0)
              .right(0)
              .bottom(0)
              .h(4)
              .cursor_row_resize()
              .on_hover((hovered, cx) => {
                this.hoverCommitResizer = hovered;
                cx.notify();
              })
              .on_mouse_down("left", (e, cx) => {
                cx.stop_propagation();
                this.resizingCommit = {
                  startY: e.position.y,
                  startH: this.commitHeight,
                };
                cx.notify();
              })
          )
      )
      .child(
        Popup.new("sc-commit-actions-popup", splitCommitButton)
          .anchor("bottom_right")
          .when(this.showCommitMenu, (el) =>
            el.content(
              v_flex()
                .id("sc-commit-actions-menu")
                .w(190)
                .p(4)
                .gap(2)
                .rounded(7)
                .border_1()
                .border_color(t.border)
                .bg(t.popover ?? t.raised)
                .on_mouse_down_out((_e, cx) => {
                  this.showCommitMenu = false;
                  cx.notify();
                })
                .children(
                  COMMIT_MODES.map((m) => {
                    const active = this.commitMode === m.id;
                    return h_flex()
                      .id(`sc-mode-${m.id}`)
                      .h(26)
                      .px(8)
                      .gap(7)
                      .rounded(5)
                      .items_center()
                      .cursor_pointer()
                      .when(active, (item) => item.bg(t.selected))
                      .hover((s) => s.bg(t.hover))
                      .on_mouse_down("left", (_ev, cx) => {
                        cx.stop_propagation();
                        this.selectCommitMode(m.id, cx);
                      })
                      .child(
                        active
                          ? svg(ICON.check)
                              .size(11)
                              .flex_none()
                              .text_color(t.accent)
                          : div().w(11).flex_none()
                      )
                      .child(div().text_size(11.5).child(tr(m.labelKey)));
                  })
                )
            )
          )
      );
  }

  // ── File rows (flat & tree) with hover actions ────────────────────────────
  renderFileRow(f, depth, flat, t) {
    const parts = f.path.split("/");
    const name = parts.pop();
    const rowId = `${f.staged ? "s" : "u"}-${f.path}`;
    const isSelected =
      !this.open?.commit &&
      this.open?.path === f.path &&
      this.open?.staged === f.staged;
    const isLastOpened = !isSelected && this.lastOpened === f.path;
    const shown = isSelected || this.hot === rowId;
    const col = statusColor(t, f.status);

    const actionBtn = (iconName, iconPath, tip, fn) =>
      this.iconBtn(`act-${iconName}-${rowId}`, iconPath, tip, (cx) => {
        this.hot = null;
        fn(cx);
      }, t, { size: 12 });

    return h_flex()
      .id(`row-${rowId}`)
      .h(26)
      .flex_none()
      .pl(8 + depth * 14)
      .pr(4)
      .gap(4)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(isSelected, (e) => e.bg(t.selected))
      .when(isLastOpened, (e) => e.bg(t.hover))
      .when(!isSelected, (e) => e.hover((s) => s.bg(t.hover)))
      .on_hover((on, cx) => this.setHover(rowId, on, cx))
      .on_mouse_down("left", (ev, cx) =>
        this.openFile(f, cx, ev.click_count >= 2)
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(6)
          .items_center()
          .child(this.fileIconEl(f.path, col, t))
          .child(
            div()
              .min_w(0)
              .truncate()
              .text_size(12.5)
              .text_color(col)
              .when(f.status === "D", (e) => e.line_through())
              .child(name)
          )
          .when(flat && parts.length > 0, (e) =>
            e.child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11)
                .text_color(t.dim)
                .child(parts.join("/"))
            )
          )
      )
      .when(!shown && f.add > 0, (e) =>
        e.child(div().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`))
      )
      .when(!shown && f.del > 0, (e) =>
        e.child(div().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`))
      )
      .when(shown, (e) =>
        e
          .child(
            actionBtn("diff", ICON.diff, tr("sc.open_diff"), (cx) =>
              this.pickFile(f.path, f.staged, cx)
            )
          )
          .when(!f.staged && !f.conflict, (el) =>
            el.child(
              actionBtn("undo", ICON.undo, tr("sc.discard"), (cx) =>
                this.askDiscard([f], cx)
              )
            )
          )
          .child(
            actionBtn(
              f.staged ? "unstage" : "stage",
              f.staged ? ICON.minus : ICON.plus,
              f.conflict
                ? "Mark resolved (stage)"
                : f.staged
                ? tr("sc.unstage")
                : tr("sc.stage"),
              (cx) =>
                f.staged
                  ? this.unstageFile(f.path, cx)
                  : this.stageFile(f.path, cx)
            )
          )
      )
      .child(
        div()
          .id(`st-${rowId}`)
          .w(16)
          .flex_none()
          .text_center()
          .text_size(11)
          .font_weight(600)
          .text_color(col)
          .tooltip(gitStatusLabel(f.status))
          .child(f.status)
      );
  }

  renderFileRows(files, scope, t, emptyText) {
    if (!files.length) {
      return [
        h_flex()
          .h(26)
          .flex_none()
          .px(10)
          .items_center()
          .text_size(12)
          .text_color(t.dim)
          .child(emptyText),
      ];
    }
    if (!this.tree) {
      return files.map((f) => this.renderFileRow(f, 0, true, t));
    }
    const out = [];
    const seen = new Set();
    for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const parts = f.path.split("/");
      let hidden = false;
      for (let i = 0; i < parts.length - 1 && !hidden; i++) {
        const relDir = parts.slice(0, i + 1).join("/");
        const dirKey = `${scope}:${relDir}`;
        if (!seen.has(dirKey)) {
          seen.add(dirKey);
          const closed = this.collapsed.has(dirKey);
          out.push(
            h_flex()
              .id(`dir-${dirKey}`)
              .h(26)
              .flex_none()
              .pl(6 + i * 14)
              .pr(6)
              .gap(5)
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_ev, cx) => {
                cx.stop_propagation();
                this.flip(dirKey, cx);
              })
              .child(
                svg(closed ? ICON.chevronRight : ICON.chevronDown)
                  .size(11)
                  .flex_none()
                  .text_color(t.dim)
              )
              .child(this.folderIconEl(relDir, !closed, t))
              .child(
                div()
                  .min_w(0)
                  .truncate()
                  .text_size(12)
                  .text_color(t.muted)
                  .child(parts[i])
              )
          );
        }
        hidden = this.collapsed.has(dirKey);
      }
      if (!hidden) out.push(this.renderFileRow(f, parts.length - 1, false, t));
    }
    return out;
  }

  renderStashRows(t) {
    return this.stashes.map((s) => {
      const rowId = `stash-${s.ref}`;
      const hovered = this.hot === rowId;
      const pill = (id, label, danger, fn) =>
        div()
          .id(id)
          .h(20)
          .px(6)
          .flex()
          .items_center()
          .rounded(4)
          .cursor_pointer()
          .text_size(10.5)
          .text_color(danger ? t.ansi1 : t.muted)
          .bg(t.raised)
          .hover((st) =>
            st.bg(danger ? t.ansi1 + "22" : t.hover).text_color(danger ? t.ansi1 : t.foreground)
          )
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            this.hot = null;
            fn(cx);
          })
          .child(label);

      return h_flex()
        .id(rowId)
        .h(26)
        .flex_none()
        .px(8)
        .gap(6)
        .items_center()
        .rounded(6)
        .hover((st) => st.bg(t.hover))
        .on_hover((on, cx) => this.setHover(rowId, on, cx))
        .child(svg(ICON.stash).size(12).flex_none().text_color(t.ansi5 ?? t.accent))
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(12)
            .text_color(t.foreground)
            .child(s.message || s.ref)
        )
        .when(!hovered, (el) =>
          el.child(
            div()
              .flex_none()
              .text_size(10.5)
              .text_color(t.dim)
              .child(age(s.time))
          )
        )
        .when(hovered, (el) =>
          el
            .child(pill(`spop-${s.ref}`, "Pop", false, (cx) => this.stashPop(s.ref, cx)))
            .child(pill(`sapply-${s.ref}`, "Apply", false, (cx) => this.stashApply(s.ref, cx)))
            .child(pill(`sdrop-${s.ref}`, "Drop", true, (cx) => this.askStashDrop(s.ref, cx)))
        );
    });
  }

  // ── Collapsible section with rounded pill header + draggable grip ─────────
  renderSection(id, title, count, stats, actions, bodyFn, t, { cap = null, fill = false } = {}) {
    const open = !this.collapsed.has(id);
    const list = open && !fill ? bodyFn() : [];

    const head = h_flex()
      .h(28)
      .flex_none()
      .px(6)
      .gap(4)
      .items_center()
      .bg(t.raised)
      .rounded(6)
      .child(
        h_flex()
          .id(`sec-${id}`)
          .flex_1()
          .min_w(0)
          .h_full()
          .px(2)
          .gap(6)
          .items_center()
          .cursor_pointer()
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            this.flip(id, cx);
          })
          .child(
            svg(open ? ICON.chevronDown : ICON.chevronRight)
              .size(11)
              .flex_none()
              .text_color(t.dim)
          )
          .child(
            div()
              .font_semibold()
              .text_size(12)
              .text_color(t.foreground)
              .truncate()
              .child(title)
          )
          .child(
            div()
              .flex_none()
              .px(6)
              .rounded(8)
              .bg(t.hover)
              .text_size(10)
              .text_color(t.muted)
              .child(String(count))
          )
      )
      .when(stats?.add > 0, (e) =>
        e.child(div().text_size(10.5).text_color(t.ansi2).child(`+${stats.add}`))
      )
      .when(stats?.del > 0, (e) =>
        e.child(div().text_size(10.5).text_color(t.ansi1).child(`−${stats.del}`))
      );

    for (const a of actions) head.child(a);

    if (!open) {
      this.used += 30;
      return [head];
    }

    if (fill) {
      const body = bodyFn();
      if (Array.isArray(body)) {
        return [
          head,
          v_flex()
            .id(`scroll-${id}`)
            .flex_1()
            .min_h(0)
            .w_full()
            .overflow_y_scrollbar()
            .gap(2)
            .children(body),
        ];
      }
      return [head, body];
    }

    const height = Math.min(cap ?? 220, Math.max(1, list.length) * 28 + 2);
    const showGrip = list.length > 1;
    this.used += 30 + height + (showGrip ? 10 : 2);

    const grip = showGrip
      ? div()
          .id(`grip-${id}`)
          .h(6)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(3)
          .cursor_row_resize()
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            this.drag = {
              id,
              y: e.position.y,
              start: height,
              moved: false,
              max: Math.max(height, height + Math.max(0, this.spare ?? 260)),
            };
            cx.notify();
          })
          .child(
            div()
              .w(28)
              .h(2)
              .rounded(1)
              .bg(this.drag?.id === id ? t.accent : t.border)
          )
      : null;

    return [
      head,
      v_flex()
        .id(`scroll-${id}`)
        .flex_none()
        .h(height)
        .overflow_y_scrollbar()
        .gap(2)
        .children(list),
      ...(grip ? [grip] : []),
    ];
  }

  // ── Multi-lane Commit Graph ───────────────────────────────────────────────
  renderSubject(c, t) {
    const isMerge = c.parents.length > 1;
    const [, prefix, msg] =
      /^(\w+(?:\([^)]*\))?!?:\s+)(.*)$/.exec(c.subject) ?? [, "", c.subject];
    return h_flex()
      .flex_1()
      .min_w(60)
      .gap(4)
      .items_center()
      .when(c.isHead, (e) => e.font_weight(600))
      .when(Boolean(prefix), (e) =>
        e.child(
          div()
            .flex_none()
            .text_size(12)
            .text_color(t.dim)
            .child(prefix.trim())
        )
      )
      .child(
        div()
          .min_w(0)
          .truncate()
          .text_size(12)
          .text_color(isMerge ? t.muted : t.foreground)
          .child(msg)
      );
  }

  renderRefBadge(r, t, unpushed = false) {
    const local = r.kind === "local";
    const localColor = unpushed ? t.ansi3 : t.accent;
    return div()
      .min_w(0)
      .max_w(92)
      .truncate()
      .px(5)
      .rounded(4)
      .text_size(10)
      .font_weight(500)
      .when(local, (e) => e.bg(localColor + "24").text_color(localColor))
      .when(!local, (e) =>
        e
          .border_1()
          .border_color(r.kind === "tag" ? t.ansi3 + "66" : t.border)
          .text_color(r.kind === "tag" ? t.ansi3 : t.muted)
      )
      .child(r.name);
  }

  renderCommitBody(body, t) {
    const lines = body.split("\n");
    return v_flex()
      .w_full()
      .pt(5)
      .gap(3)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.5)
      .text_color(t.muted)
      .children(
        lines.map((raw) => {
          if (!raw.trim()) return div().h(4);
          const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw);
          if (bullet) {
            const indent = Math.min(24, Math.floor(bullet[1].length / 2) * 10);
            return h_flex()
              .w_full()
              .pl(indent)
              .gap(6)
              .items_start()
              .child(
                div()
                  .w(4)
                  .h(4)
                  .mt(6)
                  .rounded_full()
                  .flex_none()
                  .bg(t.muted)
              )
              .child(div().flex_1().min_w(0).child(bullet[2]));
          }
          return div().w_full().child(raw);
        })
      );
  }

  renderGraph(t) {
    if (!this.commits.length) {
      return h_flex()
        .flex_1()
        .min_h(0)
        .px(10)
        .py(8)
        .items_start()
        .text_size(12)
        .text_color(t.dim)
        .child(this.loading ? "Loading history…" : tr("sc.no_commits"));
    }

    const n = this.lanes;
    const L = laneWidth(n);
    const graphW = Math.min(GRAPH_PAD * 2 + n * L, GRAPH_MAX);
    const limit = this.commitLimit ?? 50;
    const visible = this.commits.slice(0, limit);
    const rows = [];

    for (const c of visible) {
      const open = this.expandedCommit === c.fullHash;
      const more = c.refs.length - 2;

      rows.push(
        h_flex()
          .id(`c-${c.fullHash}`)
          .h(GRAPH_ROW)
          .flex_none()
          .w_full()
          .pl(4)
          .pr(8)
          .gap(8)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .when(open, (e) => e.bg(t.selected))
          .when(!open && c.isHead, (e) =>
            e.bg((c.unpushed ? t.ansi3 : laneColor(t, c.col)) + "12")
          )
          .when(!open, (e) => e.hover((s) => s.bg(t.hover)))
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            this.toggleCommitExpand(c.fullHash, cx);
          })
          .child(graphCell(c, n, L, t, t.background))
          .child(this.renderSubject(c, t))
          .when(c.refs.length > 0, (e) =>
            e.child(
              h_flex()
                .min_w(0)
                .gap(4)
                .items_center()
                .overflow_hidden()
                .children(
                  c.refs
                    .slice(0, 2)
                    .map((r) => this.renderRefBadge(r, t, c.unpushed))
                )
                .when(more > 0, (el) =>
                  el.child(
                    div()
                      .flex_none()
                      .text_size(10)
                      .text_color(t.dim)
                      .child(`+${more}`)
                  )
                )
            )
          )
          .child(
            div()
              .flex_none()
              .text_size(11)
              .text_color(t.dim)
              .child(age(c.time))
          )
      );

      if (!open) continue;

      const railLines = c.below
        .filter((i) => laneX(i, L) < graphW)
        .map((i) =>
          div()
            .absolute()
            .left(4 + laneX(i, L) - 1)
            .top(0)
            .bottom(0)
            .w(1.75)
            .bg(c.belowUnpushed?.has(i) ? t.ansi3 : laneColor(t, i))
        );

      const files = this.commitFiles[c.fullHash];
      const showFullBody = this.expandedBodyHashes.has(c.fullHash);

      rows.push(
        div()
          .id(`cdetail-${c.fullHash}`)
          .relative()
          .flex_none()
          .w_full()
          .children(railLines)
          .child(
            v_flex()
              .ml(4 + graphW + 4)
              .mr(6)
              .py(3)
              .gap(4)
              .child(
                // Commit details card (auto-sizing, never clipped)
                v_flex()
                  .p(8)
                  .gap(5)
                  .rounded(6)
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .child(
                    div()
                      .w_full()
                      .text_size(12)
                      .font_weight(500)
                      .text_color(t.foreground)
                      .child(c.subject)
                  )
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(
                        div()
                          .flex_none()
                          .px(5)
                          .py(1)
                          .rounded(4)
                          .bg(t.background)
                          .text_size(10.5)
                          .font_weight(600)
                          .text_color(t.accent)
                          .child(c.hash)
                      )
                      .child(
                        div()
                          .flex_1()
                          .min_w(0)
                          .truncate()
                          .text_size(11)
                          .text_color(t.dim)
                          .child(`${c.author} · ${c.time}`)
                      )
                  )
                  .child(
                    (() => {
                      const act = (id, label, danger, fn) =>
                        div()
                          .id(id)
                          .h(20)
                          .px(6)
                          .flex()
                          .items_center()
                          .rounded(4)
                          .bg(t.background)
                          .border_1()
                          .border_color(t.border)
                          .text_size(10.5)
                          .text_color(danger ? t.ansi1 : t.muted)
                          .cursor_pointer()
                          .hover((s) =>
                            s
                              .bg(danger ? t.ansi1 + "22" : t.hover)
                              .text_color(danger ? t.ansi1 : t.foreground)
                          )
                          .on_mouse_down("left", (_ev, cx) => {
                            cx.stop_propagation();
                            fn(cx);
                          })
                          .child(label);
                      const copied = this.copiedHash === c.fullHash;
                      return h_flex()
                        .gap(4)
                        .flex_wrap()
                        .child(
                          act(
                            `cact-copy-${c.fullHash}`,
                            copied ? "Copied" : "Copy hash",
                            false,
                            (cx) => {
                              cx.write_to_clipboard(c.fullHash);
                              this.copiedHash = c.fullHash;
                              cx.notify();
                              cx.timer.after(1500, (timerCx) => {
                                if (this.copiedHash === c.fullHash) {
                                  this.copiedHash = null;
                                  timerCx.notify();
                                }
                              });
                            }
                          )
                        )
                        .child(
                          act(`cact-branch-${c.fullHash}`, "Branch", false, (cx) => {
                            this.branchFromCommit =
                              this.branchFromCommit === c.fullHash ? null : c.fullHash;
                            this.branchNameInput.set_value("");
                            if (this.branchFromCommit) this.branchNameInput.focus();
                            cx.notify();
                          })
                        )
                        .child(
                          act(`cact-co-${c.fullHash}`, "Checkout", false, (cx) =>
                            this.askConfirm(
                              `Checkout commit ${c.hash} (detached HEAD)?`,
                              "Checkout",
                              [["checkout", c.fullHash]],
                              "Checkout",
                              cx
                            )
                          )
                        )
                        .child(
                          act(`cact-cp-${c.fullHash}`, "Cherry-pick", false, (cx) =>
                            this.askConfirm(
                              `Cherry-pick ${c.hash} onto ${this.branch || "HEAD"}?`,
                              "Cherry-pick",
                              [["cherry-pick", c.fullHash]],
                              "Cherry-pick",
                              cx
                            )
                          )
                        )
                        .child(
                          act(`cact-rev-${c.fullHash}`, "Revert", false, (cx) =>
                            this.askConfirm(
                              `Create a new commit reverting ${c.hash}?`,
                              "Revert",
                              [["revert", "--no-edit", c.fullHash]],
                              "Revert",
                              cx
                            )
                          )
                        )
                        .child(
                          act(`cact-rsoft-${c.fullHash}`, "Reset soft", true, (cx) =>
                            this.askConfirm(
                              `Soft reset ${this.branch || "HEAD"} to ${c.hash} (keeps changes staged)?`,
                              "Reset",
                              [["reset", "--soft", c.fullHash]],
                              "Reset soft",
                              cx
                            )
                          )
                        )
                        .child(
                          act(`cact-rmix-${c.fullHash}`, "Reset mixed", true, (cx) =>
                            this.askConfirm(
                              `Mixed reset ${this.branch || "HEAD"} to ${c.hash} (keeps changes unstaged)?`,
                              "Reset",
                              [["reset", "--mixed", c.fullHash]],
                              "Reset mixed",
                              cx
                            )
                          )
                        );
                    })()
                  )
                  .when(this.branchFromCommit === c.fullHash, (el) =>
                    el.child(
                      h_flex()
                        .gap(4)
                        .items_center()
                        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                        .child(
                          div()
                            .flex_1()
                            .h(24)
                            .px(6)
                            .flex()
                            .items_center()
                            .rounded(5)
                            .border_1()
                            .border_color(t.accent)
                            .bg(t.background)
                            .child(
                              Input.new(this.branchNameInput)
                                .w_full()
                                .text_size(11.5)
                                .text_color(t.foreground)
                            )
                        )
                        .child(
                          div()
                            .id(`cbranch-go-${c.fullHash}`)
                            .h(24)
                            .px(8)
                            .flex()
                            .items_center()
                            .rounded(5)
                            .bg(t.solid)
                            .text_size(11)
                            .text_color(t.solid_foreground)
                            .cursor_pointer()
                            .hover((s) => s.opacity(0.9))
                            .on_mouse_down("left", (_ev, cx) => {
                              cx.stop_propagation();
                              this.createBranchFromCommit(c.fullHash, cx);
                            })
                            .child("Create")
                        )
                    )
                  )
                  .when(Boolean(c.body), (el) =>
                    el
                      .when(showFullBody, (bEl) =>
                        bEl.child(this.renderCommitBody(c.body, t))
                      )
                      .child(
                        h_flex().child(
                          div()
                            .id(`cbody-toggle-${c.fullHash}`)
                            .px(6)
                            .py(2)
                            .rounded(4)
                            .bg(t.background)
                            .border_1()
                            .border_color(t.border)
                            .text_size(10.5)
                            .text_color(t.muted)
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover).text_color(t.foreground))
                            .on_mouse_down("left", (_ev, cx) => {
                              cx.stop_propagation();
                              if (showFullBody)
                                this.expandedBodyHashes.delete(c.fullHash);
                              else this.expandedBodyHashes.add(c.fullHash);
                              cx.notify();
                            })
                            .child(
                              showFullBody
                                ? tr("sc.hide_details")
                                : "Show full message"
                            )
                        )
                      )
                  )
              )
              .when(!files, (el) =>
                el.child(
                  div()
                    .px(6)
                    .py(3)
                    .text_size(11)
                    .text_color(t.dim)
                    .child(tr("sc.loading_commit_files"))
                )
              )
              .when(Boolean(files && !files.length), (el) =>
                el.child(
                  div()
                    .px(6)
                    .py(3)
                    .text_size(11)
                    .text_color(t.dim)
                    .child("No file changes")
                )
              )
              .when(Boolean(files && files.length), (el) =>
                el.children(
                  files.map((f) => {
                    const cfId = `cf-${c.fullHash}-${f.path}`;
                    const picked =
                      (this.open?.commit === c.fullHash ||
                        this.open?.commit === c.hash) &&
                      this.open?.path === f.path;
                    const hovered = this.hot === cfId;
                    const parts = f.path.split("/");
                    const name = parts.pop();
                    const col = statusColor(t, f.status);

                    return h_flex()
                      .id(cfId)
                      .h(24)
                      .flex_none()
                      .px(6)
                      .gap(5)
                      .items_center()
                      .rounded(5)
                      .cursor_pointer()
                      .when(picked, (r) => r.bg(t.selected))
                      .when(!picked, (r) => r.hover((s) => s.bg(t.hover)))
                      .on_hover((on, cx) => this.setHover(cfId, on, cx))
                      .on_mouse_down("left", (_ev, cx) => {
                        cx.stop_propagation();
                        this.pickFile(f.path, false, cx, c.fullHash);
                      })
                      .child(this.fileIconEl(f.path, col, t, 14))
                      .child(
                        div()
                          .min_w(0)
                          .truncate()
                          .text_size(12)
                          .text_color(col)
                          .when(f.status === "D", (r) => r.line_through())
                          .child(name)
                      )
                      .child(
                        div()
                          .flex_1()
                          .min_w(0)
                          .truncate()
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(parts.join("/"))
                      )
                      .when(!hovered && f.add > 0, (r) =>
                        r.child(
                          div().text_size(10).text_color(t.ansi2).child(`+${f.add}`)
                        )
                      )
                      .when(!hovered && f.del > 0, (r) =>
                        r.child(
                          div().text_size(10).text_color(t.ansi1).child(`−${f.del}`)
                        )
                      )
                      .when(hovered && f.status !== "D", (r) =>
                        r.child(
                          this.iconBtn(
                            `cf-open-${c.fullHash}-${f.path}`,
                            ICON.file,
                            tr("sc.open_in_files"),
                            (cx) => {
                              openInBetterFiles({
                                root: this.root,
                                relative: f.path,
                                on: this.on,
                              });
                              cx.notify();
                            },
                            t,
                            { size: 11 }
                          )
                        )
                      )
                      .child(
                        div()
                          .w(14)
                          .flex_none()
                          .text_center()
                          .text_size(10.5)
                          .font_weight(600)
                          .text_color(col)
                          .child(f.status)
                      );
                  })
                )
              )
          )
      );
    }

    if (this.commits.length > limit) {
      rows.push(
        h_flex()
          .id("sc-graph-more")
          .h(26)
          .flex_none()
          .mt(2)
          .items_center()
          .justify_center()
          .rounded(6)
          .cursor_pointer()
          .text_size(11.5)
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            this.commitLimit = limit + 50;
            cx.notify();
          })
          .child(`Load more (${this.commits.length - limit} remaining)`)
      );
    }

    return v_flex()
      .id("sc-graph-scroll")
      .flex_1()
      .min_h(0)
      .w_full()
      .overflow_y_scrollbar()
      .children(rows);
  }

  renderNotice(iconPath, title, hint, t, spin = false) {
    return v_flex()
      .flex_1()
      .py(32)
      .px(16)
      .gap(6)
      .items_center()
      .text_center()
      .child(
        svg(iconPath)
          .size(20)
          .text_color(t.dim)
          .when(spin, (e) => e.spin(900))
      )
      .child(div().text_size(13).text_color(t.muted).child(title))
      .when(Boolean(hint), (e) =>
        e.child(div().text_size(12).text_color(t.dim).child(hint))
      );
  }

  render(cx) {
    if (this.mode === "diff") return this.renderDiffTab();
    if (key() !== this.context) this.refresh(cx);

    const t = theme();
    const allFiles = [...this.staged, ...this.unstaged];
    const isAmend = this.commitMode === "amend";
    const canCommit = Boolean(
      this.message.trim() &&
        this.root &&
        !this.busy &&
        !this.loading &&
        (allFiles.length > 0 || isAmend)
    );
    const activeModeObj =
      COMMIT_MODES.find((m) => m.id === this.commitMode) ?? COMMIT_MODES[0];

    const sum = (list) => ({
      add: list.reduce((n, f) => n + (f.add || 0), 0),
      del: list.reduce((n, f) => n + (f.del || 0), 0),
    });

    const fetching = this.busy && this.busyAction === "Fetch";
    const scopeToggle = div()
      .id("sc-graph-scope")
      .h(20)
      .px(6)
      .flex()
      .items_center()
      .rounded(4)
      .cursor_pointer()
      .text_size(10.5)
      .text_color(this.allBranches ? t.accent : t.muted)
      .when(this.allBranches, (e) => e.bg(t.accent + "1f"))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(
        this.allBranches
          ? `${tr("sc.all_branches")} — click for current branch only`
          : `${tr("sc.current_branch")} — click for all branches`
      )
      .on_mouse_down("left", (_ev, cx) => {
        cx.stop_propagation();
        this.allBranches = !this.allBranches;
        localStorage.setItem("sc.allBranches", this.allBranches ? "1" : "0");
        this.refresh(cx);
        cx.notify();
      })
      .child(this.allBranches ? "All" : "Branch");

    this.used = 12;
    const clean = !this.staged.length && !this.unstaged.length && !this.conflicts.length;
    const graphOpen = !this.collapsed.has("log");
    const workOpen = !this.collapsed.has("work");
    const stagedOpen = this.staged.length > 0 && !this.collapsed.has("staged");
    const workFills = !graphOpen && workOpen;
    const stagedFills = !graphOpen && !workOpen && stagedOpen;
    const needsBottomSpacer = !graphOpen && !workOpen && !stagedOpen;

    const sections =
      this.error === tr("sc.not_git")
        ? [
            this.renderNotice(
              ICON.branch,
              tr("sc.not_git"),
              "Focus a folder inside a git repository.",
              t
            ),
          ]
        : this.error
        ? [this.renderNotice(ICON.close, "Cannot read repository", this.error, t)]
        : !this.root
        ? [
            this.loading
              ? this.renderNotice(ICON.spinner, "Loading…", "", t, true)
              : this.renderNotice(
                  ICON.folder,
                  "No folder",
                  "Focus a terminal or pane that has a folder.",
                  t
                ),
          ]
        : [
            ...(this.conflicts.length
              ? this.renderSection(
                  "conflicts",
                  "Merge Conflicts",
                  this.conflicts.length,
                  null,
                  [],
                  () => this.renderFileRows(this.conflicts, "conflicts", t, ""),
                  t,
                  { cap: 140 }
                )
              : []),
            ...(this.staged.length
              ? this.renderSection(
                  "staged",
                  tr("sc.staged_changes"),
                  this.staged.length,
                  sum(this.staged),
                  [
                    this.iconBtn(
                      "sc-unstage-all",
                      ICON.minus,
                      tr("sc.unstage_all"),
                      (cx) => this.unstageAll(cx),
                      t
                    ),
                  ],
                  () => this.renderFileRows(this.staged, "staged", t, ""),
                  t,
                  stagedFills ? { fill: true } : { cap: this.caps.staged }
                )
              : []),
            ...this.renderSection(
              "work",
              tr("sc.changes"),
              this.unstaged.length,
              sum(this.unstaged),
              [
                ...(this.staged.length + this.unstaged.length > 0
                  ? [
                      this.iconBtn(
                        "sc-stash-push",
                        ICON.stash,
                        "Stash all changes",
                        (cx) => this.stashPush(cx),
                        t
                      ),
                    ]
                  : []),
                ...(this.unstaged.length
                  ? [
                      this.iconBtn(
                        "sc-discard-all",
                        ICON.undo,
                        tr("sc.discard_all"),
                        (cx) => this.askDiscard(this.unstaged, cx),
                        t
                      ),
                      this.iconBtn(
                        "sc-stage-all",
                        ICON.plus,
                        tr("sc.stage_all"),
                        (cx) => this.stageAll(cx),
                        t
                      ),
                    ]
                  : []),
              ],
              () =>
                this.renderFileRows(
                  this.unstaged,
                  "work",
                  t,
                  clean ? "Working tree clean" : "All changes are staged"
                ),
              t,
              workFills ? { fill: true } : { cap: this.caps.work }
            ),
            ...(this.stashes.length
              ? this.renderSection(
                  "stashes",
                  "Stashes",
                  this.stashes.length,
                  null,
                  [],
                  () => this.renderStashRows(t),
                  t,
                  { cap: 120 }
                )
              : []),
            ...(needsBottomSpacer ? [div().flex_1()] : []),
            ...this.renderSection(
              "log",
              tr("sc.graph"),
              this.commits.length >= MAX_COMMITS
                ? `${MAX_COMMITS}+`
                : this.commits.length,
              null,
              [
                scopeToggle,
                this.iconBtn(
                  "sc-graph-fetch",
                  ICON.cloud,
                  tr("sc.fetch"),
                  (cx) => this.gitAction(["fetch", "--prune"], cx, "Fetch"),
                  t,
                  { spin: fetching, color: fetching ? t.accent : null }
                ),
              ],
              () => this.renderGraph(t),
              t,
              { fill: true }
            ),
          ];

    this.spare = Math.max(0, (this.listHeight ?? 480) - this.used - 120);

    return v_flex()
      .id("source-control")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (
          e.key === "enter" &&
          (e.modifiers?.control || e.modifiers?.platform) &&
          canCommit
        ) {
          cx.stop_propagation();
          this.runCommit(cx);
          return;
        }
        if (e.key !== "escape") return;
        if (this.showCommitMenu || this.asking || this.branchFromCommit) {
          this.showCommitMenu = false;
          this.asking = null;
          this.branchFromCommit = null;
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (this.typing) {
          this.typing = false;
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
        }
      })
      .on_mouse_move((e, cx) => {
        if (this.resizingCommit) {
          const delta = e.position.y - this.resizingCommit.startY;
          const nextH = Math.max(
            54,
            Math.min(260, Math.round(this.resizingCommit.startH + delta))
          );
          if (nextH !== this.commitHeight) {
            this.commitHeight = nextH;
            cx.notify();
          }
          return;
        }
        if (this.drag) {
          const d = this.drag;
          const delta = e.position.y - d.y;
          if (!d.moved && Math.abs(delta) < 3) return;
          d.moved = true;
          const next = Math.round(
            Math.min(d.max, Math.max(58, d.start + delta))
          );
          if (next !== this.caps[d.id]) {
            this.caps[d.id] = next;
            cx.notify();
          }
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.resizingCommit) {
          this.resizingCommit = null;
          setShared("james-changes.commitHeight", this.commitHeight);
          cx.notify();
        }
        this.endDrag(cx);
      })
      .child(this.renderHeader(t))
      .child(this.renderComposer(t, canCommit, activeModeObj))
      .child(
        v_flex()
          .id("sc-sections-area")
          .flex_1()
          .min_h(0)
          .w_full()
          .p(6)
          .gap(2)
          .overflow_hidden()
          .on_scroll_wheel(() => {
            this.wheelAt = Date.now();
          })
          .on_hover((on, cx) => {
            if (!on) this.endDrag(cx);
          })
          .on_size_change((size, cx) => {
            if (size.height !== this.listHeight) {
              this.listHeight = size.height;
              cx.notify();
            }
          })
          .children(sections)
      )
      .when(Boolean(this.asking), (e) =>
        e.child(
          h_flex()
            .flex_none()
            .pl(10)
            .pr(6)
            .py(6)
            .gap(6)
            .items_center()
            .rounded_b(9)
            .bg(t.ansi1 + "18")
            .border_t(1)
            .border_color(t.border)
            .child(
              div()
                .flex_1()
                .min_w(0)
                .text_size(11.5)
                .text_color(t.foreground)
                .child(this.asking?.text ?? "")
            )
            .child(
              div()
                .id("sc-ask-cancel")
                .h(24)
                .px(8)
                .flex()
                .items_center()
                .rounded(5)
                .cursor_pointer()
                .text_size(11.5)
                .hover((s) => s.bg(t.hover))
                .on_mouse_down("left", (_ev, cx) => {
                  cx.stop_propagation();
                  this.asking = null;
                  cx.notify();
                })
                .child(tr("sc.cancel"))
            )
            .child(
              div()
                .id("sc-ask-confirm")
                .h(24)
                .px(8)
                .flex()
                .items_center()
                .rounded(5)
                .cursor_pointer()
                .text_size(11.5)
                .font_weight(500)
                .bg(t.ansi1)
                .text_color(t.background)
                .hover((s) => s.opacity(0.88))
                .on_mouse_down("left", (_ev, cx) => {
                  cx.stop_propagation();
                  this.gitActions(
                    this.asking.actions,
                    cx,
                    this.asking.label ?? "Discard changes"
                  );
                })
                .child(this.asking?.confirmLabel ?? tr("sc.confirm_discard"))
            )
        )
      )
      .when(Boolean(this.note), (e) =>
        e.child(
          h_flex()
            .flex_none()
            .pl(10)
            .pr(6)
            .py(4)
            .gap(6)
            .items_start()
            .rounded_b(9)
            .bg(t.ansi1 + "14")
            .border_t(1)
            .border_color(t.border)
            .child(
              div()
                .flex_1()
                .min_w(0)
                .py(2)
                .text_size(11)
                .text_color(t.ansi1)
                .child(this.note ?? "")
            )
            .child(
              this.iconBtn(
                "sc-close-note",
                ICON.close,
                "Dismiss",
                (cx) => {
                  this.note = null;
                  cx.notify();
                },
                t
              )
            )
        )
      );
  }
}

Object.assign(JamesChanges.prototype, diffTabMethods);
