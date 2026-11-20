// Cockpit-inspired Agent-Agnostic Routines (Scheduled Commands & Agent Prompts).
// Supports:
// - OS Scheduler (24/7): installs directly on local or remote server (e.g. avw-server-vpn)
//   via crontab or systemd --user timers so routines run even when your PC is turned off!
// - Herdr App timer: runs in-app via projects-sidebar (for interactive Terminal / Agent tabs).
// - Choose any installed agent on the target machine (100% agent-agnostic).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import {
  spaces,
  machines,
  knownAgents,
  run,
  exec,
  notify,
  openOverlay,
  theme,
  shared,
  setShared,
  checking,
} from "herdr";
import { tr } from "./i18n.js";

const ICON = {
  clock: "mods/activity-bar/icons/routines.svg",
  play: "mods/activity-bar/icons/runbook.svg",
  plus: "mods/james-chrome/plus.svg",
  close: "mods/james-chrome/x.svg",
  server: "mods/james-chrome/server.svg",
  monitor: "mods/james-chrome/monitor.svg",
};

const STORE_KEY = "james-routines.data";

const PRESETS = [
  { id: "5m", type: "interval", minutes: 5, label: "5m" },
  { id: "15m", type: "interval", minutes: 15, label: "15m" },
  { id: "30m", type: "interval", minutes: 30, label: "30m" },
  { id: "1h", type: "interval", minutes: 60, label: "1h" },
  { id: "6h", type: "interval", minutes: 360, label: "6h" },
  { id: "12h", type: "interval", minutes: 720, label: "12h" },
  { id: "24h", type: "interval", minutes: 1440, label: "24h" },
  { id: "daily", type: "daily", minutes: 0, label: "Daily" },
];

function shQuote(str) {
  return `'${String(str ?? "").replace(/'/g, `'\\''`)}'`;
}

function toCronExpr(r) {
  if (r.scheduleType === "daily") {
    const m = /^(\d{1,2}):(\d{2})$/.exec((r.dailyTime || "09:00").trim());
    const hh = m ? Math.min(23, Math.max(0, Number(m[1]))) : 9;
    const mm = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0;
    return `${mm} ${hh} * * *`;
  }
  const mins = Math.max(1, Number(r.intervalMinutes) || 30);
  if (mins < 60) return `*/${mins} * * * *`;
  if (mins === 60) return "0 * * * *";
  if (mins < 1440 && mins % 60 === 0) return `0 */${mins / 60} * * *`;
  return "0 0 * * *";
}

function toSystemdCalendar(r) {
  if (r.scheduleType === "daily") {
    const m = /^(\d{1,2}):(\d{2})$/.exec((r.dailyTime || "09:00").trim());
    const hh = String(m ? Math.min(23, Math.max(0, Number(m[1]))) : 9).padStart(2, "0");
    const mm = String(m ? Math.min(59, Math.max(0, Number(m[2]))) : 0).padStart(2, "0");
    return `*-*-* ${hh}:${mm}:00`;
  }
  const mins = Math.max(1, Number(r.intervalMinutes) || 30);
  if (mins < 60) return `*:0/${mins}`;
  if (mins === 60) return "hourly";
  if (mins < 1440 && mins % 60 === 0) return `*-*-* 0/${mins / 60}:00:00`;
  return "daily";
}

function computeNextRun(routine, fromMs = Date.now()) {
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

function formatSchedule(r) {
  if (r.scheduleType === "daily") {
    return `${tr("routines.daily")} ${r.dailyTime || "09:00"}`;
  }
  const m = Number(r.intervalMinutes) || 30;
  if (m >= 60 && m % 60 === 0) return tr("routines.every_h", { n: m / 60 });
  return tr("routines.every_m", { n: m });
}

function formatRelative(ts) {
  if (!ts) return "—";
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (abs < 60000) return diff >= 0 ? "< 1m" : tr("routines.just_now");
  const str =
    mins < 60
      ? `${mins}m`
      : mins < 1440
        ? `${Math.floor(mins / 60)}h ${mins % 60 > 0 ? `${mins % 60}m` : ""}`.trim()
        : `${Math.floor(mins / 1440)}d`;
  return diff >= 0 ? tr("routines.in_time", { time: str }) : tr("routines.ago_time", { time: str });
}

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "");
}

function buildOsCommand(routine) {
  if (routine.mode !== "agent") return routine.cmd;
  const def = shared("james.defaultAgent");
  const argv = routine.agentRun ?? def?.run ?? ["claude"];
  const bin = argv[0] || "claude";
  const prompt = shQuote(routine.cmd);
  if (bin === "claude") return `claude -p ${prompt}`;
  if (bin === "codex") return `codex exec ${prompt}`;
  if (bin === "gemini") return `gemini -p ${prompt}`;
  if (bin === "opencode") return `opencode run ${prompt}`;
  if (bin === "agy" || bin === "antigravity") return `${bin} -p ${prompt}`;
  return `${argv.map(shQuote).join(" ")} ${prompt}`;
}

async function syncOsRoutine(routine, removeOnly = false) {
  const sid = safeId(routine.id);
  const opts = routine.machine ? { on: routine.machine } : undefined;
  const sp = routine.spaceId ? spaces().find((s) => s.id === routine.spaceId) : null;
  const cwd = sp?.folder || "";

  const uninstallScript = `
set -e
UNIT="james-routine-${sid}"
if command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v "# james-routine:${sid}$" || true) | crontab - 2>/dev/null || true
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now "\${UNIT}.timer" >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/\${UNIT}.service" "$HOME/.config/systemd/user/\${UNIT}.timer"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
rm -f "$HOME/.local/share/james-routines/${sid}.sh"
echo "REMOVED"
`;

  if (removeOnly || !routine.enabled || routine.engine !== "os") {
    await exec("sh", ["-c", uninstallScript], opts);
    return { backend: null };
  }

  const cronExpr = toCronExpr(routine);
  const calExpr = toSystemdCalendar(routine);
  const execLine = buildOsCommand(routine);
  const scriptBody = [
    "#!/usr/bin/env sh",
    'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:$PATH"',
    'mkdir -p "$HOME/.local/share/james-routines"',
    `LOG="$HOME/.local/share/james-routines/${sid}.log"`,
    '{',
    '  echo "=== $(date -Iseconds) ==="',
    cwd ? `  cd ${shQuote(cwd)} || exit 1` : "",
    `  ${execLine}`,
    '  EC=$?',
    '  echo "EXIT:$EC"',
    '  exit $EC',
    '} > "$LOG" 2>&1',
  ]
    .filter(Boolean)
    .join("\n");

  const installScript = `
set -e
UNIT="james-routine-${sid}"
mkdir -p "$HOME/.local/share/james-routines"
SCRIPT="$HOME/.local/share/james-routines/${sid}.sh"
cat <<'JAMES_EOF' > "$SCRIPT"
${scriptBody}
JAMES_EOF
chmod +x "$SCRIPT"

if command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null | grep -v "# james-routine:${sid}$" || true; echo "${cronExpr} $SCRIPT # james-routine:${sid}") | crontab -
  echo "BACKEND:cron"
elif command -v systemctl >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat <<UNIT_EOF > "$HOME/.config/systemd/user/\${UNIT}.service"
[Unit]
Description=JamesHerdr Routine: ${routine.name.replace(/\n/g, " ")}

[Service]
Type=oneshot
ExecStart=$SCRIPT
UNIT_EOF
  cat <<TIMER_EOF > "$HOME/.config/systemd/user/\${UNIT}.timer"
[Unit]
Description=JamesHerdr Routine Timer: ${routine.name.replace(/\n/g, " ")}

[Timer]
OnCalendar=${calExpr}
Persistent=true

[Install]
WantedBy=timers.target
TIMER_EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "\${UNIT}.timer"
  echo "BACKEND:systemd"
else
  echo "BACKEND:none"
  exit 1
fi
`;

  const res = await exec("sh", ["-c", installScript], opts);
  if (res.code !== 0) {
    throw new Error(res.stderr || res.stdout || "Failed to install OS schedule");
  }
  const m = /BACKEND:(cron|systemd)/.exec(res.stdout || "");
  return { backend: m ? m[1] : "os" };
}

export default class JamesRoutines extends View {
  init(_props, cx) {
    this.adding = false;
    this.editingId = null;
    this.expandedLogId = null;
    this.runningIds = new Set();
    this.syncError = "";

    this.engine = "os"; // "os" (24/7 cron/systemd) | "app" (Herdr timer)
    this.mode = "background"; // "background" | "terminal" | "agent"
    this.presetId = "30m";
    this.targetMachine = null; // null = This computer, or remote machine name
    this.targetSpaceId = ""; // "" = Global
    this.agentKey = "__default__";
    this.installedAgents = [];
    this.agentsMachine = undefined;

    this.nameInput = InputState.new({ placeholder: tr("routines.name_placeholder") });
    this.cmdInput = InputState.new({ placeholder: tr("routines.cmd_placeholder") });
    this.timeInput = InputState.new({ placeholder: "09:00", value: "09:00" });
    this.cmdInput.on("submit", (_ev, cx) => this.saveForm(cx));

    if (!checking()) {
      this.loadAgents(null, cx);
      cx.timer.every(15000, (timerCx) => timerCx.notify());
    }
  }

  loadAgents(machine, cx) {
    if (checking()) return;
    const mKey = machine ?? null;
    if (this.agentsMachine === mKey && this.installedAgents.length > 0) return;
    this.agentsMachine = mKey;
    this.installedAgents = [];
    cx.spawn(async (spawnCx) => {
      try {
        const checkScript =
          'CLEAN_PATH=$(printf "%s" "$PATH" | tr ":" "\\n" | grep -vE "mise/(shims|command-wrappers)" | tr "\\n" ":"); ' +
          "check_one() { " +
          '  bin="$1"; mdir="$2"; ' +
          '  if [ -e "$HOME/.local/share/mise/installs/$mdir/latest" ]; then printf "%s\\n" "$bin"; return; fi; ' +
          '  p=$(PATH="$CLEAN_PATH:$HOME/.local/bin:/usr/local/bin:/usr/bin" command -v "$bin" 2>/dev/null || true); ' +
          '  if [ -n "$p" ] && ! { head -c 2 "$p" 2>/dev/null | grep -q "^#!" && grep -q "mise" "$p" 2>/dev/null; }; then ' +
          '    printf "%s\\n" "$bin"; ' +
          "  fi; " +
          "}; " +
          "check_one agy antigravity-cli; " +
          "check_one claude claude; " +
          "check_one codex codex; " +
          "check_one opencode opencode; " +
          "check_one gemini gemini-cli; " +
          "check_one pi pi; " +
          "check_one cursor-agent cursor-agent; " +
          "check_one kimi kimi-code; " +
          "check_one qwen qwen-code;";
        const opts = mKey ? { on: mKey } : undefined;
        const [list, realRes] = await Promise.all([
          knownAgents(opts),
          exec("sh", ["-c", checkScript], opts).catch(() => ({ code: 1, stdout: "" })),
        ]);
        const realBins = new Set(
          (realRes.code === 0 ? realRes.stdout : "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        );
        if (this.agentsMachine === mKey) {
          this.installedAgents = (list ?? []).filter((a) => {
            if (!a.installed) return false;
            if (realRes.code === 0) {
              const bin = a.run?.[0] ?? "";
              return realBins.has(bin) || realBins.has(a.key);
            }
            return true;
          });
          spawnCx.notify();
        }
      } catch {
        // ignore
      }
    });
  }

  getList() {
    const raw = shared(STORE_KEY);
    return Array.isArray(raw) ? raw : [];
  }

  saveList(list) {
    setShared(STORE_KEY, list);
  }

  patchRoutine(id, patch) {
    const next = this.getList().map((x) => (x.id === id ? { ...x, ...patch } : x));
    this.saveList(next);
  }

  openNewForm(cx) {
    this.editingId = null;
    this.adding = true;
    this.syncError = "";
    this.engine = "os";
    this.mode = "background";
    this.presetId = "30m";
    this.targetMachine = null;
    this.targetSpaceId = "";
    this.agentKey = "__default__";
    this.nameInput.set_value("");
    this.cmdInput.set_value("");
    this.timeInput.set_value("09:00");
    this.loadAgents(null, cx);
    cx.timer.after(20, () => this.nameInput.focus());
    cx.notify();
  }

  openEditForm(r, cx) {
    this.editingId = r.id;
    this.adding = true;
    this.syncError = "";
    this.engine = r.engine || "app";
    this.mode = r.mode || "background";
    this.targetMachine = r.machine ?? null;
    this.targetSpaceId = r.spaceId || "";
    this.agentKey = r.agentKey || "__default__";
    if (r.scheduleType === "daily") {
      this.presetId = "daily";
      this.timeInput.set_value(r.dailyTime || "09:00");
    } else {
      const match = PRESETS.find((p) => p.type === "interval" && p.minutes === r.intervalMinutes);
      this.presetId = match ? match.id : "30m";
    }
    this.nameInput.set_value(r.name || "");
    this.cmdInput.set_value(r.cmd || "");
    this.loadAgents(this.targetMachine, cx);
    cx.timer.after(20, () => this.nameInput.focus());
    cx.notify();
  }

  saveForm(cx) {
    const cmd = (this.cmdInput.value() ?? "").trim();
    if (!cmd) return;
    const name = (this.nameInput.value() ?? "").trim() || cmd.split(/\s+/)[0];
    const preset = PRESETS.find((p) => p.id === this.presetId) ?? PRESETS[2];
    const scheduleType = preset.type;
    const intervalMinutes = preset.minutes || 30;
    const dailyTime = (this.timeInput.value() ?? "09:00").trim() || "09:00";

    const pickedAgent =
      this.mode === "agent" && this.agentKey !== "__default__"
        ? this.installedAgents.find((a) => a.key === this.agentKey)
        : null;

    // OS Scheduler supports headless Shell (background) or headless Agent
    const finalMode = this.engine === "os" && this.mode === "terminal" ? "background" : this.mode;

    const list = [...this.getList()];
    let savedItem;
    if (this.editingId) {
      const idx = list.findIndex((x) => x.id === this.editingId);
      if (idx >= 0) {
        savedItem = {
          ...list[idx],
          name,
          cmd,
          engine: this.engine,
          mode: finalMode,
          machine: this.targetMachine,
          scheduleType,
          intervalMinutes,
          dailyTime,
          spaceId: this.targetSpaceId,
          agentKey: finalMode === "agent" ? this.agentKey : null,
          agentName: pickedAgent?.name ?? null,
          agentRun: pickedAgent?.run ?? null,
        };
        savedItem.nextRunAt = computeNextRun(savedItem, Date.now());
        list[idx] = savedItem;
      }
    } else {
      savedItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        cmd,
        engine: this.engine,
        mode: finalMode,
        machine: this.targetMachine,
        scheduleType,
        intervalMinutes,
        dailyTime,
        spaceId: this.targetSpaceId,
        agentKey: finalMode === "agent" ? this.agentKey : null,
        agentName: pickedAgent?.name ?? null,
        agentRun: pickedAgent?.run ?? null,
        enabled: true,
        osBackend: null,
        lastRunAt: null,
        lastStatus: null,
        lastOutput: "",
        runCount: 0,
      };
      savedItem.nextRunAt = computeNextRun(savedItem, Date.now());
      list.unshift(savedItem);
    }

    this.saveList(list);
    this.adding = false;
    this.editingId = null;
    this.syncError = "";
    cx.notify();

    if (savedItem) {
      cx.spawn(async (spawnCx) => {
        try {
          const { backend } = await syncOsRoutine(savedItem, savedItem.engine !== "os");
          this.patchRoutine(savedItem.id, { osBackend: backend, osSyncError: "" });
        } catch (err) {
          this.patchRoutine(savedItem.id, {
            osSyncError: String(err?.message || err || "OS sync failed").slice(0, 140),
          });
        }
        spawnCx.notify();
      });
    }
  }

  toggleEnabled(id, cx) {
    let target = null;
    const list = this.getList().map((r) => {
      if (r.id !== id) return r;
      const enabled = !r.enabled;
      target = {
        ...r,
        enabled,
        nextRunAt: enabled ? computeNextRun({ ...r, enabled: true }, Date.now()) : null,
      };
      return target;
    });
    this.saveList(list);
    cx.notify();

    if (target && target.engine === "os") {
      cx.spawn(async (spawnCx) => {
        try {
          const { backend } = await syncOsRoutine(target, !target.enabled);
          this.patchRoutine(target.id, { osBackend: backend, osSyncError: "" });
        } catch (err) {
          this.patchRoutine(target.id, {
            osSyncError: String(err?.message || err || "OS sync failed").slice(0, 140),
          });
        }
        spawnCx.notify();
      });
    }
  }

  deleteRoutine(id, cx) {
    const target = this.getList().find((r) => r.id === id);
    const list = this.getList().filter((r) => r.id !== id);
    if (this.expandedLogId === id) this.expandedLogId = null;
    this.saveList(list);
    cx.notify();

    if (target && target.engine === "os") {
      cx.spawn(async () => {
        try {
          await syncOsRoutine(target, true);
        } catch {
          // ignore
        }
      });
    }
  }

  toggleLog(r, cx) {
    if (this.expandedLogId === r.id) {
      this.expandedLogId = null;
      cx.notify();
      return;
    }
    this.expandedLogId = r.id;
    cx.notify();
    if (r.engine === "os") {
      const sid = safeId(r.id);
      const opts = r.machine ? { on: r.machine } : undefined;
      cx.spawn(async (spawnCx) => {
        try {
          const res = await exec(
            "sh",
            ["-c", `tail -n 60 "$HOME/.local/share/james-routines/${sid}.log" 2>/dev/null || echo "(No log output yet)"`],
            opts
          );
          if (res.stdout) {
            this.patchRoutine(r.id, { lastOutput: res.stdout.trim().slice(-1500) });
            spawnCx.notify();
          }
        } catch {
          // ignore
        }
      });
    }
  }

  runNow(r, cx) {
    if (this.runningIds.has(r.id)) return;
    const allSpaces = spaces();
    const sp = r.spaceId ? allSpaces.find((s) => s.id === r.spaceId) : null;
    const folder = sp?.folder || undefined;
    const now = Date.now();

    if (r.mode === "terminal") {
      run("layout.select", { stack: "center-stage", child: "work" });
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
      this.patchRoutine(r.id, {
        lastRunAt: now,
        lastStatus: "ok",
        runCount: (r.runCount || 0) + 1,
        nextRunAt: r.enabled ? computeNextRun(r, now) : null,
      });
      cx.notify();
      return;
    }

    if (r.mode === "agent" && r.engine !== "os") {
      const def = shared("james.defaultAgent");
      const argv = r.agentRun ?? def?.run;
      if (argv) {
        run("layout.select", { stack: "center-stage", child: "work" });
        run("tab.new", {
          name: r.name.slice(0, 28),
          space: sp?.id,
          folder,
          argv,
          task: r.cmd,
        });
        this.patchRoutine(r.id, {
          lastRunAt: now,
          lastStatus: "ok",
          runCount: (r.runCount || 0) + 1,
          nextRunAt: r.enabled ? computeNextRun(r, now) : null,
        });
      } else {
        openOverlay({
          mod: "james-settings",
          kind: "dialog",
          width: 600,
          height: 500,
          props: { section: "default-agent" },
        });
      }
      cx.notify();
      return;
    }

    // Background shell execution (local or remote machine!)
    this.runningIds.add(r.id);
    cx.notify();
    cx.spawn(async (spawnCx) => {
      let status = "ok";
      let output = "";
      try {
        const opts = {};
        if (folder) opts.cwd = folder;
        if (r.machine) opts.on = r.machine;
        const cmdToRun = r.engine === "os" && r.mode === "agent" ? buildOsCommand(r) : r.cmd;
        const res = await exec("sh", ["-c", cmdToRun], Object.keys(opts).length ? opts : undefined);
        const combined = [res?.stdout, res?.stderr].filter(Boolean).join("\n").trim();
        output = combined.slice(-1500);
        if (res && typeof res.code === "number" && res.code !== 0) {
          status = "error";
        }
      } catch (err) {
        status = "error";
        output = String(err?.message || err || "Failed").slice(-1500);
      } finally {
        this.runningIds.delete(r.id);
        this.patchRoutine(r.id, {
          lastRunAt: Date.now(),
          lastStatus: status,
          lastOutput: output,
          runCount: (r.runCount || 0) + 1,
          nextRunAt: r.enabled ? computeNextRun(r, Date.now()) : null,
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

  render() {
    const t = theme();
    const list = this.getList();
    const allSpaces = spaces();
    const allMachines = machines();
    const enabledCount = list.filter((r) => r.enabled).length;
    const machineSpaces = allSpaces.filter((s) => (s.machine ?? null) === this.targetMachine);

    const pillBtn = (id, label, active, onClick) =>
      h_flex()
        .id(id)
        .h(26)
        .px(10)
        .rounded(6)
        .items_center()
        .justify_center()
        .cursor_pointer()
        .border_1()
        .border_color(active ? t.accent : t.border)
        .bg(active ? t.selected : t.raised)
        .text_size(11.5)
        .font_weight(active ? 600 : 400)
        .text_color(active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_ev, cx) => {
          cx.stop_propagation();
          onClick(cx);
        })
        .child(label);

    const modeLabel = (r) => {
      const ag = r.mode === "agent" ? ` · ${r.agentName || tr("routines.mode_agent")}` : "";
      if (r.engine === "os") return `${r.osBackend ? `OS (${r.osBackend})` : tr("routines.engine_os")}${ag}`;
      if (r.mode === "terminal") return tr("routines.mode_terminal");
      if (r.mode === "agent") return r.agentName || tr("routines.mode_agent");
      return tr("routines.mode_bg");
    };

    return v_flex()
      .id("james-routines")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      // Header
      .child(
        h_flex()
          .h(46)
          .flex_none()
          .px(18)
          .gap(10)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome ?? t.background)
          .child(svg(ICON.clock).size(15).text_color(t.accent))
          .child(div().font_semibold().text_size(14).child(tr("routines.title")))
          .child(
            div()
              .px(7)
              .py(2)
              .rounded(6)
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .text_size(11)
              .text_color(t.muted)
              .child(tr("routines.active_count", { count: enabledCount }))
          )
          .child(div().flex_1())
          .child(
            h_flex()
              .id("rt-new-btn")
              .h(28)
              .px(11)
              .gap(6)
              .rounded(6)
              .items_center()
              .cursor_pointer()
              .border_1()
              .border_color(this.adding ? t.accent : t.border)
              .bg(this.adding ? t.selected : t.raised)
              .text_size(12)
              .font_weight(500)
              .text_color(t.foreground)
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_ev, cx) => {
                cx.stop_propagation();
                if (this.adding) {
                  this.adding = false;
                  this.editingId = null;
                  cx.notify();
                } else {
                  this.openNewForm(cx);
                }
              })
              .child(svg(ICON.plus).size(12).text_color(t.accent))
              .child(div().child(tr("routines.new")))
          )
      )
      // Body
      .child(
        v_flex()
          .id("routines-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(18)
          .gap(14)
          // Create / Edit Form
          .when(this.adding, (col) =>
            col.child(
              v_flex()
                .p(14)
                .gap(10)
                .rounded(10)
                .border_1()
                .border_color(t.accent + "66")
                .bg(t.chrome ?? t.raised)
                .child(
                  div()
                    .text_size(12)
                    .font_weight(600)
                    .text_color(t.foreground)
                    .child(this.editingId ? tr("routines.edit") : tr("routines.new"))
                )
                .child(
                  h_flex()
                    .gap(8)
                    .child(
                      Input.new(this.nameInput)
                        .flex_grow(1)
                        .h(30)
                        .px(10)
                        .rounded(6)
                        .border_1()
                        .border_color(t.border)
                        .bg(t.canvas ?? t.background)
                        .text_size(12)
                        .text_color(t.foreground)
                    )
                    .child(
                      Input.new(this.cmdInput)
                        .flex_grow(2)
                        .h(30)
                        .px(10)
                        .rounded(6)
                        .border_1()
                        .border_color(t.border)
                        .bg(t.canvas ?? t.background)
                        .text_size(12)
                        .text_color(t.foreground)
                    )
                )
                // Machine selector (This computer or remote server!)
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .flex_wrap()
                    .child(
                      div()
                        .w(88)
                        .text_size(11.5)
                        .text_color(t.muted)
                        .child(tr("routines.machine_label"))
                    )
                    .children(
                      allMachines.map((m) =>
                        pillBtn(
                          `rt-m-${m.name ?? "local"}`,
                          m.name ?? tr("sb.this_computer"),
                          this.targetMachine === m.name,
                          (cx) => {
                            this.targetMachine = m.name;
                            this.targetSpaceId = "";
                            this.loadAgents(m.name, cx);
                            cx.notify();
                          }
                        )
                      )
                    )
                )
                // Engine selector (OS 24/7 vs Herdr App)
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .flex_wrap()
                    .child(
                      div()
                        .w(88)
                        .text_size(11.5)
                        .text_color(t.muted)
                        .child(tr("routines.engine_label"))
                    )
                    .child(
                      pillBtn("rt-eng-os", tr("routines.engine_os"), this.engine === "os", (cx) => {
                        this.engine = "os";
                        if (this.mode === "terminal") this.mode = "background";
                        cx.notify();
                      })
                    )
                    .child(
                      pillBtn("rt-eng-app", tr("routines.engine_app"), this.engine === "app", (cx) => {
                        this.engine = "app";
                        cx.notify();
                      })
                    )
                )
                // Mode selector (both OS/Server and Herdr App support Agent!)
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .flex_wrap()
                    .child(
                      div()
                        .w(88)
                        .text_size(11.5)
                        .text_color(t.muted)
                        .child(tr("routines.mode_label"))
                    )
                    .child(
                      pillBtn(
                        "rt-mode-bg",
                        this.engine === "os" ? "Shell" : tr("routines.mode_bg"),
                        this.mode === "background",
                        (cx) => {
                          this.mode = "background";
                          cx.notify();
                        }
                      )
                    )
                    .when(this.engine === "app", (row) =>
                      row.child(
                        pillBtn(
                          "rt-mode-term",
                          tr("routines.mode_terminal"),
                          this.mode === "terminal",
                          (cx) => {
                            this.mode = "terminal";
                            cx.notify();
                          }
                        )
                      )
                    )
                    .child(
                      pillBtn(
                        "rt-mode-agent",
                        tr("dash.agent_label"),
                        this.mode === "agent",
                        (cx) => {
                          this.mode = "agent";
                          cx.notify();
                        }
                      )
                    )
                )
                // Agent picker when Mode === Agent (only installed agents + Default)
                .when(this.mode === "agent", (form) =>
                  form.child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .flex_wrap()
                      .child(
                        div()
                          .w(88)
                          .text_size(11.5)
                          .text_color(t.muted)
                          .child(tr("dash.agent_label"))
                      )
                      .child(
                        pillBtn(
                          "rt-ag-default",
                          tr("dash.default_tag"),
                          this.agentKey === "__default__",
                          (cx) => {
                            this.agentKey = "__default__";
                            cx.notify();
                          }
                        )
                      )
                      .children(
                        this.installedAgents.map((ag) =>
                          pillBtn(`rt-ag-${ag.key}`, ag.name, this.agentKey === ag.key, (cx) => {
                            this.agentKey = ag.key;
                            cx.notify();
                          })
                        )
                      )
                  )
                )
                // Schedule selector
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .flex_wrap()
                    .child(
                      div()
                        .w(88)
                        .text_size(11.5)
                        .text_color(t.muted)
                        .child(tr("routines.schedule_label"))
                    )
                    .children(
                      PRESETS.map((p) =>
                        pillBtn(
                          `rt-pre-${p.id}`,
                          p.id === "daily" ? tr("routines.daily") : p.label,
                          this.presetId === p.id,
                          (cx) => {
                            this.presetId = p.id;
                            cx.notify();
                          }
                        )
                      )
                    )
                    .when(this.presetId === "daily", (row) =>
                      row.child(
                        Input.new(this.timeInput)
                          .w(74)
                          .h(26)
                          .px(8)
                          .rounded(6)
                          .border_1()
                          .border_color(t.accent)
                          .bg(t.canvas ?? t.background)
                          .text_size(12)
                          .text_color(t.foreground)
                      )
                    )
                )
                // Target space selector (filtered by selected machine)
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .flex_wrap()
                    .child(
                      div()
                        .w(88)
                        .text_size(11.5)
                        .text_color(t.muted)
                        .child(tr("routines.space_label"))
                    )
                    .child(
                      pillBtn("rt-sp-global", tr("todos.general"), this.targetSpaceId === "", (cx) => {
                        this.targetSpaceId = "";
                        cx.notify();
                      })
                    )
                    .children(
                      machineSpaces.map((sp) =>
                        pillBtn(`rt-sp-${sp.id}`, sp.name, this.targetSpaceId === sp.id, (cx) => {
                          this.targetSpaceId = sp.id;
                          cx.notify();
                        })
                      )
                    )
                )
                // Form actions
                .child(
                  h_flex()
                    .justify_end()
                    .gap(8)
                    .pt(4)
                    .child(
                      div()
                        .id("rt-cancel")
                        .px(12)
                        .py(5)
                        .rounded(6)
                        .cursor_pointer()
                        .text_size(12)
                        .text_color(t.muted)
                        .hover((s) => s.bg(t.hover))
                        .on_mouse_down("left", (_ev, cx) => {
                          cx.stop_propagation();
                          this.adding = false;
                          this.editingId = null;
                          cx.notify();
                        })
                        .child(tr("runbook.cancel"))
                    )
                    .child(
                      div()
                        .id("rt-save")
                        .px(14)
                        .py(5)
                        .rounded(6)
                        .cursor_pointer()
                        .border_1()
                        .border_color(t.accent)
                        .bg(t.selected)
                        .text_size(12)
                        .font_weight(600)
                        .text_color(t.foreground)
                        .hover((s) => s.bg(t.hover))
                        .on_mouse_down("left", (_ev, cx) => {
                          cx.stop_propagation();
                          this.saveForm(cx);
                        })
                        .child(tr("runbook.save"))
                    )
                )
            )
          )
          // Empty state
          .when(list.length === 0 && !this.adding, (col) =>
            col.child(
              v_flex()
                .p(28)
                .gap(8)
                .rounded(10)
                .border_1()
                .border_color(t.border)
                .bg(t.raised)
                .items_center()
                .child(svg(ICON.clock).size(26).text_color(t.dim))
                .child(
                  div()
                    .text_size(13)
                    .font_weight(500)
                    .text_color(t.foreground)
                    .child(tr("routines.empty_title"))
                )
                .child(
                  div()
                    .text_size(12)
                    .text_color(t.dim)
                    .child(tr("routines.empty_desc"))
                )
            )
          )
          // Routine Cards
          .children(
            list.map((r) => {
              const sp = r.spaceId ? allSpaces.find((s) => s.id === r.spaceId) : null;
              const isRunning = this.runningIds.has(r.id);
              const showLog = this.expandedLogId === r.id;
              const statusColor = isRunning
                ? t.working ?? t.accent
                : r.lastStatus === "error" || r.osSyncError
                  ? "#f14c4c"
                  : r.lastStatus === "ok"
                    ? "#73c991"
                    : t.dim;

              return v_flex()
                .id(`rt-card-${r.id}`)
                .w_full()
                .rounded(10)
                .border_1()
                .border_color(r.lastStatus === "error" || r.osSyncError ? "#f14c4c55" : t.border)
                .bg(t.raised)
                .child(
                  h_flex()
                    .p(12)
                    .gap(12)
                    .items_center()
                    // Enable/Disable toggle pill
                    .child(
                      h_flex()
                        .id(`rt-toggle-${r.id}`)
                        .w(34)
                        .h(18)
                        .px(2)
                        .rounded(9)
                        .flex_none()
                        .items_center()
                        .cursor_pointer()
                        .justify_end()
                        .when(!r.enabled, (el) => el.justify_start())
                        .bg(r.enabled ? t.accent : t.canvas ?? t.background)
                        .border_1()
                        .border_color(r.enabled ? t.accent : t.border)
                        .on_mouse_down("left", (_ev, cx) => {
                          cx.stop_propagation();
                          this.toggleEnabled(r.id, cx);
                        })
                        .child(
                          div()
                            .size(12)
                            .rounded(6)
                            .bg(r.enabled ? (t.accent_foreground ?? "#ffffff") : t.dim)
                        )
                    )
                    // Main info
                    .child(
                      v_flex()
                        .flex_1()
                        .min_w(0)
                        .gap(4)
                        .child(
                          h_flex()
                            .gap(6)
                            .items_center()
                            .flex_wrap()
                            .child(
                              div()
                                .text_size(13)
                                .font_weight(600)
                                .text_color(r.enabled ? t.foreground : t.dim)
                                .child(r.name)
                            )
                            .child(
                              div()
                                .px(6)
                                .py(1)
                                .rounded(5)
                                .bg(t.canvas ?? t.background)
                                .border_1()
                                .border_color(t.border)
                                .text_size(10)
                                .text_color(t.muted)
                                .child(formatSchedule(r))
                            )
                            .child(
                              div()
                                .px(6)
                                .py(1)
                                .rounded(5)
                                .bg(t.selected)
                                .text_size(10)
                                .text_color(t.accent)
                                .child(modeLabel(r))
                            )
                            .child(
                              h_flex()
                                .px(6)
                                .py(1)
                                .gap(4)
                                .rounded(5)
                                .items_center()
                                .bg(t.canvas ?? t.background)
                                .text_size(10)
                                .text_color(r.machine ? t.foreground : t.dim)
                                .child(
                                  svg(r.machine ? ICON.server : ICON.monitor)
                                    .size(10)
                                    .text_color(r.machine ? t.accent : t.dim)
                                )
                                .child(r.machine ?? tr("sb.this_computer"))
                            )
                            .when(Boolean(sp), (el) =>
                              el.child(
                                div()
                                  .px(6)
                                  .py(1)
                                  .rounded(5)
                                  .bg(t.canvas ?? t.background)
                                  .text_size(10)
                                  .text_color(t.dim)
                                  .child(sp.name)
                              )
                            )
                        )
                        .child(
                          div()
                            .text_size(11.5)
                            .text_color(t.muted)
                            .truncate()
                            .child(r.cmd)
                        )
                        .child(
                          h_flex()
                            .gap(10)
                            .items_center()
                            .text_size(10.5)
                            .text_color(t.dim)
                            .child(
                              div().child(
                                r.enabled
                                  ? r.engine === "os"
                                    ? tr("routines.os_active")
                                    : `${tr("routines.next")}: ${formatRelative(r.nextRunAt)}`
                                  : tr("routines.paused")
                              )
                            )
                            .when(Boolean(r.osSyncError), (row) =>
                              row.child(div().text_color("#f14c4c").child(r.osSyncError))
                            )
                            .when(Boolean(r.lastRunAt) || isRunning, (row) =>
                              row.child(
                                h_flex()
                                  .gap(5)
                                  .items_center()
                                  .child(div().size(6).rounded(3).bg(statusColor))
                                  .child(
                                    div()
                                      .text_color(statusColor)
                                      .child(
                                        isRunning
                                          ? tr("routines.running")
                                          : `${tr("routines.last")}: ${formatRelative(r.lastRunAt)}`
                                      )
                                  )
                              )
                            )
                        )
                    )
                    // Actions
                    .child(
                      h_flex()
                        .gap(6)
                        .flex_none()
                        .items_center()
                        .child(
                          h_flex()
                            .id(`rt-run-${r.id}`)
                            .h(26)
                            .px(9)
                            .gap(5)
                            .rounded(6)
                            .items_center()
                            .cursor_pointer()
                            .border_1()
                            .border_color(t.accent + "66")
                            .bg(t.selected)
                            .text_size(11)
                            .text_color(t.foreground)
                            .hover((s) => s.bg(t.hover))
                            .on_mouse_down("left", (_ev, cx) => {
                              cx.stop_propagation();
                              this.runNow(r, cx);
                            })
                            .child(svg(ICON.play).size(10).text_color(t.accent))
                            .child(div().child(tr("runbook.run")))
                        )
                        .when(Boolean(r.lastOutput) || r.engine === "os", (row) =>
                          row.child(
                            h_flex()
                              .id(`rt-log-${r.id}`)
                              .h(26)
                              .px(8)
                              .rounded(6)
                              .items_center()
                              .cursor_pointer()
                              .border_1()
                              .border_color(showLog ? t.accent : t.border)
                              .bg(showLog ? t.selected : t.background)
                              .text_size(11)
                              .text_color(t.muted)
                              .hover((s) => s.bg(t.hover).text_color(t.foreground))
                              .on_mouse_down("left", (_ev, cx) => {
                                cx.stop_propagation();
                                this.toggleLog(r, cx);
                              })
                              .child(tr("routines.log"))
                          )
                        )
                        .child(
                          h_flex()
                            .id(`rt-edit-${r.id}`)
                            .h(26)
                            .px(8)
                            .rounded(6)
                            .items_center()
                            .cursor_pointer()
                            .border_1()
                            .border_color(t.border)
                            .bg(t.background)
                            .text_size(11)
                            .text_color(t.muted)
                            .hover((s) => s.bg(t.hover).text_color(t.foreground))
                            .on_mouse_down("left", (_ev, cx) => {
                              cx.stop_propagation();
                              this.openEditForm(r, cx);
                            })
                            .child(tr("routines.edit_btn"))
                        )
                        .child(
                          h_flex()
                            .id(`rt-del-${r.id}`)
                            .w(26)
                            .h(26)
                            .rounded(6)
                            .items_center()
                            .justify_center()
                            .cursor_pointer()
                            .hover((s) => s.bg(t.surface))
                            .on_mouse_down("left", (_ev, cx) => {
                              cx.stop_propagation();
                              this.deleteRoutine(r.id, cx);
                            })
                            .child(svg(ICON.close).size(12).text_color(t.dim))
                        )
                    )
                )
                .when(showLog, (card) =>
                  card.child(
                    div()
                      .p(10)
                      .rounded_b(9)
                      .border_t(1)
                      .border_color(t.border)
                      .bg(t.canvas ?? t.background)
                      .text_size(11)
                      .text_color(t.muted)
                      .child(r.lastOutput || "…")
                  )
                );
            })
          )
      );
  }
}
