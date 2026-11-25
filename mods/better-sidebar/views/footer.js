// Unified footer for JamesHerdr: Herdr Settings, JamesHerdr Settings, and Add machine.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, updates, openOverlay } from "herdr";
import { Icon, SIZE } from "./ui.js";

export class Footer {
  init() {}

  button(id, label, action, t, icons) {
    return h_flex()
      .id(id)
      .h(SIZE.icon)
      .px(6)
      .gap(3)
      .flex_none()
      .items_center()
      .rounded(6)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .accessibility_label(label)
      .tooltip(label)
      .on_click(action)
      .children(icons);
  }

  render() {
    const t = theme();
    const updateDot = updates().app.ready ? [div().size(6).rounded_full().bg(t.accent)] : [];
    return h_flex()
      .id("sidebar-footer")
      .size_full()
      .px(8)
      .gap(2)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .child(
        this.button("settings", "Herdr Settings", () => run("app.settings"), t, [
          Icon("settings"),
          ...updateDot,
        ]),
      )
      .child(
        this.button(
          "james-settings",
          "JamesHerdr Settings",
          () =>
            openOverlay({
              mod: "james-settings",
              kind: "dialog",
              width: 660,
              height: 540,
            }),
          t,
          [Icon("sliders")],
        ),
      )
      .child(div().flex_1())
      .child(
        this.button("machine", "Add machine", () => run("mod.open", { name: "machine-add" }), t, [
          Icon("plus", 12),
          Icon("server"),
        ]),
      );
  }
}
