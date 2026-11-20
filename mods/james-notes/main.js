// Persistent Markdown Scratchpad / Notes mod with per-Space and General scopes.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Popup } from "gpui-base";
import { spaces, panes, focused, theme, settings, shared, setShared } from "herdr";
import { tr } from "./i18n.js";

const STORE_KEY = "james-notes.data";
const GLOBAL_KEY = "__global__";
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

function activeSpaceInfo() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const folder = pane?.cwd || f?.cwd || space?.folder || "";
  const scopeId = folder || space?.id || GLOBAL_KEY;
  const label = space?.name || folder.split(/[\\/]/).pop() || "Space";
  return { scopeId, label };
}

export default class JamesNotes extends View {
  init(_props, cx) {
    this.tab = "space"; // "space" | "general"
    this.loadedBucket = null;
    this.suppressChange = false;
    this.saveSeq = 0;
    this.saveStatus = "";

    const t = theme();
    const initialBucket = this.currentBucket();
    const initialText = this.getData()[initialBucket] ?? "";
    this.loadedBucket = initialBucket;

    this.editor = EditorState.new({
      language: "md",
      readonly: false,
      line_numbers: false,
      folding: false,
      soft_wrap: true,
      value: initialText,
      font_family: settings().font_family,
      font_size: 12.5,
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

    this.editor.on("change", (_ev, cx) => {
      if (this.suppressChange) return;
      const bucket = this.loadedBucket ?? this.currentBucket();
      const val = this.editor.value();
      const seq = ++this.saveSeq;
      this.saveStatus = "saving";
      cx.notify();
      cx.timer.after(350, (timerCx) => {
        if (this.saveSeq !== seq) return;
        const all = { ...this.getData(), [bucket]: val };
        setShared(STORE_KEY, all);
        this.saveStatus = "saved";
        timerCx.notify();
        timerCx.timer.after(1800, (tCx) => {
          if (this.saveSeq === seq && this.saveStatus === "saved") {
            this.saveStatus = "";
            tCx.notify();
          }
        });
      });
    });
  }

  getData() {
    const raw = shared(STORE_KEY);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }

  currentBucket() {
    return this.tab === "general" ? GLOBAL_KEY : activeSpaceInfo().scopeId;
  }

  switchBucket(nextBucket) {
    if (this.loadedBucket === nextBucket) return;
    // Flush current content before switching
    if (this.loadedBucket) {
      const curVal = this.editor.value();
      const all = { ...this.getData(), [this.loadedBucket]: curVal };
      setShared(STORE_KEY, all);
    }
    this.loadedBucket = nextBucket;
    const nextText = this.getData()[nextBucket] ?? "";
    this.suppressChange = true;
    this.editor.set_value(nextText);
    this.suppressChange = false;
    this.saveStatus = "";
  }

  render() {
    const t = theme();
    const info = activeSpaceInfo();
    const wantBucket = this.currentBucket();
    if (wantBucket !== this.loadedBucket) {
      this.switchBucket(wantBucket);
    }

    const val = this.editor.value() ?? "";
    const lineCount = val ? val.split("\n").length : 0;
    const charCount = val.length;

    const tabBtn = (id, label) => {
      const active = this.tab === id;
      return h_flex()
        .id(`notes-tab-${id}`)
        .flex_1()
        .h(28)
        .px(8)
        .rounded(6)
        .items_center()
        .justify_center()
        .cursor_pointer()
        .border_1()
        .border_color(active ? t.accent : t.border)
        .bg(active ? t.selected : t.raised)
        .text_size(12)
        .font_weight(active ? 600 : 400)
        .text_color(active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_ev, cx) => {
          cx.stop_propagation();
          this.tab = id;
          this.switchBucket(this.currentBucket());
          cx.notify();
        })
        .child(label);
    };

    const clearBtn = h_flex()
      .id("notes-clear-btn")
      .px(6)
      .h(20)
      .rounded(5)
      .items_center()
      .cursor_pointer()
      .text_size(11)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_ev, cx) => {
        cx.stop_propagation();
        tipState.id = null;
        this.editor.set_value("");
        const all = { ...this.getData(), [this.loadedBucket]: "" };
        setShared(STORE_KEY, all);
        cx.notify();
      })
      .child(tr("notes.clear"));

    return v_flex()
      .id("james-notes")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      // Header
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .rounded_t(9)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome ?? t.background)
          .child(div().font_semibold().child(tr("notes.title")))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_right()
              .text_size(11.5)
              .text_color(t.dim)
              .child(this.tab === "general" ? tr("todos.general") : info.label)
          )
      )
      // Scope Tabs
      .child(
        h_flex()
          .px(10)
          .pt(10)
          .pb(8)
          .gap(6)
          .border_b(1)
          .border_color(t.border)
          .child(tabBtn("space", tr("todos.space")))
          .child(tabBtn("general", tr("todos.general")))
      )
      // Markdown Editor Body
      .child(
        div()
          .flex_1()
          .min_h(0)
          .p(6)
          .child(Editor.new(this.editor).size_full())
      )
      // Footer
      .child(
        h_flex()
          .h(26)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .rounded_b(9)
          .border_t(1)
          .border_color(t.border)
          .bg(t.chrome ?? t.raised)
          .text_size(10.5)
          .text_color(t.dim)
          .child(div().child(`${lineCount} ln · ${charCount} ch`))
          .child(div().flex_1())
          .when(this.saveStatus === "saving", (el) =>
            el.child(div().child(tr("files.saving")))
          )
          .when(this.saveStatus === "saved", (el) =>
            el.child(div().text_color(t.ansi2).child(tr("files.saved")))
          )
          .when(charCount > 0, (el) =>
            el.child(
              tipAbove("notes-clear-tip", tr("notes.clear_tip"), clearBtn, t, "bottom_right")
            )
          )
      );
  }
}
