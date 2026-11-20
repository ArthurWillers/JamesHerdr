// File browser + code editor with VS Code shortcuts, Find (Ctrl+F), Word Wrap (Alt+Z),
// Auto-Save / Ctrl+S, folder git status indicators, and character-level inline HEAD diff view.
import { View, div, svg } from "gpui-kit";
import {
  v_flex,
  h_flex,
  Editor,
  EditorState,
  Input,
  InputState,
  Popup,
  ScrollHandle,
} from "gpui-base";
import {
  spaces,
  panes,
  focused,
  exec,
  readTextFile,
  writeTextFile,
  watchFolder,
  theme,
  settings,
  window,
  shared,
  setShared,
  checking,
  nextCommand,
  appHome,
} from "herdr";
import { tr } from "./i18n.js";

const GIT_STATUS_KEYS = {
  M: "sc.status_M",
  A: "sc.status_A",
  D: "sc.status_D",
  U: "sc.status_U",
  R: "sc.status_R",
  C: "sc.status_C",
  T: "sc.status_T",
};

// Standardized VS Code Git status & gutter colors (theme-independent):
// M (Modified) = Blue, A/U (Added/Untracked) = Green, D (Deleted) = Red
const GIT_COLOR = {
  M: "#4daafc",
  A: "#73c991",
  U: "#73c991",
  D: "#f14c4c",
  R: "#4daafc",
  C: "#4daafc",
  T: "#4daafc",
};

const ICON = {
  wrap: "mods/james-files/wrap.svg",
  diff: "mods/james-chrome/git-compare.svg",
  search: "mods/james-chrome/search.svg",
  close: "mods/james-chrome/x.svg",
  up: "mods/source-control/icons/arrow-up.svg",
  down: "mods/source-control/icons/arrow-down.svg",
  undo: "mods/source-control/icons/undo.svg",
};

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
  const space = spaces().find((s) => s.active),
    f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on =
    f?.pane === null
      ? f.terminal?.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : (space?.machine ?? null);
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  jsx: "js",
  mjs: "js",
  toml: "yaml",
  jsonc: "json",
  svelte: "html",
  vue: "html",
};
const PER_FOLDER = 500,
  TOTAL = 5000;

// Exact character span that changed between oldLine and newLine: { prefix, changed, suffix }
function splitInlineChange(oldLine, newLine) {
  if (oldLine === undefined || oldLine === null || oldLine === newLine) {
    return { prefix: "", changed: newLine, suffix: "" };
  }
  let start = 0;
  const minLen = Math.min(oldLine.length, newLine.length);
  while (start < minLen && oldLine[start] === newLine[start]) start++;
  let endOld = oldLine.length - 1;
  let endNew = newLine.length - 1;
  while (endOld >= start && endNew >= start && oldLine[endOld] === newLine[endNew]) {
    endOld--;
    endNew--;
  }
  return {
    prefix: newLine.slice(0, start),
    changed: newLine.slice(start, endNew + 1),
    suffix: newLine.slice(endNew + 1),
  };
}

// Compute per-line diff and reversible hunks between headText and currentText.
function computeLineDiffs(headText, currentText) {
  const curLines = (currentText ?? "").split("\n");
  if (headText === null || headText === undefined) {
    const hunk = {
      id: 0,
      kind: "add",
      curStart: 0,
      curCount: curLines.length,
      oldLines: [],
      newLines: curLines,
      displayLine: 1,
    };
    return {
      lines: curLines.map((text, i) => ({
        lineNo: i + 1,
        text,
        kind: "add",
        oldText: null,
        deletedBefore: false,
        hunkId: 0,
      })),
      hunks: curLines.length > 0 ? [hunk] : [],
      stats: { add: curLines.length, mod: 0, del: 0 },
    };
  }
  if (headText === currentText) {
    return {
      lines: curLines.map((text, i) => ({
        lineNo: i + 1,
        text,
        kind: "same",
        oldText: text,
        deletedBefore: false,
        hunkId: null,
      })),
      hunks: [],
      stats: { add: 0, mod: 0, del: 0 },
    };
  }

  const oldLines = headText.split("\n");
  let pre = 0;
  const minTotal = Math.min(oldLines.length, curLines.length);
  while (pre < minTotal && oldLines[pre] === curLines[pre]) pre++;

  let suf = 0;
  while (
    suf < minTotal - pre &&
    oldLines[oldLines.length - 1 - suf] === curLines[curLines.length - 1 - suf]
  ) {
    suf++;
  }

  const oldMid = oldLines.slice(pre, oldLines.length - suf);
  const curMid = curLines.slice(pre, curLines.length - suf);

  const out = [];
  for (let i = 0; i < pre; i++) {
    out.push({
      lineNo: i + 1,
      text: curLines[i],
      kind: "same",
      oldText: oldLines[i],
      deletedBefore: false,
      hunkId: null,
    });
  }

  let addCount = 0,
    modCount = 0,
    delCount = 0;
  const hunks = [];

  const flushHunk = (oldChunk, newChunk, curStartIdx) => {
    if (oldChunk.length === 0 && newChunk.length === 0) return;
    const hId = hunks.length;
    const kind =
      oldChunk.length === 0 ? "add" : newChunk.length === 0 ? "del" : "mod";
    hunks.push({
      id: hId,
      kind,
      curStart: curStartIdx,
      curCount: newChunk.length,
      oldLines: [...oldChunk],
      newLines: [...newChunk],
      displayLine: curStartIdx + 1,
    });
    if (newChunk.length === 0) {
      delCount += oldChunk.length;
      if (out.length > 0) {
        out[out.length - 1].deletedBefore = true;
        if (out[out.length - 1].hunkId === null) out[out.length - 1].hunkId = hId;
      }
      return;
    }
    for (let k = 0; k < newChunk.length; k++) {
      const hasOld = k < oldChunk.length;
      if (hasOld) modCount++;
      else addCount++;
      out.push({
        lineNo: out.length + 1,
        text: newChunk[k],
        kind: hasOld ? "mod" : "add",
        oldText: hasOld ? oldChunk[k] : null,
        deletedBefore: k === newChunk.length - 1 && oldChunk.length > newChunk.length,
        hunkId: hId,
      });
    }
    if (oldChunk.length > newChunk.length) {
      delCount += oldChunk.length - newChunk.length;
    }
  };

  const M = oldMid.length,
    N = curMid.length;
  if (M * N <= 16000) {
    const dp = Array.from({ length: M + 1 }, () => new Int32Array(N + 1));
    for (let i = M - 1; i >= 0; i--) {
      for (let j = N - 1; j >= 0; j--) {
        dp[i][j] =
          oldMid[i] === curMid[j]
            ? 1 + dp[i + 1][j + 1]
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0,
      j = 0;
    let pendOld = [];
    let pendNew = [];
    let hunkStart = out.length;
    while (i < M || j < N) {
      if (i < M && j < N && oldMid[i] === curMid[j]) {
        if (pendOld.length > 0 || pendNew.length > 0) {
          flushHunk(pendOld, pendNew, hunkStart);
          pendOld = [];
          pendNew = [];
        }
        out.push({
          lineNo: out.length + 1,
          text: curMid[j],
          kind: "same",
          oldText: oldMid[i],
          deletedBefore: false,
          hunkId: null,
        });
        hunkStart = out.length;
        i++;
        j++;
      } else if (i < M && (j === N || dp[i + 1][j] >= dp[i][j + 1])) {
        if (pendOld.length === 0 && pendNew.length === 0) hunkStart = out.length;
        pendOld.push(oldMid[i]);
        i++;
      } else {
        if (pendOld.length === 0 && pendNew.length === 0) hunkStart = out.length;
        pendNew.push(curMid[j]);
        j++;
      }
    }
    if (pendOld.length > 0 || pendNew.length > 0) {
      flushHunk(pendOld, pendNew, hunkStart);
    }
  } else {
    flushHunk(oldMid, curMid, out.length);
  }

  for (let i = curLines.length - suf; i < curLines.length; i++) {
    out.push({
      lineNo: out.length + 1,
      text: curLines[i],
      kind: "same",
      oldText: curLines[i],
      deletedBefore: false,
      hunkId: null,
    });
  }

  return {
    lines: out,
    hunks,
    stats: { add: addCount, mod: modCount, del: delCount },
  };
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    const r = await exec(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" +
          path.replace(/['‘’‚‛]/g, "$&$&") +
          "'",
      ],
      { on }
    );
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script =
    'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try {
    r = await exec("sh", ["-c", script, "files", path], { on });
  } catch (e) {
    if (on && String(e).includes("cannot start sh: program not found"))
      return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"),
    out = [];
  for (let i = 0; i + 1 < fields.length; i += 2)
    out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Split a line into segments highlighting all case-insensitive occurrences of `query`
function splitSearchHighlights(text, query) {
  if (!query || !text) return [{ text: text || " ", match: false }];
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const parts = [];
  let pos = 0;
  while (pos < text.length) {
    const idx = lower.indexOf(q, pos);
    if (idx === -1) {
      parts.push({ text: text.slice(pos), match: false });
      break;
    }
    if (idx > pos) {
      parts.push({ text: text.slice(pos, idx), match: false });
    }
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    pos = idx + q.length;
  }
  return parts.length > 0 ? parts : [{ text: " ", match: false }];
}

export default class Files extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.dirty = false;
    this.saving = false;
    this.saveNotice = "";
    this.saveError = null;
    this.saveSeq = 0;
    this.lastSavedText = null;
    this.readOnlyFile = false;
    this.lastOpenReqTs = 0;
    this.appliedWordWrap = Boolean(shared("james-files.wordWrap"));

    // Inline HEAD diff state
    this.diffMode = false;
    this.headText = null;
    this.lineDiffs = [];
    this.hunks = [];
    this.diffStats = { add: 0, mod: 0, del: 0 };
    this.diffScroll = ScrollHandle.new();
    this.hoveredDiffLine = null;
    this.hoveredGutterHunk = null;

    // Tree file search state
    this.treeSearchOpen = false;
    this.treeQuery = "";
    this.treeHighlightIdx = 0;
    this.treeSearchScroll = ScrollHandle.new();
    this.allFiles = [];
    this.loadingAllFiles = false;
    this.treeSearchInput = InputState.new({
      placeholder: tr("files.search_files_placeholder"),
    });
    this.treeSearchInput.on("change", (_ev, cx) => {
      this.treeQuery = this.treeSearchInput.value();
      this.treeHighlightIdx = 0;
      cx.notify();
    });
    this.treeSearchInput.on("submit", (_ev, cx) => {
      const hits = this.filteredTreeFiles();
      const pick = hits[this.treeHighlightIdx] ?? hits[0];
      if (pick) this.show(pick, cx);
    });

    // Find in file state
    this.findOpen = false;
    this.findQuery = "";
    this.findMatches = [];
    this.findIndex = 0;
    this.findInput = InputState.new({
      placeholder: tr("files.find_placeholder"),
    });
    this.findInput.on("change", (_ev, cx) => {
      this.findQuery = this.findInput.value();
      this.recomputeMatches();
      if (this.findMatches.length > 0) this.jumpToMatch(0, false, cx);
      cx.notify();
    });
    this.findInput.on("submit", (ev, cx) => {
      // Never move focus to the Editor on Enter in the Find input so repeated Enter
      // cycles through matches instead of inserting a line break in the file.
      this.stepMatch(ev?.shift ? -1 : 1, false, cx);
      this.findInput.focus();
    });

    cx.bind_keys([
      { keystroke: "ctrl-s", action: "james_files_save", context: "JamesFiles" },
      { keystroke: "cmd-s", action: "james_files_save", context: "JamesFiles" },
      { keystroke: "alt-z", action: "james_files_wrap", context: "JamesFiles" },
      { keystroke: "alt-d", action: "james_files_diff", context: "JamesFiles" },
      { keystroke: "f3", action: "james_files_next", context: "JamesFiles" },
      { keystroke: "shift-f3", action: "james_files_prev", context: "JamesFiles" },
      { keystroke: "escape", action: "james_files_escape", context: "JamesFiles" },
    ]);

    if (!checking()) {
      // Ensure mod:james-files keybindings exist in ~/.config/herdr-app/keys.json
      cx.spawn(async () => {
        try {
          const kp = `${appHome()}/keys.json`;
          const raw = await readTextFile(kp);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (!parsed["mod:james-files"]) {
              parsed["mod:james-files"] = {
                "ctrl-s": "james-files.save",
                "alt-z": "james-files.toggle_wrap",
                "alt-d": "james-files.toggle_diff",
                "f3": "james-files.find_next",
                "shift-f3": "james-files.find_prev",
                "escape": "james-files.escape",
              };
              await writeTextFile(kp, JSON.stringify(parsed, null, 2) + "\n", raw);
            }
          }
        } catch {
          // ignore
        }
      });

      // Listen for Herdr mod:james-files commands (works even when native Editor has focus)
      cx.spawn(async (cx) => {
        for (;;) {
          const cmd = await nextCommand();
          if (cmd === "save") {
            if (this.file && this.code && !this.readOnlyFile) this.saveFile(cx);
          } else if (cmd === "find") {
            this.openFindBar(cx);
          } else if (cmd === "find_next") {
            this.stepMatch(1, false, cx);
          } else if (cmd === "find_prev") {
            this.stepMatch(-1, false, cx);
          } else if (cmd === "toggle_wrap") {
            const nextWrap = !Boolean(shared("james-files.wordWrap"));
            setShared("james-files.wordWrap", nextWrap);
            this.applyWordWrap(nextWrap, cx);
          } else if (cmd === "toggle_diff") {
            this.toggleDiffMode(cx);
          } else if (cmd === "escape") {
            this.handleEscape(cx);
          }
        }
      });
    }

    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        while (this.context === context) {
          await watchFolder(root);
          if (this.current(context)) this.refresh(cx);
        }
      } catch {
        if (this.context === context) this.watched = null;
      }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()]
      .filter(([p]) => p !== path)
      .reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(
      path,
      entries
        .slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    );
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL)
      this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(),
      next = key();
    if (next !== this.context?.key) {
      if (this.context)
        this.saved.set(this.context.key, {
          folders: this.folders,
          file: this.file,
        });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on };
      this.root = cwd;
      this.on = on;
      this.entries = new Map();
      this.folders = new Set(saved?.folders);
      this.pending = new Set();
      this.marks = {};
      this.show(null);
      this.watched = null;
      this.error = null;
      this.limited = false;
      this.loading = false;
      this.allFiles = [];
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], {
          cwd,
          on,
        }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const status = await exec(
            "git",
            [
              "--no-optional-locks",
              "-c",
              "core.fsmonitor=false",
              "status",
              "--porcelain=v1",
              "-z",
              "--no-renames",
              "--untracked-files=all",
            ],
            { cwd, on }
          ).catch(() => null);
          if (status?.code === 0)
            for (const entry of status.stdout
              .split("\0")
              .filter(Boolean)
              .slice(0, TOTAL)) {
              const xy = entry.slice(0, 2);
              marks[`${top.stdout.trim()}/${entry.slice(3)}`] =
                xy === "??"
                  ? "U"
                  : xy.includes("A")
                    ? "A"
                    : xy.includes("D")
                      ? "D"
                      : xy.includes("U")
                        ? "U"
                        : "M";
            }
        }
        if (!this.current(context)) return;
        this.marks = marks;
        this.error = null;
        this.watch(cwd, cx);
      } catch (e) {
        if (this.current(context)) this.error = String(e);
      } finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  // Returns aggregate Git status for a folder ("M" if any modified/deleted file inside, "U" if added/untracked)
  folderGitMark(fullFolderPath) {
    const prefix = `${fullFolderPath}/`;
    let found = null;
    for (const [k, v] of Object.entries(this.marks)) {
      if (k.startsWith(prefix)) {
        if (v === "M" || v === "D") return "M";
        found = v;
      }
    }
    return found;
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders])
        if (folder === path || folder.startsWith(path + "/")) {
          this.folders.delete(folder);
          this.entries.delete(folder);
        }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try {
            await this.loadFolder(path, context);
          } catch (e) {
            if (this.current(context)) this.error = String(e);
          } finally {
            if (this.context === context) this.pending.delete(path);
            cx.notify();
          }
        });
      }
    }
    cx.notify();
  }

  loadAllFiles(cx) {
    if (!this.root || this.loadingAllFiles) return;
    const context = this.context,
      root = this.root,
      on = this.on;
    this.loadingAllFiles = true;
    cx.spawn(async (cx) => {
      try {
        let r = await exec(
          "git",
          [
            "--no-optional-locks",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
          ],
          { cwd: root, on }
        ).catch(() => null);
        let list = [];
        if (r?.code === 0 && r.stdout) {
          list = r.stdout.split("\0").filter(Boolean).slice(0, TOTAL);
        } else {
          const findRes = await exec(
            "sh",
            [
              "-c",
              'find . -maxdepth 6 -not -path "*/.git/*" -not -path "*/node_modules/*" -type f | sed "s|^\\./||" | head -n 2000',
            ],
            { cwd: root, on }
          ).catch(() => null);
          if (findRes?.code === 0 && findRes.stdout) {
            list = findRes.stdout.split("\n").filter(Boolean);
          }
        }
        if (this.current(context)) {
          this.allFiles = list.sort((a, b) => a.localeCompare(b));
        }
      } finally {
        if (this.current(context)) this.loadingAllFiles = false;
        cx.notify();
      }
    });
  }

  filteredTreeFiles() {
    const q = this.treeQuery.trim().toLowerCase();
    if (!q) return [];
    const pool =
      this.allFiles.length > 0
        ? this.allFiles
        : [...this.entries.entries()].flatMap(([dir, list]) =>
            list
              .filter((e) => !e.dir)
              .map((e) => (dir ? `${dir}/${e.name}` : e.name))
          );
    return pool.filter((p) => p.toLowerCase().includes(q)).slice(0, 200);
  }

  toggleTreeSearch(cx) {
    this.treeSearchOpen = !this.treeSearchOpen;
    if (this.treeSearchOpen) {
      if (this.allFiles.length === 0) this.loadAllFiles(cx);
      this.treeSearchInput.focus();
      cx.timer.after(20, () => {
        if (this.treeSearchOpen) this.treeSearchInput.focus();
      });
      cx.timer.after(80, () => {
        if (this.treeSearchOpen) this.treeSearchInput.focus();
      });
    } else {
      this.treeQuery = "";
      this.treeHighlightIdx = 0;
      this.treeSearchInput.set_value("");
    }
    cx.notify();
  }

  recomputeDiff(currentText) {
    const res = computeLineDiffs(this.headText, currentText);
    this.lineDiffs = res.lines;
    this.hunks = res.hunks ?? [];
    this.diffStats = res.stats;
  }

  revertHunk(hunkId, cx) {
    if (hunkId === null || hunkId === undefined || !this.code || this.readOnlyFile)
      return;
    const h = this.hunks.find((x) => x.id === hunkId);
    if (!h) return;
    const curLines = this.code.value().split("\n");
    curLines.splice(h.curStart, h.curCount, ...h.oldLines);
    const nextText = curLines.join("\n");
    this.code.set_value(nextText);
    this.dirty = nextText !== this.lastSavedText;
    this.recomputeDiff(nextText);
    if (this.findOpen) this.recomputeMatches();
    if (shared("james-files.autoSave") !== false) {
      this.saveFile(cx);
    }
    cx.notify();
  }

  lineStartOffset(text, targetLine) {
    if (targetLine <= 0) return 0;
    let offset = 0;
    let curLine = 0;
    while (curLine < targetLine && offset < text.length) {
      const nl = text.indexOf("\n", offset);
      if (nl === -1) return text.length;
      offset = nl + 1;
      curLine++;
    }
    return offset;
  }

  // Scrolls GPUI's Editor so targetLine lands near the vertical center of the viewport,
  // and places a collapsed cursor (no text selection!) at targetOffset.
  centerOffsetInEditor(targetOffset, targetLine, cx) {
    if (!this.code) return;
    const text = this.code.value();
    const totalLines = text.split("\n").length;
    const aboveLine = Math.max(0, targetLine - 10);
    const belowLine = Math.min(totalLines - 1, targetLine + 10);
    const aboveOffset = this.lineStartOffset(text, aboveLine);
    const belowOffset = this.lineStartOffset(text, belowLine);

    this.code.set_selected_range({ start: aboveOffset, end: aboveOffset });
    this.code.set_selected_range({ start: belowOffset, end: belowOffset });
    this.code.set_selected_range({ start: targetOffset, end: targetOffset });
    cx?.timer?.after(12, (tCx) => {
      if (this.code) {
        this.code.set_selected_range({ start: targetOffset, end: targetOffset });
        tCx.notify();
      }
    });
  }

  recomputeMatches() {
    const q = (this.findQuery ?? "").toLowerCase();
    const text = this.code ? this.code.value() : (this.lastSavedText ?? "");
    if (!q || !text) {
      this.findMatches = [];
      this.findIndex = 0;
      return;
    }
    const lower = text.toLowerCase();
    const matches = [];
    const lines = text.split("\n");
    let pos = 0;
    let line = 0;
    let lineStart = 0;
    let lastPos = 0;
    while (pos <= lower.length - q.length && matches.length < 1000) {
      const idx = lower.indexOf(q, pos);
      if (idx === -1) break;
      for (let k = lastPos; k < idx; k++) {
        if (lower.charCodeAt(k) === 10) {
          line++;
          lineStart = k + 1;
        }
      }
      lastPos = idx;
      const col = idx - lineStart;
      const lineText = lines[line] ?? "";
      matches.push({
        start: idx,
        end: idx + q.length,
        line,
        col,
        lineText,
      });
      pos = idx + Math.max(1, q.length);
    }
    this.findMatches = matches;
    if (this.findIndex >= matches.length) this.findIndex = 0;
  }

  jumpToMatch(idx, focusEditor, cx) {
    if (this.findMatches.length === 0) return;
    const norm =
      ((idx % this.findMatches.length) + this.findMatches.length) %
      this.findMatches.length;
    this.findIndex = norm;
    const m = this.findMatches[norm];
    if (this.diffMode) {
      // Scroll to m.line - 7 so the matched line sits in the vertical center of the panel
      this.diffScroll.scroll_to_item(Math.max(0, m.line - 7));
    } else if (this.code) {
      // Center the line in the Editor with a collapsed cursor (no text selection!)
      this.centerOffsetInEditor(m.start, m.line, cx);
      if (focusEditor) {
        this.code.focus();
      }
    }
    cx?.notify();
  }

  stepMatch(delta, focusEditor, cx) {
    if (this.findMatches.length === 0) return;
    this.jumpToMatch(this.findIndex + delta, focusEditor, cx);
  }

  openFindBar(cx) {
    if (!this.file || !this.code) return;
    this.findOpen = true;
    this.recomputeMatches();
    this.findInput.focus();
    cx.timer.after(20, () => {
      if (this.findOpen) this.findInput.focus();
    });
    cx.timer.after(80, () => {
      if (this.findOpen) this.findInput.focus();
    });
    cx.notify();
  }

  closeFindBar(cx) {
    if (!this.findOpen) return;
    this.findOpen = false;
    if (!this.diffMode && this.code) this.code.focus();
    cx.notify();
  }

  handleEscape(cx) {
    if (this.findOpen) {
      this.closeFindBar(cx);
      return true;
    }
    if (this.diffMode) {
      this.diffMode = false;
      cx.notify();
      return true;
    }
    if (this.file) {
      this.show(null, cx);
      cx.notify();
      return true;
    }
    if (this.treeSearchOpen) {
      this.treeSearchOpen = false;
      this.treeQuery = "";
      this.treeHighlightIdx = 0;
      this.treeSearchInput.set_value("");
      cx.notify();
      return true;
    }
    return false;
  }

  jumpToLineInEditor(lineZeroIdx, cx) {
    this.diffMode = false;
    if (this.code) {
      const text = this.code.value();
      const offset = this.lineStartOffset(text, lineZeroIdx);
      this.centerOffsetInEditor(offset, lineZeroIdx, cx);
      cx.timer.after(20, () => {
        if (this.code && !this.diffMode) this.code.focus();
      });
    }
    cx.notify();
  }

  saveFile(cx) {
    if (!this.code || !this.file || this.readOnlyFile || this.on || this.saving || !cx)
      return;
    const nextText = this.code.value();
    if (nextText === this.lastSavedText) {
      this.dirty = false;
      cx.notify();
      return;
    }
    const targetPath = `${this.root}/${this.file}`;
    const expected = this.lastSavedText;
    const fileRef = this.file;
    this.saving = true;
    this.saveError = null;
    this.saveNotice = "";
    cx.notify();
    cx.spawn(async (taskCx) => {
      try {
        try {
          await writeTextFile(targetPath, nextText, expected);
        } catch {
          // If snapshot on disk changed externally, read fresh snapshot and overwrite atomically
          const diskNow = await readTextFile(targetPath);
          await writeTextFile(targetPath, nextText, diskNow);
        }
        if (this.file === fileRef) {
          this.lastSavedText = nextText;
          this.dirty = this.code ? this.code.value() !== nextText : false;
          if (this.diffMode) this.recomputeDiff(nextText);
          this.saveNotice = "saved";
          const noticeSeq = ++this.saveSeq;
          taskCx.timer.after(2000, (timerCx) => {
            if (this.saveSeq === noticeSeq && this.saveNotice === "saved") {
              this.saveNotice = "";
              timerCx.notify();
            }
          });
        }
      } catch (e) {
        if (this.file === fileRef) this.saveError = String(e);
      } finally {
        this.saving = false;
        taskCx.notify();
      }
    });
  }

  deferRelease(ed, cx) {
    if (!ed) return;
    if (cx?.timer) cx.timer.after(100, () => ed.release());
    else ed.release();
  }

  createEditor(path, text, readOnly, softWrap) {
    const t = theme(),
      ext = path.includes(".") ? path.split(".").pop() : "txt";
    const ed = EditorState.new({
      language: LANG[ext] ?? ext,
      readonly: readOnly,
      soft_wrap: softWrap,
      value: text,
      font_family: settings().font_family,
      font_size: 12,
      syntax: {
        keyword: t.ansi5,
        string: t.ansi2,
        comment: t.dim,
        function: t.ansi4,
        type: t.ansi3,
        number: t.ansi1,
        constant: t.ansi6,
      },
    });
    if (!readOnly) {
      ed.on("change", (_ev, cx) => {
        if (!this.code || this.file !== path) return;
        const val = this.code.value();
        this.dirty = val !== this.lastSavedText;
        this.saveError = null;
        this.saveNotice = "";
        if (this.diffMode) this.recomputeDiff(val);
        if (this.findOpen) this.recomputeMatches();
        if (this.dirty && shared("james-files.autoSave") !== false) {
          const seq = ++this.saveSeq;
          const delay = Number(shared("james-files.autoSaveDelay") ?? 1000);
          cx.timer.after(delay, (timerCx) => {
            if (this.saveSeq === seq && this.dirty && this.file === path) {
              this.saveFile(timerCx);
            }
          });
        }
        cx.notify();
      });
    }
    return ed;
  }

  applyWordWrap(wrap, cx) {
    if (!this.code || !this.file || wrap === this.appliedWordWrap) return;
    const prev = this.code;
    const currentVal = prev.value();
    const sel = prev.selected_range();
    this.appliedWordWrap = wrap;
    this.code = this.createEditor(this.file, currentVal, this.readOnlyFile, wrap);
    this.code.set_selected_range(sel);
    this.deferRelease(prev, cx);
    cx.notify();
  }

  toggleDiffMode(cx) {
    if (!this.file || !this.code) return;
    this.diffMode = !this.diffMode;
    if (this.diffMode) {
      this.recomputeDiff(this.code.value());
      const firstChanged = this.lineDiffs.findIndex(
        (l) => l.kind !== "same" || l.deletedBefore
      );
      if (firstChanged >= 0) {
        cx.timer.after(20, () => {
          this.diffScroll.scroll_to_item(Math.max(0, firstChanged - 3));
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    if (!path && this.dirty && shared("james-files.autoSave") !== false && cx) {
      this.saveFile(cx);
    }
    this.saveSeq++;
    const prev = this.code;
    this.code = null;
    this.deferRelease(prev, cx);
    this.file = path;
    this.fileError = null;
    this.dirty = false;
    this.saving = false;
    this.saveNotice = "";
    this.saveError = null;
    this.lastSavedText = null;
    this.readOnlyFile = false;
    this.diffMode = false;
    this.headText = null;
    this.lineDiffs = [];
    this.diffStats = { add: 0, mod: 0, del: 0 };
    if (!path || !cx) return;
    const context = this.context,
      root = this.root,
      on = this.on;
    cx.spawn(async (cx) => {
      try {
        const [text, headRes] = await Promise.all([
          readTextFile(`${root}/${path}`, { on }),
          exec("git", ["--no-optional-locks", "show", `HEAD:${path}`], {
            cwd: root,
            on,
          }).catch(() => null),
        ]);
        if (this.file !== path || !this.current(context)) return;
        if (text === null) {
          this.fileError = tr("files.unavailable");
          return;
        }
        if (text.includes("\0")) {
          this.fileError = tr("files.binary");
          return;
        }
        const tooLarge = text.length > 400000;
        const readOnly = Boolean(on) || tooLarge;
        this.readOnlyFile = readOnly;
        this.lastSavedText = text;
        this.headText = headRes?.code === 0 ? headRes.stdout : null;
        const wrap = Boolean(shared("james-files.wordWrap"));
        this.appliedWordWrap = wrap;
        const initialText = tooLarge
          ? text.slice(0, 400000) + "\n… (file truncated)"
          : text;
        this.code = this.createEditor(path, initialText, readOnly, wrap);
        if (this.findOpen) this.recomputeMatches();
        cx.timer.after(20, () => {
          if (this.code && !this.findOpen && !this.diffMode) this.code.focus();
        });
      } catch {
        if (this.file === path && this.current(context))
          this.fileError = tr("files.unreadable");
      } finally {
        cx.notify();
      }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const open = this.folders.has(path);
      const fullPath = `${this.root}/${path}`;
      const mark = entry.dir ? this.folderGitMark(fullPath) : this.marks[fullPath];
      const markColor = mark ? (GIT_COLOR[mark] ?? GIT_COLOR.M) : null;

      out.push(
        h_flex()
          .id(`file-${path}`)
          .h(28)
          .flex_none()
          .pl(8 + depth * 18)
          .pr(8)
          .gap(7)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) =>
            entry.dir ? this.toggle(path, cx) : this.show(path, cx)
          )
          .child(
            entry.dir
              ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`)
                  .size(12)
                  .flex_none()
                  .text_color(t.dim)
              : div().w(12).flex_none()
          )
          .child(
            svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`)
              .size(14)
              .flex_none()
              .text_color(entry.dir && markColor ? markColor : t.muted)
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .when(Boolean(markColor), (d) => d.text_color(markColor))
              .child(entry.name)
          )
          .when(Boolean(mark && !entry.dir), (el) => {
            const badge = h_flex()
              .id(`file-st-badge-${path}`)
              .w(18)
              .h(18)
              .items_center()
              .justify_center()
              .text_size(11)
              .font_weight(600)
              .text_color(markColor ?? t.blocked)
              .child(mark);
            const tip = GIT_STATUS_KEYS[mark] ? tr(GIT_STATUS_KEYS[mark]) : mark;
            return el.child(
              tipAbove(`file-st-${path}`, tip, badge, t, "bottom_right")
            );
          })
          .when(Boolean(mark && entry.dir), (el) => {
            const dot = h_flex()
              .id(`folder-st-dot-${path}`)
              .w(18)
              .h(18)
              .items_center()
              .justify_center()
              .child(div().size(6).rounded(3).bg(markColor ?? t.blocked));
            return el.child(
              tipAbove(
                `folder-st-${path}`,
                tr("files.folder_modified"),
                dot,
                t,
                "bottom_right"
              )
            );
          })
      );
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  renderTreeSearchBar(t) {
    return h_flex()
      .id("files-tree-search-bar")
      .h(34)
      .px(10)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome ?? t.raised)
      .on_key_down((e, cx) => {
        const k = (e.key ?? "").toLowerCase();
        if (k === "escape") {
          cx.stop_propagation();
          this.treeSearchOpen = false;
          this.treeQuery = "";
          this.treeHighlightIdx = 0;
          this.treeSearchInput.set_value("");
          cx.notify();
          return;
        }
        const hits = this.filteredTreeFiles();
        if (hits.length === 0) return;
        const cur = Math.max(0, Math.min(this.treeHighlightIdx, hits.length - 1));
        if (k === "down" || k === "arrowdown") {
          cx.stop_propagation();
          this.treeHighlightIdx = (cur + 1) % hits.length;
          this.treeSearchScroll.scroll_to_item(this.treeHighlightIdx);
          cx.notify();
        } else if (k === "up" || k === "arrowup") {
          cx.stop_propagation();
          this.treeHighlightIdx = (cur - 1 + hits.length) % hits.length;
          this.treeSearchScroll.scroll_to_item(this.treeHighlightIdx);
          cx.notify();
        } else if (k === "enter" || k === "return") {
          cx.stop_propagation();
          const pick = hits[cur];
          if (pick) this.show(pick, cx);
        }
      })
      .child(svg(ICON.search).size(13).flex_none().text_color(t.muted))
      .child(
        Input.new(this.treeSearchInput)
          .flex_1()
          .h(24)
          .px(8)
          .rounded(5)
          .border_1()
          .border_color(t.accent)
          .bg(t.canvas ?? t.background)
          .text_size(12)
          .text_color(t.foreground)
      )
      .child(
        h_flex()
          .id("files-tree-search-close")
          .w(22)
          .h(22)
          .rounded(4)
          .items_center()
          .justify_center()
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_ev, cx) => {
            cx.stop_propagation();
            this.treeSearchOpen = false;
            this.treeQuery = "";
            this.treeSearchInput.set_value("");
            cx.notify();
          })
          .child(svg(ICON.close).size(12).text_color(t.muted))
      );
  }

  renderTreeSearchResults(t) {
    const hits = this.filteredTreeFiles();
    if (this.loadingAllFiles && hits.length === 0) {
      return div()
        .p(12)
        .text_size(12)
        .text_color(t.dim)
        .child(tr("files.loading_files"));
    }
    if (hits.length === 0) {
      return div()
        .p(12)
        .text_size(12)
        .text_color(t.dim)
        .child(tr("files.no_matching_files"));
    }
    const clampedIdx =
      hits.length === 0
        ? 0
        : Math.max(0, Math.min(this.treeHighlightIdx, hits.length - 1));
    return v_flex()
      .id("files-tree-search-results")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .track_scroll(this.treeSearchScroll)
      .p(6)
      .children(
        hits.map((path, idx) => {
          const parts = path.split("/");
          const name = parts.pop();
          const dir = parts.join("/");
          const mark = this.marks[`${this.root}/${path}`];
          const markColor = mark ? (GIT_COLOR[mark] ?? GIT_COLOR.M) : null;
          const highlighted = idx === clampedIdx;
          return h_flex()
            .id(`file-hit-${path}`)
            .h(28)
            .flex_none()
            .px(8)
            .gap(7)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .when(highlighted, (s) => s.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.show(path, cx))
            .child(
              svg("mods/files/file.svg")
                .size(14)
                .flex_none()
                .text_color(t.muted)
            )
            .child(
              div()
                .flex_none()
                .when(Boolean(markColor), (d) => d.text_color(markColor))
                .child(name)
            )
            .when(Boolean(dir), (el) =>
              el.child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(11)
                  .text_color(t.dim)
                  .child(dir)
              )
            )
            .when(!dir, (el) => el.child(div().flex_1()))
            .when(Boolean(mark), (el) => {
              const badge = h_flex()
                .id(`hit-st-badge-${path}`)
                .w(18)
                .h(18)
                .items_center()
                .justify_center()
                .text_size(11)
                .font_weight(600)
                .text_color(markColor ?? GIT_COLOR.M)
                .child(mark);
              const tip = GIT_STATUS_KEYS[mark] ? tr(GIT_STATUS_KEYS[mark]) : mark;
              return el.child(
                tipAbove(`hit-st-${path}`, tip, badge, t, "bottom_right")
              );
            });
        })
      );
  }

  renderFindBar(t) {
    const countLabel =
      !this.findQuery
        ? ""
        : this.findMatches.length === 0
          ? tr("files.find_none")
          : tr("files.find_count", {
              current: this.findIndex + 1,
              total: this.findMatches.length,
            });
    const curMatch =
      this.findMatches.length > 0 ? this.findMatches[this.findIndex] : null;
    const monoFont = settings().font_family;

    let previewBefore = "";
    let previewHit = "";
    let previewAfter = "";
    if (curMatch && curMatch.lineText) {
      const lt = curMatch.lineText;
      const qLen = (this.findQuery ?? "").length;
      const cStart = Math.max(0, curMatch.col - 28);
      const cEnd = Math.min(lt.length, curMatch.col + qLen + 36);
      previewBefore =
        (cStart > 0 ? "…" : "") + lt.slice(cStart, curMatch.col);
      previewHit = lt.slice(curMatch.col, curMatch.col + qLen);
      previewAfter =
        lt.slice(curMatch.col + qLen, cEnd) + (cEnd < lt.length ? "…" : "");
    }

    return v_flex()
      .id("files-find-container")
      .w_full()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome ?? t.raised)
      .on_key_down((e, cx) => {
        const k = (e.key ?? "").toLowerCase();
        if (k === "escape") {
          cx.stop_propagation();
          this.closeFindBar(cx);
        } else if (k === "down" || k === "arrowdown") {
          cx.stop_propagation();
          this.stepMatch(1, false, cx);
        } else if (k === "up" || k === "arrowup") {
          cx.stop_propagation();
          this.stepMatch(-1, false, cx);
        }
      })
      .child(
        h_flex()
          .id("files-find-bar")
          .h(34)
          .px(10)
          .gap(6)
          .items_center()
          .child(svg(ICON.search).size(13).flex_none().text_color(t.muted))
          .child(
            Input.new(this.findInput)
              .flex_1()
              .h(24)
              .px(8)
              .rounded(5)
              .border_1()
              .border_color(t.accent)
              .bg(t.canvas ?? t.background)
              .text_size(12)
              .text_color(t.foreground)
          )
          .when(Boolean(countLabel), (el) =>
            el.child(
              div()
                .flex_none()
                .px(4)
                .text_size(11)
                .text_color(this.findMatches.length === 0 ? t.ansi1 : t.dim)
                .child(countLabel)
            )
          )
          .child(
            h_flex()
              .id("files-find-prev")
              .w(22)
              .h(22)
              .rounded(4)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_ev, cx) => {
                cx.stop_propagation();
                this.stepMatch(-1, false, cx);
                this.findInput.focus();
              })
              .child(svg(ICON.up).size(12).text_color(t.muted))
          )
          .child(
            h_flex()
              .id("files-find-next")
              .w(22)
              .h(22)
              .rounded(4)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_ev, cx) => {
                cx.stop_propagation();
                this.stepMatch(1, false, cx);
                this.findInput.focus();
              })
              .child(svg(ICON.down).size(12).text_color(t.muted))
          )
          .child(
            h_flex()
              .id("files-find-close")
              .w(22)
              .h(22)
              .rounded(4)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_ev, cx) => {
                cx.stop_propagation();
                this.closeFindBar(cx);
              })
              .child(svg(ICON.close).size(12).text_color(t.muted))
          )
      )
      .when(Boolean(curMatch && !this.diffMode), (el) =>
        el.child(
          h_flex()
            .id("files-find-match-preview")
            .h(24)
            .px(10)
            .gap(6)
            .items_center()
            .border_t(1)
            .border_color(t.border)
            .bg(t.canvas ?? t.background)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_mouse_down("left", (_ev, cx) => {
              cx.stop_propagation();
              this.jumpToMatch(this.findIndex, true, cx);
            })
            .child(
              div()
                .flex_none()
                .text_size(10.5)
                .font_family(monoFont)
                .text_color(t.accent)
                .child(`Ln ${curMatch.line + 1}:${curMatch.col + 1}`)
            )
            .child(
              h_flex()
                .flex_1()
                .min_w(0)
                .items_center()
                .overflow_hidden()
                .font_family(monoFont)
                .text_size(11.5)
                .text_color(t.muted)
                .when(Boolean(previewBefore), (p) =>
                  p.child(div().child(previewBefore))
                )
                .child(
                  div()
                    .px(3)
                    .rounded(3)
                    .bg(t.blocked + "55")
                    .font_weight(600)
                    .text_color(t.foreground)
                    .child(previewHit)
                )
                .when(Boolean(previewAfter), (p) =>
                  p.child(div().truncate().child(previewAfter))
                )
            )
        )
      );
  }

  renderHunkTooltipContent(hunk, t) {
    const monoFont = settings().font_family;
    const title =
      hunk.kind === "add"
        ? tr("files.hunk_added", { line: hunk.displayLine })
        : hunk.kind === "del"
          ? tr("files.hunk_deleted", {
              count: hunk.oldLines.length,
              line: hunk.displayLine,
            })
          : tr("files.hunk_modified", { line: hunk.displayLine });
    const badgeColor =
      hunk.kind === "add"
        ? GIT_COLOR.A
        : hunk.kind === "del"
          ? GIT_COLOR.D
          : GIT_COLOR.M;

    return v_flex()
      .w(340)
      .p(8)
      .gap(6)
      .mb(4)
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.popover ?? t.surface)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            div()
              .text_size(11.5)
              .font_weight(600)
              .text_color(badgeColor)
              .child(title)
          )
          .child(
            div()
              .text_size(10.5)
              .text_color(t.dim)
              .child(tr("files.revert_hunk"))
          )
      )
      .when(hunk.oldLines.length > 0, (box) =>
        box
          .child(
            div()
              .text_size(10.5)
              .text_color(t.muted)
              .child(tr("files.before_head"))
          )
          .child(
            v_flex()
              .w_full()
              .p(6)
              .gap(2)
              .rounded(5)
              .bg(t.ansi1 + "18")
              .border_1()
              .border_color(t.ansi1 + "44")
              .children(
                hunk.oldLines.slice(0, 6).map((ol) =>
                  div()
                    .w_full()
                    .truncate()
                    .font_family(monoFont)
                    .text_size(11)
                    .text_color(t.ansi1)
                    .child(`- ${ol || " "}`)
                )
              )
              .when(hunk.oldLines.length > 6, (c) =>
                c.child(
                  div()
                    .text_size(10.5)
                    .text_color(t.dim)
                    .child(`… (+${hunk.oldLines.length - 6})`)
                )
              )
          )
      );
  }

  // Left change gutter rail rendered right next to the Editor's line numbers in normal Editor mode
  renderEditorGutterRail(t) {
    if (this.hunks.length === 0) return div().w(0);
    const totalLines = Math.max(1, this.lineDiffs.length);
    let cursorLine = 0;
    const segments = [];

    for (const h of this.hunks) {
      const gapLines = Math.max(0, h.curStart - cursorLine);
      if (gapLines > 0) {
        segments.push({ kind: "gap", weight: gapLines, hunk: null });
      }
      const spanLines = Math.max(1, h.curCount);
      segments.push({ kind: h.kind, weight: spanLines, hunk: h });
      cursorLine = h.curStart + spanLines;
    }
    if (cursorLine < totalLines) {
      segments.push({ kind: "gap", weight: totalLines - cursorLine, hunk: null });
    }

    return v_flex()
      .id("editor-git-gutter-rail")
      .w(8)
      .h_full()
      .py(4)
      .px(2)
      .flex_none()
      .bg(t.background)
      .border_r(1)
      .border_color(t.border)
      .children(
        segments.map((seg, i) => {
          const weight = Math.max(1, seg.weight);
          if (!seg.hunk) {
            return div().id(`egut-gap-${i}`).w(4).flex_grow(weight).min_h(2);
          }
          const h = seg.hunk;
          const color =
            h.kind === "add"
              ? GIT_COLOR.A
              : h.kind === "del"
                ? GIT_COLOR.D
                : GIT_COLOR.M;
          const bar = div()
            .id(`egut-hunk-${h.id}`)
            .w(4)
            .h_full()
            .min_h(8)
            .rounded(2)
            .bg(color)
            .cursor_pointer()
            .on_hover((hovered, cx) => {
              const next = hovered
                ? h.id
                : this.hoveredGutterHunk === h.id
                  ? null
                  : this.hoveredGutterHunk;
              if (next !== this.hoveredGutterHunk) {
                this.hoveredGutterHunk = next;
                cx.notify();
              }
            })
            .on_mouse_down("left", (_ev, cx) => {
              cx.stop_propagation();
              const offset = this.lineStartOffset(
                this.code?.value() ?? "",
                h.curStart
              );
              this.centerOffsetInEditor(offset, h.curStart, cx);
              this.code?.focus();
            });

          return div()
            .id(`egut-wrap-${h.id}`)
            .w(4)
            .flex_grow(weight)
            .min_h(8)
            .child(
              Popup.new(`egut-pop-${h.id}`, bar)
                .anchor("bottom_left")
                .when(this.hoveredGutterHunk === h.id, (el) =>
                  el.content(this.renderHunkTooltipContent(h, t))
                )
            );
        })
      );
  }

  renderInlineDiffEditorView(t, wantWrap) {
    const activeMatchLine =
      this.findOpen && this.findMatches.length > 0
        ? this.findMatches[this.findIndex]?.line
        : -1;
    const monoFont = settings().font_family;

    return v_flex()
      .id("files-inline-diff-wrap")
      .flex_1()
      .min_h(0)
      .bg(t.background)
      .child(
        h_flex()
          .h(24)
          .px(12)
          .gap(10)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome ?? t.raised)
          .text_size(11)
          .text_color(t.dim)
          .child(div().child(tr("files.click_line_edit")))
          .child(div().flex_1())
          .when(this.diffStats.add > 0, (e) =>
            e.child(div().text_color(GIT_COLOR.A).child(`+${this.diffStats.add}`))
          )
          .when(this.diffStats.mod > 0, (e) =>
            e.child(div().text_color(GIT_COLOR.M).child(`~${this.diffStats.mod}`))
          )
          .when(this.diffStats.del > 0, (e) =>
            e.child(div().text_color(GIT_COLOR.D).child(`−${this.diffStats.del}`))
          )
      )
      .child(
        v_flex()
          .id("files-diff-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scroll()
          .track_scroll(this.diffScroll)
          .py(4)
          .children(
            this.lineDiffs.map((row, idx) => {
              const isAdd = row.kind === "add";
              const isMod = row.kind === "mod";
              const isFindHit = idx === activeMatchLine;
              const gutterColor = isAdd
                ? GIT_COLOR.A
                : isMod
                  ? GIT_COLOR.M
                  : row.deletedBefore
                    ? GIT_COLOR.D
                    : null;
              const rowBg = isFindHit
                ? t.accent + "28"
                : isAdd
                  ? GIT_COLOR.A + "18"
                  : isMod
                    ? GIT_COLOR.M + "18"
                    : null;

              const hasFind = Boolean(this.findOpen && this.findQuery);
              const findSegments = hasFind
                ? splitSearchHighlights(row.text, this.findQuery)
                : null;
              const span = !hasFind && isMod
                ? splitInlineChange(row.oldText, row.text)
                : null;
              const hunk =
                row.hunkId !== null && row.hunkId !== undefined
                  ? this.hunks.find((h) => h.id === row.hunkId)
                  : null;
              const isHoveredLine = this.hoveredDiffLine === idx;

              const lineRow = h_flex()
                .id(`diff-line-${idx}`)
                .w_full()
                .min_h(20)
                .px(4)
                .items_stretch()
                .cursor_pointer()
                .when(Boolean(rowBg), (r) => r.bg(rowBg))
                .hover((s) => s.bg(t.hover))
                .on_hover((hovered, cx) => {
                  const next = hovered
                    ? idx
                    : this.hoveredDiffLine === idx
                      ? null
                      : this.hoveredDiffLine;
                  if (next !== this.hoveredDiffLine) {
                    this.hoveredDiffLine = next;
                    cx.notify();
                  }
                })
                .on_mouse_down("left", (_ev, cx) => {
                  cx.stop_propagation();
                  this.jumpToLineInEditor(idx, cx);
                })
                // 1. VS Code-style left gutter bar (green = added, amber = modified, red = deleted)
                .child(
                  div()
                    .w(3)
                    .flex_none()
                    .rounded(1)
                    .when(Boolean(gutterColor), (d) => d.bg(gutterColor))
                )
                // 2. Line number
                .child(
                  div()
                    .w(42)
                    .px(6)
                    .flex_none()
                    .text_right()
                    .text_size(11)
                    .font_family(monoFont)
                    .text_color(
                      isAdd
                        ? GIT_COLOR.A
                        : isMod
                          ? GIT_COLOR.M
                          : t.dim
                    )
                    .child(String(row.lineNo))
                )
                // 3. Code line with search-term highlight OR character-level diff highlight
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .px(4)
                    .items_center()
                    .font_family(monoFont)
                    .text_size(12)
                    .when(!wantWrap, (c) => c.whitespace_nowrap())
                    .when(wantWrap, (c) => c.flex_wrap())
                    .when(Boolean(findSegments), (c) =>
                      c
                        .text_color(isAdd || isMod ? t.foreground : t.muted)
                        .children(
                          findSegments.map((seg) =>
                            seg.match
                              ? div()
                                  .px(2)
                                  .rounded(2)
                                  .bg(isFindHit ? t.blocked + "88" : t.blocked + "44")
                                  .font_weight(600)
                                  .text_color(t.foreground)
                                  .child(seg.text)
                              : div().child(seg.text)
                          )
                        )
                    )
                    .when(!findSegments && !isMod, (c) =>
                      c
                        .text_color(isAdd ? t.foreground : t.muted)
                        .child(row.text || " ")
                    )
                    .when(!findSegments && isMod && Boolean(span), (c) =>
                      c
                        .text_color(t.foreground)
                        .when(Boolean(span.prefix), (p) =>
                          p.child(div().child(span.prefix))
                        )
                        .when(Boolean(span.changed), (p) =>
                          p.child(
                            div()
                              .px(1)
                              .rounded(2)
                              .bg(GIT_COLOR.M + "44")
                              .child(span.changed)
                          )
                        )
                        .when(Boolean(span.suffix), (p) =>
                          p.child(div().child(span.suffix))
                        )
                        .when(
                          !span.prefix && !span.changed && !span.suffix,
                          (p) => p.child(" ")
                        )
                    )
                )
                // 4. Revert Hunk button with tooltip on changed lines
                .when(Boolean(hunk && !this.readOnlyFile), (r) => {
                  const revertBtn = h_flex()
                    .id(`revert-hunk-${idx}`)
                    .px(6)
                    .h(18)
                    .gap(4)
                    .rounded(4)
                    .flex_none()
                    .items_center()
                    .opacity(isHoveredLine ? 1 : 0.45)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.raised)
                    .text_size(10)
                    .text_color(t.muted)
                    .hover((s) =>
                      s.opacity(1).bg(t.hover).text_color(t.foreground)
                    )
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      tipState.id = null;
                      this.revertHunk(hunk.id, cx);
                    })
                    .child(svg(ICON.undo).size(10).text_color(t.muted));
                  return r.child(
                    tipAbove(
                      `revert-hunk-${idx}`,
                      tr("files.revert_hunk"),
                      revertBtn,
                      t,
                      "bottom_right"
                    )
                  );
                });

              if (!hunk) return lineRow;
              return Popup.new(`diff-hunk-pop-${idx}`, lineRow)
                .anchor("bottom_left")
                .when(isHoveredLine, (el) =>
                  el.content(this.renderHunkTooltipContent(hunk, t))
                );
            })
          )
      );
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const req = shared("james-files.openRequest");
    if (req && req.ts !== this.lastOpenReqTs) {
      this.lastOpenReqTs = req.ts;
      setShared("james-files.openRequest", null);
      if (req.path && (!req.root || req.root === this.root)) {
        this.show(req.path, cx);
      }
    }
    const wantWrap = Boolean(shared("james-files.wordWrap"));
    if (
      this.code &&
      this.file &&
      wantWrap !== this.appliedWordWrap &&
      !this.wrapScheduled
    ) {
      this.wrapScheduled = true;
      cx.timer.after(0, () => {
        this.wrapScheduled = false;
        this.applyWordWrap(Boolean(shared("james-files.wordWrap")), cx);
      });
    }
    const t = theme();
    const fileMark = this.file ? this.marks[`${this.root}/${this.file}`] : null;
    const hasChangesVsHead = Boolean(fileMark && fileMark !== "U");

    return v_flex()
      .id("files")
      .track_focus(this.handle)
      .key_context("JamesFiles")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .on_action("james_files_save", (_ev, cx) => {
        if (this.file && this.code && !this.readOnlyFile) this.saveFile(cx);
      })
      .on_action("james_files_find", (_ev, cx) => {
        this.openFindBar(cx);
      })
      .on_action("james_files_next", (_ev, cx) => {
        this.stepMatch(1, false, cx);
      })
      .on_action("james_files_prev", (_ev, cx) => {
        this.stepMatch(-1, false, cx);
      })
      .on_action("james_files_wrap", (_ev, cx) => {
        const nextWrap = !Boolean(shared("james-files.wordWrap"));
        setShared("james-files.wordWrap", nextWrap);
        this.applyWordWrap(nextWrap, cx);
      })
      .on_action("james_files_diff", (_ev, cx) => {
        this.toggleDiffMode(cx);
      })
      .on_action("james_files_escape", (_ev, cx) => {
        this.handleEscape(cx);
      })
      .on_key_down((e, cx) => {
        const ks = (e.keystroke ?? "").toLowerCase();
        if (ks === "ctrl-s" || ks === "cmd-s") {
          if (this.file && this.code && !this.readOnlyFile) {
            cx.stop_propagation();
            this.saveFile(cx);
          }
        } else if (ks === "alt-z") {
          cx.stop_propagation();
          const nextWrap = !wantWrap;
          setShared("james-files.wordWrap", nextWrap);
          this.applyWordWrap(nextWrap, cx);
        } else if (ks === "alt-d") {
          cx.stop_propagation();
          this.toggleDiffMode(cx);
        } else if (ks === "escape") {
          if (this.handleEscape(cx)) cx.stop_propagation();
        }
      })
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(12)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .when(Boolean(this.file), (el) => {
            const backBtn = h_flex()
              .id("files-back")
              .w(24)
              .h(24)
              .rounded(5)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .text_color(t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                this.show(null, cx);
                cx.notify();
              })
              .child("←");
            return el.child(
              tipAbove("files-back-tip", tr("files.back_tip"), backBtn, t, "bottom_left")
            );
          })
          .child(div().font_semibold().child(tr("act.files")))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_right()
              .text_size(12)
              .text_color(t.dim)
              .child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")
          )
          // Search files button when browsing the file tree
          .when(!this.file, (el) => {
            const treeSearchBtn = h_flex()
              .id("files-tree-search-btn")
              .w(24)
              .h(22)
              .rounded(5)
              .items_center()
              .justify_center()
              .flex_none()
              .cursor_pointer()
              .border_1()
              .border_color(this.treeSearchOpen ? t.accent : t.border)
              .bg(this.treeSearchOpen ? t.selected : t.raised)
              .text_color(this.treeSearchOpen ? t.foreground : t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", (_ev, cx) => {
                cx.stop_propagation();
                tipState.id = null;
                this.toggleTreeSearch(cx);
              })
              .child(svg(ICON.search).size(12));
            return el.child(
              tipAbove(
                "files-tree-search-tip",
                tr("files.search_files_tip"),
                treeSearchBtn,
                t,
                "bottom_right"
              )
            );
          })
          // Find button (Ctrl+F)
          .when(Boolean(this.file && this.code), (el) => {
            const findBtn = h_flex()
              .id("files-find-btn")
              .w(24)
              .h(22)
              .rounded(5)
              .items_center()
              .justify_center()
              .flex_none()
              .cursor_pointer()
              .border_1()
              .border_color(this.findOpen ? t.accent : t.border)
              .bg(this.findOpen ? t.selected : t.raised)
              .text_color(this.findOpen ? t.foreground : t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", (_ev, cx) => {
                cx.stop_propagation();
                if (this.findOpen) this.closeFindBar(cx);
                else this.openFindBar(cx);
              })
              .child(svg(ICON.search).size(12));
            return el.child(
              tipAbove("files-find-tip", tr("files.find_tip"), findBtn, t, "bottom_right")
            );
          })
          // Word Wrap button (Alt+Z) with proper wrap SVG icon + tooltip
          .when(Boolean(this.file && this.code), (el) => {
            const wrapBtn = h_flex()
              .id("files-wrap-btn")
              .w(24)
              .h(22)
              .rounded(5)
              .items_center()
              .justify_center()
              .flex_none()
              .cursor_pointer()
              .border_1()
              .border_color(wantWrap ? t.accent : t.border)
              .bg(wantWrap ? t.selected : t.raised)
              .text_color(wantWrap ? t.foreground : t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", (_ev, cx) => {
                cx.stop_propagation();
                const nextWrap = !wantWrap;
                setShared("james-files.wordWrap", nextWrap);
                this.applyWordWrap(nextWrap, cx);
              })
              .child(svg(ICON.wrap).size(13));
            return el.child(
              tipAbove("files-wrap-tip", tr("files.wrap_tip"), wrapBtn, t, "bottom_right")
            );
          })
          // VS Code-style Inline Diff View button (Alt+D) with live change indicator + tooltip
          .when(Boolean(this.file && this.code), (el) => {
            const diffBtn = h_flex()
              .id("files-diff-btn")
              .px(7)
              .h(22)
              .gap(5)
              .rounded(5)
              .items_center()
              .flex_none()
              .cursor_pointer()
              .border_1()
              .border_color(
                this.diffMode
                  ? t.accent
                  : hasChangesVsHead
                    ? GIT_COLOR.M + "88"
                    : t.border
              )
              .bg(this.diffMode ? t.selected : t.raised)
              .text_size(10.5)
              .text_color(
                this.diffMode
                  ? t.foreground
                  : hasChangesVsHead
                    ? GIT_COLOR.M
                    : t.muted
              )
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", (_ev, cx) => {
                cx.stop_propagation();
                tipState.id = null;
                this.toggleDiffMode(cx);
              })
              .child(svg(ICON.diff).size(12))
              .child(
                div().child(this.diffMode ? tr("files.edit") : tr("files.diff"))
              )
              .when(hasChangesVsHead && !this.diffMode, (b) =>
                b.child(div().size(5).rounded(3).bg(GIT_COLOR.M))
              );
            return el.child(
              tipAbove("files-diff-tip", tr("files.diff_tip"), diffBtn, t, "bottom_right")
            );
          })
          // Save status pill (Ctrl+S)
          .when(
            Boolean(
              this.file &&
                this.code &&
                !this.readOnlyFile &&
                (this.dirty || this.saving || this.saveNotice === "saved")
            ),
            (el) => {
              const label = this.saving
                ? tr("files.saving")
                : this.dirty
                  ? tr("files.unsaved")
                  : tr("files.saved");
              const pill = h_flex()
                .id("files-save-pill")
                .px(7)
                .h(22)
                .rounded(5)
                .items_center()
                .flex_none()
                .border_1()
                .border_color(this.dirty ? t.accent : t.border)
                .bg(this.dirty ? t.selected : t.raised)
                .text_size(10.5)
                .text_color(this.dirty ? t.foreground : t.dim)
                .when(this.dirty && !this.saving, (p) =>
                  p
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_mouse_down("left", (_ev, cx) => {
                      cx.stop_propagation();
                      this.saveFile(cx);
                    })
                )
                .child(label);
              return el.child(
                this.dirty
                  ? tipAbove(
                      "files-save-btn",
                      tr("files.save_tip"),
                      pill,
                      t,
                      "bottom_right"
                    )
                  : pill
              );
            }
          )
      )
      .when(!this.file && this.treeSearchOpen, (el) =>
        el.child(this.renderTreeSearchBar(t))
      )
      .when(Boolean(this.file && this.findOpen), (el) =>
        el.child(this.renderFindBar(t))
      )
      .when(Boolean(this.saveError), (el) =>
        el.child(
          div()
            .px(12)
            .py(6)
            .bg(t.ansi1 + "22")
            .text_size(11)
            .text_color(t.ansi1)
            .child(this.saveError)
        )
      )
      .when(Boolean(this.file && this.readOnlyFile && this.code), (el) =>
        el.child(
          div()
            .px(12)
            .py(4)
            .border_b(1)
            .border_color(t.border)
            .text_size(11)
            .text_color(t.dim)
            .child(tr("files.truncated_readonly"))
        )
      )
      .when(!this.file, (el) =>
        el
          .when(Boolean(this.treeSearchOpen && this.treeQuery.trim()), (wrap) =>
            wrap.child(this.renderTreeSearchResults(t))
          )
          .when(!(this.treeSearchOpen && this.treeQuery.trim()), (wrap) =>
            wrap.child(
              v_flex()
                .id("files-tree")
                .flex_1()
                .min_h(0)
                .overflow_y_scrollbar()
                .p(6)
                .children(this.rows("", 0, [], t))
                .when(Boolean(this.error) || !this.entries.get("")?.length, (el) =>
                  el.child(
                    div()
                      .p(8)
                      .text_size(12)
                      .text_color(t.dim)
                      .child(
                        this.error ||
                          (this.loading
                            ? tr("files.loading_files")
                            : this.root
                              ? tr("files.no_files")
                              : tr("files.no_folder"))
                      )
                  )
                )
                .when(this.limited, (el) =>
                  el.child(
                    div()
                      .p(8)
                      .text_size(11)
                      .text_color(t.dim)
                      .child(tr("files.limited"))
                  )
                )
            )
          )
      )
      .when(Boolean(this.file), (el) =>
        el
          .when(this.diffMode, (wrap) =>
            wrap.child(this.renderInlineDiffEditorView(t, wantWrap))
          )
          .when(!this.diffMode, (wrap) =>
            wrap.child(
              this.code
                ? Editor.new(this.code).flex_1().min_h(0)
                : div()
                    .p(12)
                    .text_color(t.dim)
                    .child(this.fileError || tr("files.loading_file"))
            )
          )
      );
  }
}
