import { View, div, svg } from "gpui-kit";
import { tr } from "./i18n.js";
import {
  v_flex,
  h_flex,
  TextareaState,
  Textarea,
  Scrollbar,
  ScrollHandle,
  v_virtual_list,
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
  settings,
  shared,
  setShared,
  openOverlay,
  checking,
  notify,
  run,
} from "herdr";

const DEFAULT_PROMPT =
  "Analyze the git diff below and write a git commit message following the Conventional Commits specification:\n" +
  "1. First line: <type>(<optional scope>): <concise summary in imperative mood, max 72 chars>\n" +
  "2. Second line: blank\n" +
  "3. Body: concise bullet points (- ...) explaining the key changes and why they were made.";

const FIXED_RULES =
  "Rules (mandatory):\n" +
  "- Output ONLY the raw commit message text (no markdown code fences, no commentary, no intro/outro).\n" +
  "- Do NOT run any commands, tools, or modify any files.";

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
  file: "mods/workspace-chrome/file-text.svg",
};

const GIT_STATUS_KEYS = {
  M: "sc.status_M",
  A: "sc.status_A",
  D: "sc.status_D",
  U: "sc.status_U",
  R: "sc.status_R",
  C: "sc.status_C",
  T: "sc.status_T",
};

const gitStatusLabel = (code) => (GIT_STATUS_KEYS[code] ? tr(GIT_STATUS_KEYS[code]) : code);

const COMMIT_MODES = [
  { id: "commit", labelKey: "sc.commit" },
  { id: "push", labelKey: "sc.commit_push" },
  { id: "amend", labelKey: "sc.commit_amend" },
];

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

function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on =
    f?.pane === null
      ? f.terminal?.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, spaceId: space?.id };
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

const untab = (text) =>
  text.replace(/[^\t]*\t/g, (s) =>
    s.slice(0, -1).padEnd(s.length - 1 - ((s.length - 1) % 4) + 4)
  );

function diffRows(lines) {
  let old = 0;
  let next = 0;
  const out = [];
  for (const line of lines) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      continue;
    }
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      old = +match[1];
      next = +match[2];
      out.push({ kind: "@", text: line });
      continue;
    }
    const kind = line[0];
    if (kind === "-") {
      out.push({ kind, number: old++, text: untab(line.slice(1)) || " " });
    } else if (kind === "+") {
      out.push({ kind, number: next++, text: untab(line.slice(1)) || " " });
    } else if (kind === " ") {
      old++;
      out.push({ kind, number: next++, text: untab(line.slice(1)) || " " });
    } else {
      out.push({ kind: "", text: line });
    }
  }
  return out;
}

function parseRefs(rawDecorations) {
  if (!rawDecorations || !rawDecorations.trim()) return [];
  const parts = rawDecorations
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const refs = [];
  for (const part of parts) {
    if (part === "origin/HEAD" || part.startsWith("origin/HEAD ->")) continue;
    if (part.startsWith("HEAD -> ")) {
      refs.push({ name: part.slice(8).trim(), kind: "head" });
    } else if (part === "HEAD") {
      refs.push({ name: "HEAD", kind: "head" });
    } else if (part.startsWith("tag: ")) {
      refs.push({ name: part.slice(5).trim(), kind: "tag" });
    } else if (part.includes("/")) {
      refs.push({ name: part, kind: "remote" });
    } else {
      refs.push({ name: part, kind: "local" });
    }
  }
  return refs;
}

function cleanAiOutput(raw) {
  let text = (raw ?? "").trim();
  const fence = /^```(?:text|markdown|gitcommit|commit)?\s*\n([\s\S]*?)\n```$/i.exec(
    text
  );
  if (fence) text = fence[1].trim();
  return text;
}

export default class JamesChanges extends View {
  init(_props, cx) {
    this.staged = [];
    this.unstaged = [];
    this.commits = [];
    this.commitFiles = {}; // hash -> [{ path, status, add, del }]
    this.expandedCommit = null;
    this.expandedBodyHashes = new Set();
    this.rows = [];
    this.diffWidth = 300;
    this.branch = "";
    this.ahead = 0;
    this.behind = 0;
    this.hasUpstream = false;

    this.foldStaged = false;
    this.foldUnstaged = false;
    this.foldGraphSection = false;

    this.sectionsHeight = 0;
    this.commitHeight = shared("james-changes.commitHeight") ?? 76;
    this.graphHeight = shared("james-changes.graphHeight") ?? 220;
    this.diffHeight = shared("james-changes.diffHeight") ?? 210;

    this.resizingCommit = null;
    this.resizingGraph = null;
    this.resizingDiff = null;
    this.hoverCommitResizer = false;
    this.hoverGraphResizer = false;
    this.hoverDiffResizer = false;

    this.commitMode = "commit"; // "commit" | "push" | "amend"
    this.showCommitMenu = false;
    this.generating = false;
    this.message = "";
    this.open = null; // { path, staged, commit? }
    this.handle = cx.focus_handle();
    this.stagedScroll = ScrollHandle.new();
    this.filesScroll = ScrollHandle.new();
    this.graphScroll = ScrollHandle.new();

    this.input = TextareaState.new({
      placeholder: tr("sc.composer_placeholder"),
      rows: 3,
    });
    this.input.on("change", (_e, cx) => {
      const prev = Boolean(this.message.trim());
      this.message = this.input.value();
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
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
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

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location();
    const context = key();
    if (context !== this.context) {
      this.context = context;
      this.root = null;
      this.staged = [];
      this.unstaged = [];
      this.commits = [];
      this.commitFiles = {};
      this.expandedCommit = null;
      this.open = null;
      this.setLines([]);
      this.message = "";
      this.input.set_value("");
      this.error = null;
      this.note = null;
      this.watched = null;
    }
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
          this.root = null;
          this.staged = [];
          this.unstaged = [];
          this.commits = [];
          this.setLines([]);
          this.open = null;
          this.error = tr("sc.not_git");
          return;
        }
        const root = top.stdout.trim();
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });

        const [status, head, branchRes, upstreamRes] = await Promise.all([
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

        const [cachedNum, workNum] = await Promise.all([
          git(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
          git(["diff", "--numstat", "-z", "--no-renames"]),
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

        const staged = [];
        const unstaged = [];
        const entries = status.stdout.split("\0").filter(Boolean);

        for (const entry of entries.slice(0, 1000)) {
          const x = entry[0];
          const y = entry[1];
          const path = entry.slice(3);
          const fresh = x === "?" && y === "?";

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

        let commits = [];
        if (head.code === 0) {
          const logRes = await git([
            "log",
            "-n",
            "30",
            "--format=%h%x1f%s%x1f%b%x1f%an%x1f%cr%x1f%D%x1e",
          ]);
          if (logRes.code === 0) {
            commits = logRes.stdout
              .split("\x1e")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((rec, idx) => {
                const [hash, subject, body, author, time, rawRefs] = rec.split("\x1f");
                return {
                  hash,
                  subject: subject ?? "",
                  body: (body ?? "").trim(),
                  author: author ?? "",
                  time: time ?? "",
                  refs: parseRefs(rawRefs),
                  isHead: idx === 0,
                  unpushed: this.hasUpstream && idx < this.ahead,
                };
              });
          }
        }

        if (key() !== context) return;
        this.root = root;
        this.on = on;
        this.hasHead = head.code === 0;
        this.staged = staged;
        this.unstaged = unstaged;
        this.commits = commits;
        this.error = null;
        this.watch(root, cx);

        const allFiles = [...staged, ...unstaged];
        if (
          this.open &&
          !this.open.commit &&
          !allFiles.some(
            (f) => f.path === this.open.path && f.staged === this.open.staged
          )
        ) {
          this.open = null;
          this.setLines([]);
        }
        if (this.open) {
          try {
            await this.loadOpen(this.open, context);
          } catch {
            if (key() === context)
              this.setLines(["Cannot preview this diff"]);
          }
        }
      } catch (e) {
        if (key() === context) this.error = String(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  async loadOpen(target, context) {
    const root = this.root;
    const on = this.on;
    if (!root || !target) return;

    if (target.commit && target.path) {
      const r = await exec(
        "git",
        [
          ...READ,
          "show",
          "--no-ext-diff",
          "--no-color",
          "--format=",
          target.commit,
          "--",
          target.path,
        ],
        { cwd: root, on }
      );
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n");
      const first = all.findIndex((l) => l.startsWith("@@"));
      const lines = first < 0 ? ["No text diff available"] : all.slice(first);
      if (
        key() === context &&
        this.open?.commit === target.commit &&
        this.open?.path === target.path
      ) {
        this.setLines(
          lines
            .slice(0, 1500)
            .map((l) => (l.length > 4000 ? l.slice(0, 4000) + "…" : l))
        );
      }
      return;
    }

    const list = target.staged ? this.staged : this.unstaged;
    const file = list.find((f) => f.path === target.path);
    if (!file) return;

    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A" && !target.staged)) {
      const text = await readTextFile(`${root}/${file.path}`, { on }).catch(
        () => null
      );
      if (text === null)
        lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [
          `@@ -0,0 +1,${file.add} @@`,
          ...text
            .slice(0, 400000)
            .replace(/\n$/, "")
            .split("\n")
            .slice(0, 1500)
            .map((l) => `+${l}`),
        ];
      }
    } else {
      const args = [
        ...READ,
        "diff",
        ...(target.staged ? ["--cached"] : []),
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        file.path,
      ];
      const r = await exec("git", args, { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n");
      const first = all.findIndex((l) => l.startsWith("@@"));
      lines =
        first < 0
          ? [file.binary ? "Binary file changed" : "No text diff available"]
          : all.slice(first);
    }
    if (
      key() === context &&
      !this.open?.commit &&
      this.open?.path === target.path &&
      this.open?.staged === target.staged
    ) {
      this.setLines(
        lines
          .slice(0, 1500)
          .map((line) =>
            line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line
          )
      );
    }
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(
      300,
      ...this.rows.map((row) => (row.text.length + 1) * 7 + 50)
    );
  }

  pickFile(path, staged, cx, commit = null) {
    const same =
      this.open?.path === path &&
      this.open?.staged === staged &&
      (this.open?.commit ?? null) === commit;
    this.open = same ? null : { path, staged, commit };
    this.setLines([]);
    this.note = null;
    const context = this.context;
    if (this.open) {
      cx.spawn(async (cx) => {
        try {
          await this.loadOpen(this.open, context);
        } catch (e) {
          if (key() === context) this.note = `Cannot preview diff: ${e}`;
        }
        cx.notify();
      });
    }
    cx.notify();
  }

  toggleCommitExpand(hash, cx) {
    if (this.expandedCommit === hash) {
      this.expandedCommit = null;
      if (this.open?.commit === hash) {
        this.open = null;
        this.setLines([]);
      }
      cx.notify();
      return;
    }
    this.expandedCommit = hash;
    if (this.commitFiles[hash]) {
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
            [...READ, "show", "--numstat", "--format=", "-z", hash],
            { cwd: root, on }
          ),
          exec(
            "git",
            [...READ, "show", "--name-status", "--format=", "-z", hash],
            { cwd: root, on }
          ),
        ]);
        const statusMap = {};
        if (statusRes.code === 0) {
          const tokens = statusRes.stdout.split("\0").filter(Boolean);
          for (let i = 0; i < tokens.length - 1; i += 2) {
            statusMap[tokens[i + 1]] = tokens[i][0] || "M";
          }
        }
        const files = [];
        if (statRes.code === 0) {
          for (const entry of statRes.stdout.split("\0").filter(Boolean)) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t");
            files.push({
              path,
              status: statusMap[path] ?? "M",
              add: Number(a) || 0,
              del: Number(d) || 0,
            });
          }
        }
        if (key() === context) {
          this.commitFiles[hash] = files;
          cx.notify();
        }
      } catch {
        if (key() === context) {
          this.commitFiles[hash] = [];
          cx.notify();
        }
      }
    });
    cx.notify();
  }

  gitAction(args, cx, label = "Git command") {
    if (!this.root || this.busy) return;
    const root = this.root;
    const on = this.on;
    const isRemoteOp = label === "Pull" || label === "Push" || label === "Fetch";
    const branchName = this.branch || "current branch";
    this.busy = true;
    this.busyAction = label;
    this.note = null;
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
        const r = await exec("git", args, { cwd: root, on });
        if (r.code !== 0)
          throw new Error((r.stderr || r.stdout || `${label} failed`).trim());
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

  discardFile(file, cx) {
    if (file.fresh) {
      this.gitAction(["clean", "-f", "--", file.path], cx, "Discard untracked");
    } else {
      this.gitAction(["checkout", "--", file.path], cx, "Discard changes");
    }
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
    const context = this.context;
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
        body: tr("sc.commit_push_progress_body", { branch: this.branch || "changes" }),
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

        if (key() === context) {
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
        if (key() === context)
          this.note = `${andPush ? tr("sc.commit_push") : tr("sc.commit")}: ${e}`;
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
    if (!this.root || this.generating) return;
    const aiCfg = shared("james-changes.ai") ?? {};
    const provider = (aiCfg.provider || "").trim();
    if (!provider) {
      openOverlay({
        mod: "james-settings",
        kind: "dialog",
        width: 600,
        height: 500,
      });
      return;
    }
    const root = this.root;
    const on = this.on;
    const model = (aiCfg.model || "").trim();
    const promptText = (aiCfg.prompt || DEFAULT_PROMPT).trim();

    this.generating = true;
    this.note = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const useStaged = this.staged.length > 0;
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
              ? [...READ, "diff", "--cached", "--stat"]
              : [...READ, "diff", "HEAD", "--stat"],
            { cwd: root, on }
          ),
          exec(
            "git",
            useStaged
              ? [...READ, "diff", "--cached", "--no-color", "--no-ext-diff"]
              : [...READ, "diff", "HEAD", "--no-color", "--no-ext-diff"],
            { cwd: root, on }
          ),
        ]);

        let diffText = (diffRes.stdout || "").trim();
        if (!useStaged && !diffText && this.unstaged.some((f) => f.fresh)) {
          const previews = [];
          for (const f of this.unstaged.filter((u) => u.fresh).slice(0, 12)) {
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

        // Balance diff budget across all changed files when the diff is large
        const MAX_DIFF = 16000;
        let balancedDiff = diffText;
        if (diffText.length > MAX_DIFF) {
          const chunks = diffText.split(/(?=^diff --git )/m).filter(Boolean);
          if (chunks.length > 1) {
            const perFile = Math.max(600, Math.floor(MAX_DIFF / chunks.length));
            balancedDiff = chunks
              .map((c) =>
                c.length > perFile ? c.slice(0, perFile) + "\n… (file diff truncated)" : c
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
        } else {
          cmd =
            pathPrefix +
            `opencode run "$AI_PROMPT"` +
            (model ? ` -m "$AI_MODEL"` : "");
        }

        const r = await exec(
          "env",
          [`AI_PROMPT=${fullPrompt}`, `AI_MODEL=${model}`, "sh", "-c", cmd],
          { cwd: root, on }
        );

        if (r.code !== 0) {
          throw new Error(
            (r.stderr || r.stdout || `${provider} failed`).trim()
          );
        }

        const generated = cleanAiOutput(r.stdout);
        if (!generated) throw new Error("LLM returned an empty response.");

        this.message = generated;
        this.input.set_value(generated);
      } catch (e) {
        this.note = `AI generation error: ${e}`;
      } finally {
        this.generating = false;
        cx.notify();
      }
    });
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@")
      return div()
        .w_full()
        .px(12)
        .h(20)
        .flex_none()
        .truncate()
        .bg(t.raised)
        .text_color(t.dim)
        .child(text);
    return h_flex()
      .w_full()
      .h(20)
      .flex_none()
      .gap(10)
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18"))
      .when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(
        div()
          .w(30)
          .flex_none()
          .text_right()
          .text_color(t.dim)
          .child(number === undefined ? "" : String(number))
      )
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  renderFileRow(f, t) {
    const parts = f.path.split("/");
    const name = parts.pop();
    const isSelected =
      !this.open?.commit &&
      this.open?.path === f.path &&
      this.open?.staged === f.staged;
    const statusColor =
      f.status === "A" || f.status === "U"
        ? "#73c991"
        : f.status === "D"
        ? "#f14c4c"
        : "#4daafc";

    const stageToggleBtn = h_flex()
      .id(`stage-toggle-${f.staged ? "s" : "u"}-${f.path}`)
      .w(18)
      .h(18)
      .rounded(4)
      .items_center()
      .justify_center()
      .hover((s) => s.bg(t.surface))
      .on_mouse_down("left", (_ev, cx) => {
        cx.stop_propagation();
        if (f.staged) this.unstageFile(f.path, cx);
        else this.stageFile(f.path, cx);
      })
      .child(
        svg(f.staged ? ICON.minus : ICON.plus)
          .size(11)
          .text_color(t.muted)
      );

    return h_flex()
      .id(`file-${f.staged ? "s" : "u"}-${f.path}`)
      .h(26)
      .flex_none()
      .pl(12)
      .pr(8)
      .gap(6)
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .when(isSelected, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pickFile(f.path, f.staged, cx))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(5)
          .items_center()
          .child(div().truncate().text_size(12.5).child(name))
          .when(parts.length > 0, (e) =>
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
      .when(f.add > 0, (e) =>
        e.child(div().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`))
      )
      .when(f.del > 0, (e) =>
        e.child(div().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`))
      )
      .when(f.status !== "D", (e) => {
        const openBtn = h_flex()
          .id(`open-file-${f.staged ? "s" : "u"}-${f.path}`)
          .w(18)
          .h(18)
          .rounded(4)
          .items_center()
          .justify_center()
          .hover((s) => s.bg(t.surface))
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            tipState.id = null;
            cx.notify();
            setShared("james-files.openRequest", {
              root: this.root,
              path: f.path,
              ts: Date.now(),
            });
            run("layout.select", { stack: "panel-body", child: "files" });
            run("layout.show", { id: "panel" });
          })
          .child(svg(ICON.file).size(11).text_color(t.muted));
        return e.child(
          tipAbove(
            `open-file-${f.staged ? "s" : "u"}-${f.path}`,
            tr("sc.open_file"),
            openBtn,
            t
          )
        );
      })
      .when(!f.staged, (e) => {
        const discardBtn = h_flex()
          .id(`discard-${f.path}`)
          .w(18)
          .h(18)
          .rounded(4)
          .items_center()
          .justify_center()
          .hover((s) => s.bg(t.surface))
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            this.discardFile(f, cx);
          })
          .child(svg(ICON.undo).size(11).text_color(t.muted));
        return e.child(
          tipAbove(`discard-${f.path}`, tr("sc.discard"), discardBtn, t)
        );
      })
      .child(
        tipAbove(
          `stage-${f.staged ? "s" : "u"}-${f.path}`,
          f.staged ? tr("sc.unstage") : tr("sc.stage"),
          stageToggleBtn,
          t
        )
      )
      .child(
        tipAbove(
          `status-${f.staged ? "s" : "u"}-${f.path}`,
          gitStatusLabel(f.status),
          h_flex()
            .id(`st-badge-${f.staged ? "s" : "u"}-${f.path}`)
            .w(16)
            .h(18)
            .items_center()
            .justify_center()
            .text_size(11)
            .font_weight(600)
            .text_color(statusColor)
            .child(f.status),
          t,
          "bottom_right"
        )
      );
  }

  renderRefPill(ref, t) {
    const isHead = ref.kind === "head";
    const isRemote = ref.kind === "remote";
    const bgColor = isHead
      ? (t.ansi3 ?? t.accent) + "33"
      : isRemote
      ? (t.ansi5 ?? t.accent) + "33"
      : t.raised;
    const fgColor = isHead
      ? t.ansi3 ?? t.accent
      : isRemote
      ? t.ansi5 ?? t.accent
      : t.muted;

    return h_flex()
      .px(6)
      .h(17)
      .gap(4)
      .rounded(9)
      .flex_none()
      .items_center()
      .bg(bgColor)
      .border_1()
      .border_color(fgColor + "66")
      .when(isHead, (e) =>
        e.child(
          div()
            .w(6)
            .h(6)
            .rounded_full()
            .border_1()
            .border_color(fgColor)
        )
      )
      .when(isRemote, (e) =>
        e.child(svg(ICON.cloud).size(10).text_color(fgColor))
      )
      .child(
        div()
          .max_w(95)
          .truncate()
          .text_size(10)
          .font_weight(600)
          .text_color(fgColor)
          .child(ref.name)
      );
  }

  renderCommitRows(t) {
    const out = [];
    const total = this.commits.length;
    this.commits.forEach((c, idx) => {
      const expanded = this.expandedCommit === c.hash;
      const lineColor = c.unpushed ? t.ansi3 ?? t.accent : t.ansi5 ?? t.accent;
      const files = this.commitFiles[c.hash] ?? [];

      out.push(
        h_flex()
          .id(`graph-commit-${c.hash}`)
          .h(26)
          .flex_none()
          .px(8)
          .gap(8)
          .items_center()
          .rounded(5)
          .cursor_pointer()
          .when(expanded, (e) => e.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.toggleCommitExpand(c.hash, cx))
          .child(
            div()
              .w(14)
              .h_full()
              .flex_none()
              .relative()
              .flex()
              .items_center()
              .justify_center()
              .when(idx > 0, (e) =>
                e.child(
                  div()
                    .absolute()
                    .top(0)
                    .h(13)
                    .w(2)
                    .bg(lineColor)
                )
              )
              .when(idx < total - 1 || expanded, (e) =>
                e.child(
                  div()
                    .absolute()
                    .bottom(0)
                    .h(13)
                    .w(2)
                    .bg(lineColor)
                )
              )
              .child(
                c.isHead
                  ? div()
                      .w(9)
                      .h(9)
                      .rounded_full()
                      .bg(t.background)
                      .border_2()
                      .border_color(lineColor)
                  : div().w(7).h(7).rounded_full().bg(lineColor)
              )
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(12)
              .text_color(t.foreground)
              .child(c.subject)
          )
          .when(c.refs.length > 0, (e) =>
            e.children(c.refs.slice(0, 2).map((r) => this.renderRefPill(r, t)))
          )
          .child(
            div()
              .max_w(78)
              .truncate()
              .text_size(10.5)
              .text_color(t.dim)
              .child(c.author)
          )
      );

      const commitAdd = files.reduce((n, f) => n + (f.add || 0), 0);
      const commitDel = files.reduce((n, f) => n + (f.del || 0), 0);
      const showBody = this.expandedBodyHashes.has(c.hash);

      out.push(
        v_flex()
          .id(`graph-commit-files-wrap-${c.hash}`)
          .w_full()
          .flex_none()
          .overflow_hidden()
          .when(!expanded, (e) => e.h(0).opacity(0))
          .when(expanded, (e) => e.opacity(1))
          .transition("opacity", { duration: 130, easing: "ease-out" })
          .when(expanded, (wrap) =>
            wrap.child(
              h_flex()
                .id(`graph-commit-msg-${c.hash}`)
                .w_full()
                .px(8)
                .gap(8)
                .items_stretch()
                .child(
                  div()
                    .w(14)
                    .flex_none()
                    .relative()
                    .flex()
                    .justify_center()
                    .child(div().w(2).h_full().bg(lineColor + "88"))
                )
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .pl(6)
                    .py(4)
                    .gap(4)
                    .child(
                      div()
                        .w_full()
                        .text_size(11.5)
                        .font_weight(500)
                        .text_color(t.foreground)
                        .child(c.subject)
                    )
                    .when(Boolean(c.body), (bEl) =>
                      bEl
                        .when(showBody, (el) =>
                          el.child(
                            div()
                              .w_full()
                              .p(6)
                              .rounded(5)
                              .bg(t.raised)
                              .border_1()
                              .border_color(t.border)
                              .text_size(11)
                              .text_color(t.muted)
                              .child(c.body)
                          )
                        )
                        .child(
                          h_flex().child(
                            div()
                              .id(`graph-body-toggle-${c.hash}`)
                              .px(6)
                              .py(2)
                              .rounded(4)
                              .bg(t.raised)
                              .border_1()
                              .border_color(t.border)
                              .text_size(10.5)
                              .text_color(t.muted)
                              .cursor_pointer()
                              .hover((s) => s.bg(t.hover).text_color(t.foreground))
                              .on_mouse_down("left", (_ev, cx) => {
                                cx.stop_propagation();
                                if (this.expandedBodyHashes.has(c.hash)) {
                                  this.expandedBodyHashes.delete(c.hash);
                                } else {
                                  this.expandedBodyHashes.add(c.hash);
                                }
                                cx.notify();
                              })
                              .child(showBody ? tr("sc.hide_details") : "...")
                          )
                        )
                    )
                )
            )
          )
          .when(expanded && files.length === 0, (wrap) =>
            wrap.child(
              h_flex()
                .id(`graph-commit-empty-${c.hash}`)
                .h(22)
                .flex_none()
                .px(8)
                .gap(8)
                .items_center()
                .child(
                  div()
                    .w(14)
                    .h_full()
                    .flex_none()
                    .relative()
                    .flex()
                    .justify_center()
                    .child(div().w(2).h_full().bg(lineColor))
                )
                .child(
                  div()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(tr("sc.loading_commit_files"))
                )
            )
          )
          .when(expanded && files.length > 0, (wrap) =>
            wrap
              .child(
                h_flex()
                  .id(`graph-commit-summary-${c.hash}`)
                  .h(22)
                  .flex_none()
                  .px(8)
                  .gap(8)
                  .items_center()
                  .child(
                    div()
                      .w(14)
                      .h_full()
                      .flex_none()
                      .relative()
                      .flex()
                      .justify_center()
                      .child(div().w(2).h_full().bg(lineColor + "88"))
                  )
                  .child(
                    div()
                      .flex_1()
                      .pl(6)
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(tr("sc.files_changed", { count: files.length }))
                  )
                  .when(commitAdd > 0, (e) =>
                    e.child(
                      div()
                        .text_size(10.5)
                        .text_color(t.ansi2)
                        .child(`+${commitAdd}`)
                    )
                  )
                  .when(commitDel > 0, (e) =>
                    e.child(
                      div()
                        .text_size(10.5)
                        .text_color(t.ansi1)
                        .child(`−${commitDel}`)
                    )
                  )
              )
              .children(
                files.map((f) => {
                const parts = f.path.split("/");
                const name = parts.pop();
                const isSelected =
                  this.open?.commit === c.hash && this.open?.path === f.path;
                const stColor =
                  f.status === "A" || f.status === "U"
                    ? "#73c991"
                    : f.status === "D"
                    ? "#f14c4c"
                    : "#4daafc";

                return h_flex()
                  .id(`graph-file-${c.hash}-${f.path}`)
                  .h(24)
                  .flex_none()
                  .px(8)
                  .gap(8)
                  .items_center()
                  .rounded(5)
                  .cursor_pointer()
                  .when(isSelected, (e) => e.bg(t.selected))
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) =>
                    this.pickFile(f.path, false, cx, c.hash)
                  )
                  .child(
                    div()
                      .w(14)
                      .h_full()
                      .flex_none()
                      .relative()
                      .flex()
                      .justify_center()
                      .child(div().w(2).h_full().bg(lineColor + "88"))
                  )
                  .child(
                    h_flex()
                      .flex_1()
                      .min_w(0)
                      .pl(6)
                      .gap(5)
                      .items_center()
                      .child(div().truncate().text_size(12).child(name))
                      .when(parts.length > 0, (e) =>
                        e.child(
                          div()
                            .flex_1()
                            .min_w(0)
                            .truncate()
                            .text_size(10.5)
                            .text_color(t.dim)
                            .child(parts.join("/"))
                        )
                      )
                  )
                  .when(f.add > 0, (e) =>
                    e.child(
                      div()
                        .text_size(10)
                        .text_color(t.ansi2)
                        .child(`+${f.add}`)
                    )
                  )
                  .when(f.del > 0, (e) =>
                    e.child(
                      div()
                        .text_size(10)
                        .text_color(t.ansi1)
                        .child(`−${f.del}`)
                    )
                  )
                  .child(
                    tipAbove(
                      `graph-status-${c.hash}-${f.path}`,
                      gitStatusLabel(f.status),
                      h_flex()
                        .id(`graph-st-badge-${c.hash}-${f.path}`)
                        .w(16)
                        .h(18)
                        .items_center()
                        .justify_center()
                        .text_size(10.5)
                        .font_weight(600)
                        .text_color(stColor)
                        .child(f.status),
                      t,
                      "bottom_right"
                    )
                  );
              })
            )
          )
      );
    });
    return out;
  }

  renderRowResizer(id, active, hovered, onHover, onMouseDown, t) {
    return div()
      .id(id)
      .h(5)
      .w_full()
      .flex_none()
      .cursor_row_resize()
      .flex()
      .items_center()
      .on_hover(onHover)
      .on_mouse_down("left", onMouseDown)
      .child(
        div()
          .h(1)
          .w_full()
          .bg(active || hovered ? t.accent : t.border)
      );
  }

  render(cx) {
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
    const { cwd, spaceId } = location();

    const hasStaged = this.staged.length > 0;
    const isResizingAny = Boolean(
      this.resizingCommit || this.resizingGraph || this.resizingDiff
    );

    const hasMeasured = false;
    const availH = 400;
    const stagedBodyH = 0;
    const changesBodyH = 0;
    const graphBodyH = 0;
    const showGraphResizer =
      !this.foldGraphSection &&
      (!this.foldUnstaged || (hasStaged && !this.foldStaged));

    const stagedAdd = this.staged.reduce((n, f) => n + (f.add || 0), 0);
    const stagedDel = this.staged.reduce((n, f) => n + (f.del || 0), 0);
    const unstagedAdd = this.unstaged.reduce((n, f) => n + (f.add || 0), 0);
    const unstagedDel = this.unstaged.reduce((n, f) => n + (f.del || 0), 0);

    const allSectionsFolded =
      this.foldUnstaged &&
      (!hasStaged || this.foldStaged) &&
      this.foldGraphSection;

    // Avoid double border at the bottom of the panel when Graph is collapsed at the bottom
    const graphHeaderHasBottomBorder =
      !this.foldGraphSection || Boolean(this.open) || allSectionsFolded;

    const branchBtn = h_flex()
      .id("sc-branch-btn")
      .h(24)
      .px(8)
      .gap(5)
      .rounded(6)
      .items_center()
      .cursor_pointer()
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .hover((s) => s.bg(t.hover))
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
      .child(svg(ICON.branch).size(11).text_color(t.accent))
      .child(
        div()
          .max_w(120)
          .truncate()
          .text_size(11.5)
          .font_weight(500)
          .child(this.branch || "git")
      );

    const dropdownArrowBtn = h_flex()
      .id("sc-commit-dropdown-btn")
      .w(28)
      .h_full()
      .items_center()
      .justify_center()
      .cursor_pointer()
      .hover((s) => s.opacity(0.85))
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
      .h(28)
      .w_full()
      .rounded(6)
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
            svg(ICON.check)
              .size(13)
              .text_color(canCommit ? t.solid_foreground : t.dim)
          )
          .child(div().child(this.busy ? tr("sc.working") : tr(activeModeObj.labelKey)))
      )
      .child(
        div()
          .w(1)
          .h_full()
          .bg(canCommit ? t.background + "44" : t.border)
      )
      .child(
        tipAbove(
          "more-commit-actions",
          tr("sc.more_commit_actions"),
          dropdownArrowBtn,
          t
        )
      );

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
        if (e.key === "escape") {
          if (this.showCommitMenu) {
            this.showCommitMenu = false;
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
        if (this.resizingGraph) {
          const delta = e.position.y - this.resizingGraph.startY;
          const nextH = Math.max(
            80,
            Math.min(540, Math.round(this.resizingGraph.startH - delta))
          );
          if (nextH !== this.graphHeight) {
            this.graphHeight = nextH;
            cx.notify();
          }
          return;
        }
        if (this.resizingDiff) {
          const delta = e.position.y - this.resizingDiff.startY;
          const nextH = Math.max(
            110,
            Math.min(480, Math.round(this.resizingDiff.startH - delta))
          );
          if (nextH !== this.diffHeight) {
            this.diffHeight = nextH;
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
        if (this.resizingGraph) {
          this.resizingGraph = null;
          setShared("james-changes.graphHeight", this.graphHeight);
          cx.notify();
        }
        if (this.resizingDiff) {
          this.resizingDiff = null;
          setShared("james-changes.diffHeight", this.diffHeight);
          cx.notify();
        }
      })
      .child(
        // Top Panel Header: Source Control + Branch Worktree
        h_flex()
          .h(38)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .rounded_t(9)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome ?? t.background)
          .child(
            div()
              .font_semibold()
              .text_size(13)
              .text_color(t.foreground)
              .child(tr("sc.title"))
          )
          .child(div().flex_1())
          .child(tipAbove("sc-branch", tr("sc.switch_branch"), branchBtn, t))
      )
      .child(
        // Always-visible Commit Composer
        v_flex()
          .flex_none()
          .px(8)
          .pt(8)
          .pb(4)
          .gap(6)
          .bg(t.background)
          .child(
            div()
              .id("sc-commit-input-wrapper")
              .h(this.commitHeight)
              .p(7)
              .relative()
              .rounded(7)
              .border_1()
              .border_color(this.typing ? t.accent : t.border)
              .bg(t.canvas ?? t.background)
              .cursor_text()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(
                Textarea.new(this.input)
                  .size_full()
                  .text_size(12)
                  .text_color(t.foreground)
              )
              .child(
                h_flex()
                  .id("sc-ai-generate-btn")
                  .absolute()
                  .right(6)
                  .bottom(6)
                  .h(22)
                  .px(8)
                  .gap(4)
                  .rounded(5)
                  .items_center()
                  .border_1()
                  .border_color(t.border)
                  .bg(t.raised)
                  .text_size(11)
                  .text_color(this.generating ? t.accent : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_mouse_down("left", (_ev, cx) => {
                    cx.stop_propagation();
                    this.generateAiCommit(cx);
                  })
                  .child(
                    this.generating
                      ? svg(ICON.spinner)
                          .size(11)
                          .text_color(t.accent)
                          .spin(900)
                      : svg(ICON.sparkles).size(11).text_color(t.accent)
                  )
                  .child(
                    div().child(this.generating ? tr("sc.generating") : tr("sc.generate"))
                  )
              )
              .child(
                // Subtle bottom-edge resize zone on the textarea itself
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
          )
      )
      .when(Boolean(this.note), (e) =>
        e.child(
          div()
            .px(10)
            .py(4)
            .flex_none()
            .text_size(11)
            .text_color(t.ansi1)
            .child(this.note)
        )
      )
      .child(
        // 1px Row Resizer for Commit Textarea
        this.renderRowResizer(
          "sc-commit-resizer",
          Boolean(this.resizingCommit),
          this.hoverCommitResizer,
          (hovered, cx) => {
            this.hoverCommitResizer = hovered;
            cx.notify();
          },
          (e, cx) => {
            cx.stop_propagation();
            this.resizingCommit = {
              startY: e.position.y,
              startH: this.commitHeight,
            };
            cx.notify();
          },
          t
        )
      )
      .child(
        v_flex()
          .id("sc-sections-area")
          .flex_1()
          .min_h(0)
          .w_full()
          .overflow_hidden()
          .when(hasStaged, (panel) => {
                const unstageAllBtn = h_flex()
                  .id("sc-unstage-all")
                  .w(18)
                  .h(18)
                  .rounded(4)
                  .items_center()
                  .justify_center()
                  .hover((s) => s.bg(t.surface))
                  .on_mouse_down("left", (_ev, cx) => {
                    cx.stop_propagation();
                    this.unstageAll(cx);
                  })
                  .child(svg(ICON.minus).size(11).text_color(t.muted));

                return panel
                  .child(
                    // Staged Changes Section Header (matching Graph aesthetic)
                    h_flex()
                      .id("sc-staged-section-head")
                      .h(26)
                      .flex_none()
                      .px(10)
                      .gap(5)
                      .items_center()
                      .cursor_pointer()
                      .bg(t.surface ?? t.background)
                      .border_b(1)
                      .border_color(t.border)
                      .hover((s) => s.bg(t.hover))
                      .on_mouse_down("left", (_ev, cx) => {
                        cx.stop_propagation();
                        this.foldStaged = !this.foldStaged;
                        cx.notify();
                      })
                      .child(
                        svg(
                          this.foldStaged
                            ? ICON.chevronRight
                            : ICON.chevronDown
                        )
                          .size(11)
                          .text_color(t.muted)
                      )
                      .child(
                        div()
                          .flex_1()
                          .text_size(11.5)
                          .font_weight(600)
                          .text_color(t.muted)
                          .child(tr("sc.staged_changes"))
                      )
                      .when(stagedAdd > 0, (e) =>
                        e.child(
                          div()
                            .text_size(10.5)
                            .text_color(t.ansi2)
                            .child(`+${stagedAdd}`)
                        )
                      )
                      .when(stagedDel > 0, (e) =>
                        e.child(
                          div()
                            .text_size(10.5)
                            .text_color(t.ansi1)
                            .child(`−${stagedDel}`)
                        )
                      )
                      .child(
                        tipAbove(
                          "unstage-all",
                          tr("sc.unstage_all"),
                          unstageAllBtn,
                          t
                        )
                      )
                      .child(
                        div()
                          .px(5)
                          .rounded(6)
                          .bg(t.raised)
                          .text_size(10.5)
                          .text_color(t.muted)
                          .child(String(this.staged.length))
                      )
                  )
                  .when(!this.foldStaged, (el) =>
                    el.child(
                      v_flex()
                        .id("sc-staged-scroll")
                        .w_full()
                        .max_h(160)
                        .min_h(34)
                        .overflow_y_scroll()
                        .track_scroll(this.stagedScroll)
                        .p(4)
                        .gap(1)
                        .children(
                          this.staged.map((f) => this.renderFileRow(f, t))
                        )
                    )
                  );
              })
              .child(
                // Changes Section Header (matching Graph aesthetic)
                (() => {
                  const stageAllBtn = h_flex()
                    .id("sc-stage-all")
                    .w(18)
                    .h(18)
                    .rounded(4)
                    .items_center()
                    .justify_center()
                    .hover((s) => s.bg(t.surface))
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.stageAll(cx);
                    })
                    .child(svg(ICON.plus).size(11).text_color(t.muted));

                  return h_flex()
                    .id("sc-changes-section-head")
                    .h(26)
                    .flex_none()
                    .px(10)
                    .gap(5)
                    .items_center()
                    .cursor_pointer()
                    .bg(t.surface ?? t.background)
                    .when(hasStaged && !this.foldStaged, (e) =>
                      e.border_t(1).border_color(t.border)
                    )
                    .when(!this.foldUnstaged, (e) =>
                      e.border_b(1).border_color(t.border)
                    )
                    .hover((s) => s.bg(t.hover))
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.foldUnstaged = !this.foldUnstaged;
                      cx.notify();
                    })
                    .child(
                      svg(
                        this.foldUnstaged
                          ? ICON.chevronRight
                          : ICON.chevronDown
                      )
                        .size(11)
                        .text_color(t.muted)
                    )
                    .child(
                      div()
                        .flex_1()
                        .text_size(11.5)
                        .font_weight(600)
                        .text_color(t.muted)
                        .child(tr("sc.changes"))
                    )
                    .when(unstagedAdd > 0, (e) =>
                      e.child(
                        div()
                          .text_size(10.5)
                          .text_color(t.ansi2)
                          .child(`+${unstagedAdd}`)
                      )
                    )
                    .when(unstagedDel > 0, (e) =>
                      e.child(
                        div()
                          .text_size(10.5)
                          .text_color(t.ansi1)
                          .child(`−${unstagedDel}`)
                      )
                    )
                    .when(this.unstaged.length > 0, (e) =>
                      e.child(
                        tipAbove(
                          "stage-all",
                          tr("sc.stage_all"),
                          stageAllBtn,
                          t
                        )
                      )
                    )
                    .child(
                      div()
                        .px(5)
                        .rounded(6)
                        .bg(t.raised)
                        .text_size(10.5)
                        .text_color(t.muted)
                        .child(String(this.unstaged.length))
                    );
                })()
              )
              .when(!this.foldUnstaged, (el) =>
                el.child(
                  v_flex()
                    .id("sc-files-scroll")
                    .flex_1()
                    .min_h(0)
                    .w_full()
                    .overflow_y_scroll()
                    .track_scroll(this.filesScroll)
                    .p(4)
                    .gap(1)
                    .children(
                      this.unstaged.map((f) => this.renderFileRow(f, t))
                    )
                    .when(this.unstaged.length === 0, (e) =>
                      e.child(
                        div()
                          .p(8)
                          .text_size(11.5)
                          .text_color(t.dim)
                          .child(
                            this.error ||
                              (this.loading
                                ? "Checking changes…"
                                : this.root
                                ? hasStaged
                                  ? "All changes are staged"
                                  : "No uncommitted changes"
                                : "No folder")
                          )
                      )
                    )
                )
              )
              .when(showGraphResizer, (panel) =>
                panel.child(
                  this.renderRowResizer(
                    "sc-graph-resizer",
                    Boolean(this.resizingGraph),
                    this.hoverGraphResizer,
                    (hovered, cx) => {
                      this.hoverGraphResizer = hovered;
                      cx.notify();
                    },
                    (e, cx) => {
                      cx.stop_propagation();
                      this.resizingGraph = {
                        startY: e.position.y,
                        startH: this.graphHeight,
                      };
                      cx.notify();
                    },
                    t
                  )
                )
              )
              .child(
                // Section Header: Graph
                (() => {
                  const pullBtn = h_flex()
                    .id("sc-graph-pull")
                    .h(18)
                    .px(4)
                    .gap(3)
                    .rounded(4)
                    .items_center()
                    .hover((s) => s.bg(t.surface))
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.gitAction(["pull", "--ff-only"], cx, "Pull");
                    })
                    .child(
                      this.busy && this.busyAction === "Pull"
                        ? svg(ICON.spinner).size(11).text_color(t.accent).spin(900)
                        : svg(ICON.arrowDown)
                            .size(11)
                            .text_color(this.behind > 0 ? t.accent : t.muted)
                    )
                    .when(this.behind > 0, (e) =>
                      e.child(
                        div()
                          .text_size(10)
                          .text_color(t.accent)
                          .child(String(this.behind))
                      )
                    );

                  const pushBtn = h_flex()
                    .id("sc-graph-push")
                    .h(18)
                    .px(4)
                    .gap(3)
                    .rounded(4)
                    .items_center()
                    .hover((s) => s.bg(t.surface))
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.gitAction(
                        this.hasUpstream
                          ? ["push"]
                          : ["push", "-u", "origin", "HEAD"],
                        cx,
                        "Push"
                      );
                    })
                    .child(
                      this.busy && this.busyAction === "Push"
                        ? svg(ICON.spinner).size(11).text_color(t.accent).spin(900)
                        : svg(ICON.arrowUp)
                            .size(11)
                            .text_color(this.ahead > 0 ? t.accent : t.muted)
                    )
                    .when(this.ahead > 0, (e) =>
                      e.child(
                        div()
                          .text_size(10)
                          .text_color(t.accent)
                          .child(String(this.ahead))
                      )
                    );

                  const refreshBtn = h_flex()
                    .id("sc-graph-refresh")
                    .w(18)
                    .h(18)
                    .rounded(4)
                    .items_center()
                    .justify_center()
                    .hover((s) => s.bg(t.surface))
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.gitAction(["fetch", "--prune"], cx, "Fetch");
                    })
                    .child(
                      this.busy && this.busyAction === "Fetch"
                        ? svg(ICON.spinner).size(11).text_color(t.accent).spin(900)
                        : svg(ICON.refresh).size(11).text_color(t.muted)
                    );

                  return h_flex()
                    .id("sc-graph-section-head")
                    .h(26)
                    .flex_none()
                    .px(10)
                    .gap(5)
                    .items_center()
                    .cursor_pointer()
                    .bg(t.surface ?? t.background)
                    .when(!showGraphResizer, (e) =>
                      e.border_t(1).border_color(t.border)
                    )
                    .when(graphHeaderHasBottomBorder, (e) =>
                      e.border_b(1).border_color(t.border)
                    )
                    .hover((s) => s.bg(t.hover))
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.foldGraphSection = !this.foldGraphSection;
                      cx.notify();
                    })
                    .child(
                      svg(
                        this.foldGraphSection
                          ? ICON.chevronRight
                          : ICON.chevronDown
                      )
                        .size(11)
                        .text_color(t.muted)
                    )
                    .child(
                      div()
                        .flex_1()
                        .text_size(11.5)
                        .font_weight(600)
                        .text_color(t.muted)
                        .child(tr("sc.graph"))
                    )
                    .child(tipAbove("graph-pull", tr("sc.pull"), pullBtn, t))
                    .child(tipAbove("graph-push", tr("sc.push"), pushBtn, t))
                    .child(
                      tipAbove(
                        "graph-refresh",
                        tr("sc.fetch_refresh"),
                        refreshBtn,
                        t
                      )
                    )
                    .child(
                      div()
                        .px(5)
                        .rounded(6)
                        .bg(t.raised)
                        .text_size(10.5)
                        .text_color(t.muted)
                        .child(String(this.commits.length))
                    );
                })()
              )
              .when(!this.foldGraphSection, (el) =>
                el.child(
                  v_flex()
                    .id("sc-graph-scroll")
                    .w_full()
                    .when(this.foldUnstaged, (e) => e.flex_1().min_h(0))
                    .when(!this.foldUnstaged, (e) =>
                      e.flex_none().h(this.graphHeight)
                    )
                    .overflow_y_scroll()
                    .track_scroll(this.graphScroll)
                    .p(4)
                    .gap(1)
                    .children(this.renderCommitRows(t))
                )
              )
              .when(allSectionsFolded && !this.open, (panel) =>
                panel.child(div().flex_1())
              )
      )
      .when(Boolean(this.open), (panel) => {
        const closeDiffBtn = h_flex()
          .id("sc-close-diff")
          .w(20)
          .h(20)
          .rounded(4)
          .items_center()
          .justify_center()
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            this.open = null;
            this.setLines([]);
            cx.notify();
          })
          .child(svg(ICON.close).size(11).text_color(t.muted));

        return panel
          .child(
            this.renderRowResizer(
              "sc-diff-resizer",
              Boolean(this.resizingDiff),
              this.hoverDiffResizer,
              (hovered, cx) => {
                this.hoverDiffResizer = hovered;
                cx.notify();
              },
              (e, cx) => {
                cx.stop_propagation();
                this.resizingDiff = {
                  startY: e.position.y,
                  startH: this.diffHeight,
                };
                cx.notify();
              },
              t
            )
          )
          .child(
            // Collapsible File Diff Inspector at the bottom
            v_flex()
              .flex_none()
              .h(this.diffHeight + 26)
              .child(
                h_flex()
                  .h(26)
                  .flex_none()
                  .px(10)
                  .gap(6)
                  .items_center()
                  .bg(t.surface ?? t.raised)
                  .border_b(1)
                  .border_color(t.border)
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .text_size(11.5)
                      .font_weight(500)
                      .text_color(t.foreground)
                      .child(
                        this.open.commit
                          ? `${this.open.path} (${this.open.commit})`
                          : `${this.open.path} (${
                              this.open.staged ? tr("sc.staged_badge") : tr("sc.working_tree_badge")
                            })`
                      )
                  )
                  .child(tipAbove("close-diff", tr("sc.close_diff"), closeDiffBtn, t))
              )
              .child(
                div()
                  .flex_1()
                  .min_h(0)
                  .relative()
                  .bg(t.canvas ?? t.background)
                  .font_family(settings().font_family ?? "JetBrains Mono")
                  .text_size(11)
                  .child(
                    div()
                      .id("changes-diff-x")
                      .size_full()
                      .overflow_x_scrollbar()
                      .child(
                        div()
                          .w_full()
                          .min_w(this.diffWidth)
                          .h_full()
                          .child(
                            v_virtual_list(
                              "changes-diff",
                              this.rows.length,
                              20,
                              (i) => String(i),
                              (range) =>
                                this.rows
                                  .slice(range.start, range.end)
                                  .map((row) => this.diffRow(row, t))
                            ).size_full()
                          )
                      )
                  )
                  .child(
                    Scrollbar.vertical("changes-diff")
                      .viewport_from_layout()
                      .absolute()
                      .inset_0()
                  )
              )
          );
      });
  }
}
