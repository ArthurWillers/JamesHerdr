// Agent-agnostic GitHub Pull Requests & Reviews hub powered by `gh`.
// Fetches all accessible open PRs (authored + review-requested) without org config,
// with dynamic repo/status/scope/search filters and 1-click Default Agent launch.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import {
  spaces,
  exec,
  run,
  openOverlay,
  theme,
  shared,
  setShared,
  checking,
} from "herdr";
import { tr } from "./i18n.js";

const ICON = {
  github: "mods/activity-bar/icons/github.svg",
  refresh: "mods/source-control/icons/refresh.svg",
  spinner: "mods/workspace-chrome/spinner.svg",
  sparkles: "mods/source-control/icons/sparkles.svg",
  branch: "mods/james-chrome/branch.svg",
  search: "mods/workspace-chrome/search.svg",
};

const CACHE_KEY = "james-github.cache";

const GQL_QUERY = `{
  viewer { login }
  mine: search(query: "is:pr is:open author:@me sort:updated-desc", type: ISSUE, first: 40) {
    nodes {
      ... on PullRequest {
        number title url isDraft updatedAt headRefName additions deletions reviewDecision
        repository { nameWithOwner }
        author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
  reviews: search(query: "is:pr is:open review-requested:@me sort:updated-desc", type: ISSUE, first: 40) {
    nodes {
      ... on PullRequest {
        number title url isDraft updatedAt headRefName additions deletions reviewDecision
        repository { nameWithOwner }
        author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

function normalizePr(node, kind) {
  if (!node || !node.number) return null;
  const ciRaw = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  return {
    id: `${node.repository?.nameWithOwner ?? ""}#${node.number}`,
    number: node.number,
    title: node.title ?? "",
    url: node.url ?? "",
    isDraft: Boolean(node.isDraft),
    updatedAt: node.updatedAt ?? "",
    branch: node.headRefName ?? "",
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    reviewDecision: node.reviewDecision ?? null,
    repo: node.repository?.nameWithOwner ?? "",
    author: node.author?.login ?? "",
    ciState: ciRaw, // "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null
    kind, // "mine" | "review"
  };
}

function relativeTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export default class JamesGithub extends View {
  init(_props, cx) {
    this.scope = "all"; // "all" | "mine" | "review"
    this.statusFilter = "all"; // "all" | "failing" | "approved" | "changes" | "draft"
    this.repoFilter = "all";
    this.search = "";
    this.loading = false;
    this.error = "";

    this.searchInput = InputState.new({ placeholder: tr("gh.search_placeholder") });
    this.searchInput.on("change", (_ev, cx) => {
      this.search = (this.searchInput.value() ?? "").trim().toLowerCase();
      cx.notify();
    });

    if (!checking()) {
      this.fetchPrs(cx);
      cx.timer.every(120000, (timerCx) => this.fetchPrs(timerCx));
    }
  }

  getCache() {
    const raw = shared(CACHE_KEY);
    return raw && typeof raw === "object"
      ? raw
      : { viewer: "", mine: [], reviews: [], fetchedAt: 0 };
  }

  fetchPrs(cx) {
    if (this.loading) return;
    this.loading = true;
    this.error = "";
    cx.notify();

    cx.spawn(async (spawnCx) => {
      try {
        const res = await exec("gh", ["api", "graphql", "-f", `query=${GQL_QUERY}`], {
          timeout: 20000,
        });
        if (res.code !== 0) {
          throw new Error((res.stderr || res.stdout || "gh failed").trim());
        }
        const parsed = JSON.parse(res.stdout || "{}");
        const viewer = parsed?.data?.viewer?.login ?? "";
        const mine = (parsed?.data?.mine?.nodes ?? [])
          .map((n) => normalizePr(n, "mine"))
          .filter(Boolean);
        const reviews = (parsed?.data?.reviews?.nodes ?? [])
          .map((n) => normalizePr(n, "review"))
          .filter(Boolean);

        setShared(CACHE_KEY, {
          viewer,
          mine,
          reviews,
          fetchedAt: Date.now(),
        });
        this.error = "";
      } catch (err) {
        this.error = String(err?.message || err || "Failed to load GitHub PRs").slice(0, 180);
      } finally {
        this.loading = false;
        spawnCx.notify();
      }
    });
  }

  openUrl(url) {
    if (!url) return;
    exec("xdg-open", [url]).catch(() => {});
  }

  sendToAgent(pr) {
    const def = shared("james.defaultAgent");
    if (!def?.run) {
      openOverlay({
        mod: "james-settings",
        kind: "dialog",
        width: 600,
        height: 500,
        props: { section: "default-agent" },
      });
      return;
    }

    const repoShort = pr.repo.split("/").pop()?.toLowerCase() ?? "";
    const allSpaces = spaces();
    const matchedSpace =
      allSpaces.find((s) => (s.name || "").toLowerCase() === repoShort) ??
      allSpaces.find((s) => (s.folder || "").toLowerCase().endsWith(`/${repoShort}`)) ??
      allSpaces.find((s) => s.active) ??
      allSpaces[0];

    const isFailing = pr.ciState === "FAILURE" || pr.ciState === "ERROR";
    let task;
    if (pr.kind === "review") {
      task = `Review PR #${pr.number} (${pr.url}) in ${pr.repo}: "${pr.title}". Run \`gh pr diff ${pr.number} --repo ${pr.repo}\` and \`gh pr view ${pr.number} --repo ${pr.repo}\`, then give a concise code review.`;
    } else if (isFailing) {
      task = `Investigate and fix the failing CI checks on PR #${pr.number} (${pr.url}) in ${pr.repo}: "${pr.title}". Start with \`gh pr checks ${pr.number} --repo ${pr.repo}\`.`;
    } else {
      task = `Check PR #${pr.number} (${pr.url}) in ${pr.repo}: "${pr.title}". Run \`gh pr view ${pr.number} --repo ${pr.repo}\` and help with next steps.`;
    }

    run("layout.select", { stack: "center-stage", child: "work" });
    if (matchedSpace?.id) run("space.select", { id: matchedSpace.id });
    run("tab.new", {
      name: `PR #${pr.number}`,
      space: matchedSpace?.id,
      folder: matchedSpace?.folder || undefined,
      argv: def.run,
      task,
    });
  }

  render() {
    const t = theme();
    const cache = this.getCache();
    const mine = Array.isArray(cache.mine) ? cache.mine : [];
    const reviews = Array.isArray(cache.reviews) ? cache.reviews : [];

    // Deduplicate if user requested review on own PR
    const seen = new Set();
    const all = [];
    for (const pr of [...reviews, ...mine]) {
      if (seen.has(pr.id)) continue;
      seen.add(pr.id);
      all.push(pr);
    }
    all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

    const repos = [...new Set(all.map((p) => p.repo).filter(Boolean))].sort();
    const failingCount = all.filter((p) => p.ciState === "FAILURE" || p.ciState === "ERROR").length;

    const scoped =
      this.scope === "mine" ? mine : this.scope === "review" ? reviews : all;

    const filtered = scoped.filter((pr) => {
      if (this.repoFilter !== "all" && pr.repo !== this.repoFilter) return false;
      if (this.statusFilter === "failing" && pr.ciState !== "FAILURE" && pr.ciState !== "ERROR")
        return false;
      if (this.statusFilter === "approved" && pr.reviewDecision !== "APPROVED") return false;
      if (this.statusFilter === "changes" && pr.reviewDecision !== "CHANGES_REQUESTED")
        return false;
      if (this.statusFilter === "draft" && !pr.isDraft) return false;
      if (this.search) {
        const hay = `${pr.number} ${pr.title} ${pr.repo} ${pr.branch} ${pr.author}`.toLowerCase();
        if (!hay.includes(this.search)) return false;
      }
      return true;
    });

    const pill = (id, label, active, count, color, onClick) =>
      h_flex()
        .id(id)
        .h(26)
        .px(10)
        .gap(6)
        .rounded(6)
        .items_center()
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
        .child(div().child(label))
        .when(count !== null && count !== undefined, (el) =>
          el.child(
            div()
              .px(5)
              .py(1)
              .rounded(6)
              .bg(t.canvas ?? t.background)
              .text_size(10)
              .text_color(color ?? t.dim)
              .child(String(count))
          )
        );

    const ciBadge = (ciState) => {
      if (!ciState) return null;
      const isFail = ciState === "FAILURE" || ciState === "ERROR";
      const isOk = ciState === "SUCCESS";
      const color = isFail ? "#f14c4c" : isOk ? "#73c991" : "#e2c08d";
      const label = isFail ? `✕ ${tr("gh.ci_fail")}` : isOk ? `✓ ${tr("gh.ci_ok")}` : `● ${tr("gh.ci_pending")}`;
      return div()
        .px(6)
        .py(1)
        .rounded(5)
        .bg(color + "22")
        .border_1()
        .border_color(color + "55")
        .text_size(10)
        .font_weight(600)
        .text_color(color)
        .child(label);
    };

    const reviewBadge = (pr) => {
      if (pr.isDraft) {
        return div()
          .px(6)
          .py(1)
          .rounded(5)
          .bg(t.canvas ?? t.background)
          .border_1()
          .border_color(t.border)
          .text_size(10)
          .text_color(t.dim)
          .child(tr("gh.draft"));
      }
      if (pr.reviewDecision === "APPROVED") {
        return div()
          .px(6)
          .py(1)
          .rounded(5)
          .bg("#73c99122")
          .text_size(10)
          .text_color("#73c991")
          .child(tr("gh.approved"));
      }
      if (pr.reviewDecision === "CHANGES_REQUESTED") {
        return div()
          .px(6)
          .py(1)
          .rounded(5)
          .bg("#f14c4c22")
          .text_size(10)
          .text_color("#f14c4c")
          .child(tr("gh.changes_req"));
      }
      if (pr.kind === "review") {
        return div()
          .px(6)
          .py(1)
          .rounded(5)
          .bg(t.selected)
          .text_size(10)
          .text_color(t.accent)
          .child(tr("gh.review_req"));
      }
      return null;
    };

    return v_flex()
      .id("james-github")
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
          .child(svg(ICON.github).size(15).text_color(t.accent))
          .child(div().font_semibold().text_size(14).child(tr("gh.title")))
          .when(Boolean(cache.viewer), (el) =>
            el.child(
              div()
                .px(7)
                .py(2)
                .rounded(6)
                .bg(t.raised)
                .border_1()
                .border_color(t.border)
                .text_size(11)
                .text_color(t.muted)
                .child(`@${cache.viewer}`)
            )
          )
          .child(div().flex_1())
          .child(
            h_flex()
              .w(230)
              .h(28)
              .px(8)
              .gap(6)
              .rounded(6)
              .items_center()
              .border_1()
              .border_color(t.border)
              .bg(t.canvas ?? t.background)
              .child(svg(ICON.search).size(12).text_color(t.dim))
              .child(
                Input.new(this.searchInput)
                  .flex_1()
                  .text_size(12)
                  .text_color(t.foreground)
              )
          )
          .child(
            h_flex()
              .id("gh-refresh-btn")
              .h(28)
              .px(10)
              .gap(6)
              .rounded(6)
              .items_center()
              .cursor_pointer()
              .border_1()
              .border_color(t.border)
              .bg(t.raised)
              .text_size(12)
              .text_color(t.foreground)
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_ev, cx) => {
                cx.stop_propagation();
                this.fetchPrs(cx);
              })
              .child(
                this.loading
                  ? svg(ICON.spinner).size(12).text_color(t.accent).spin(900)
                  : svg(ICON.refresh).size(12).text_color(t.muted)
              )
              .child(div().child(tr("set.ai_refresh")))
          )
      )
      // Filters Bar
      .child(
        v_flex()
          .px(18)
          .py(10)
          .gap(8)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome ?? t.background)
          // Row 1: Scope + Status filters
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .flex_wrap()
              .child(
                pill("gh-scope-all", tr("todos.filter_all"), this.scope === "all", all.length, null, (cx) => {
                  this.scope = "all";
                  cx.notify();
                })
              )
              .child(
                pill("gh-scope-mine", tr("gh.my_prs"), this.scope === "mine", mine.length, null, (cx) => {
                  this.scope = "mine";
                  cx.notify();
                })
              )
              .child(
                pill(
                  "gh-scope-rev",
                  tr("gh.reviews_for_me"),
                  this.scope === "review",
                  reviews.length,
                  reviews.length > 0 ? t.accent : null,
                  (cx) => {
                    this.scope = "review";
                    cx.notify();
                  }
                )
              )
              .child(div().w(1).h(16).bg(t.border).mx(4))
              .child(
                pill(
                  "gh-st-all",
                  tr("gh.status_all"),
                  this.statusFilter === "all",
                  null,
                  null,
                  (cx) => {
                    this.statusFilter = "all";
                    cx.notify();
                  }
                )
              )
              .child(
                pill(
                  "gh-st-fail",
                  tr("gh.ci_fail"),
                  this.statusFilter === "failing",
                  failingCount > 0 ? failingCount : null,
                  "#f14c4c",
                  (cx) => {
                    this.statusFilter = this.statusFilter === "failing" ? "all" : "failing";
                    cx.notify();
                  }
                )
              )
              .child(
                pill(
                  "gh-st-ok",
                  tr("gh.approved"),
                  this.statusFilter === "approved",
                  null,
                  null,
                  (cx) => {
                    this.statusFilter = this.statusFilter === "approved" ? "all" : "approved";
                    cx.notify();
                  }
                )
              )
              .child(
                pill(
                  "gh-st-chg",
                  tr("gh.changes_req"),
                  this.statusFilter === "changes",
                  null,
                  null,
                  (cx) => {
                    this.statusFilter = this.statusFilter === "changes" ? "all" : "changes";
                    cx.notify();
                  }
                )
              )
              .child(
                pill(
                  "gh-st-draft",
                  tr("gh.draft"),
                  this.statusFilter === "draft",
                  null,
                  null,
                  (cx) => {
                    this.statusFilter = this.statusFilter === "draft" ? "all" : "draft";
                    cx.notify();
                  }
                )
              )
          )
          // Row 2: Dynamic Repositories found (no config needed!)
          .when(repos.length > 1, (bar) =>
            bar.child(
              h_flex()
                .gap(5)
                .items_center()
                .flex_wrap()
                .child(
                  div()
                    .text_size(11)
                    .text_color(t.dim)
                    .mr(2)
                    .child(`${tr("gh.repos")}:`)
                )
                .child(
                  pill(
                    "gh-repo-all",
                    tr("todos.filter_all"),
                    this.repoFilter === "all",
                    null,
                    null,
                    (cx) => {
                      this.repoFilter = "all";
                      cx.notify();
                    }
                  )
                )
                .children(
                  repos.map((rp) =>
                    pill(
                      `gh-repo-${rp}`,
                      rp,
                      this.repoFilter === rp,
                      null,
                      null,
                      (cx) => {
                        this.repoFilter = this.repoFilter === rp ? "all" : rp;
                        cx.notify();
                      }
                    )
                  )
                )
            )
          )
      )
      // Body
      .child(
        v_flex()
          .id("gh-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(18)
          .gap(8)
          .when(Boolean(this.error), (col) =>
            col.child(
              div()
                .p(12)
                .rounded(8)
                .border_1()
                .border_color("#f14c4c55")
                .bg("#f14c4c15")
                .text_size(12)
                .text_color("#f14c4c")
                .child(this.error)
            )
          )
          .when(filtered.length === 0 && !this.loading && !this.error, (col) =>
            col.child(
              v_flex()
                .p(28)
                .gap(6)
                .rounded(10)
                .border_1()
                .border_color(t.border)
                .bg(t.raised)
                .items_center()
                .child(svg(ICON.github).size(24).text_color(t.dim))
                .child(
                  div()
                    .text_size(13)
                    .text_color(t.muted)
                    .child(tr("gh.empty"))
                )
            )
          )
          .children(
            filtered.map((pr) => {
              const ciEl = ciBadge(pr.ciState);
              const revEl = reviewBadge(pr);
              const isFail = pr.ciState === "FAILURE" || pr.ciState === "ERROR";

              return h_flex()
                .id(`gh-pr-${pr.id}`)
                .w_full()
                .p(12)
                .gap(12)
                .rounded(10)
                .items_center()
                .bg(t.raised)
                .border_1()
                .border_color(isFail ? "#f14c4c55" : t.border)
                .hover((s) => s.bg(t.hover))
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(5)
                    .child(
                      h_flex()
                        .gap(7)
                        .items_center()
                        .flex_wrap()
                        .child(
                          div()
                            .text_size(12)
                            .font_weight(600)
                            .text_color(t.muted)
                            .child(`${pr.repo} #${pr.number}`)
                        )
                        .when(Boolean(ciEl), (row) => row.child(ciEl))
                        .when(Boolean(revEl), (row) => row.child(revEl))
                    )
                    .child(
                      div()
                        .text_size(13.5)
                        .font_weight(600)
                        .text_color(t.foreground)
                        .truncate()
                        .child(pr.title)
                    )
                    .child(
                      h_flex()
                        .gap(10)
                        .items_center()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(
                          h_flex()
                            .gap(4)
                            .items_center()
                            .child(svg(ICON.branch).size(11).text_color(t.dim))
                            .child(div().truncate().max_w(220).child(pr.branch))
                        )
                        .child(div().child(`@${pr.author}`))
                        .child(
                          h_flex()
                            .gap(4)
                            .child(div().text_color("#73c991").child(`+${pr.additions}`))
                            .child(div().text_color("#f14c4c").child(`-${pr.deletions}`))
                        )
                        .when(Boolean(pr.updatedAt), (row) =>
                          row.child(div().child(relativeTime(pr.updatedAt)))
                        )
                    )
                )
                .child(
                  h_flex()
                    .gap(6)
                    .flex_none()
                    .items_center()
                    .child(
                      h_flex()
                        .id(`gh-agent-${pr.id}`)
                        .h(28)
                        .px(10)
                        .gap(5)
                        .rounded(6)
                        .items_center()
                        .cursor_pointer()
                        .border_1()
                        .border_color(t.accent + "66")
                        .bg(t.selected)
                        .text_size(11.5)
                        .font_weight(500)
                        .text_color(t.foreground)
                        .hover((s) => s.bg(t.hover))
                        .on_mouse_down("left", (_ev, cx) => {
                          cx.stop_propagation();
                          this.sendToAgent(pr);
                        })
                        .child(svg(ICON.sparkles).size(11).text_color(t.accent))
                        .child(
                          div().child(
                            pr.kind === "review"
                              ? tr("gh.ask_review")
                              : isFail
                                ? tr("gh.ask_fix_ci")
                                : tr("gh.ask_agent")
                          )
                        )
                    )
                    .child(
                      h_flex()
                        .id(`gh-open-${pr.id}`)
                        .h(28)
                        .px(10)
                        .rounded(6)
                        .items_center()
                        .cursor_pointer()
                        .border_1()
                        .border_color(t.border)
                        .bg(t.background)
                        .text_size(11.5)
                        .text_color(t.muted)
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .on_mouse_down("left", (_ev, cx) => {
                          cx.stop_propagation();
                          this.openUrl(pr.url);
                        })
                        .child("GitHub ↗")
                    )
                );
            })
          )
      );
  }
}
