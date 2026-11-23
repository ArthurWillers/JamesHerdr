// Agent-agnostic GitHub hub powered by `gh`:
// - Pull Requests (authored + review-requested)
// - Issues (open issues involving @me)
// - CI & Pages (workflow/check rollup status on default branches across recent repos, incl. GitHub Pages)
// Zero org/repo config required; supports search, repo, and status filters + 1-click Default Agent launch.
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
  mine: search(query: "is:pr is:open author:@me sort:updated-desc", type: ISSUE, first: 35) {
    nodes {
      ... on PullRequest {
        number title url isDraft updatedAt headRefName additions deletions reviewDecision
        repository { nameWithOwner }
        author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
  reviews: search(query: "is:pr is:open review-requested:@me sort:updated-desc", type: ISSUE, first: 35) {
    nodes {
      ... on PullRequest {
        number title url isDraft updatedAt headRefName additions deletions reviewDecision
        repository { nameWithOwner }
        author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
  issues: search(query: "is:issue is:open involves:@me sort:updated-desc", type: ISSUE, first: 35) {
    nodes {
      ... on Issue {
        number title url updatedAt
        repository { nameWithOwner }
        author { login }
        assignees(first: 5) { nodes { login } }
        labels(first: 5) { nodes { name color } }
        comments { totalCount }
      }
    }
  }
  repos: viewer {
    repositories(first: 25, affiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR], orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes {
        nameWithOwner
        url
        defaultBranchRef {
          name
          target {
            ... on Commit {
              oid
              committedDate
              messageHeadline
              statusCheckRollup {
                state
                contexts(first: 15) {
                  nodes {
                    ... on CheckRun { name conclusion detailsUrl }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
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
    ciState: ciRaw,
    kind,
  };
}

function normalizeIssue(node, viewer) {
  if (!node || !node.number) return null;
  const assignees = (node.assignees?.nodes ?? []).map((a) => a.login);
  return {
    id: `${node.repository?.nameWithOwner ?? ""}#I${node.number}`,
    number: node.number,
    title: node.title ?? "",
    url: node.url ?? "",
    updatedAt: node.updatedAt ?? "",
    repo: node.repository?.nameWithOwner ?? "",
    author: node.author?.login ?? "",
    assignedToMe: Boolean(viewer && assignees.includes(viewer)),
    labels: (node.labels?.nodes ?? []).map((l) => ({ name: l.name, color: l.color })),
    comments: node.comments?.totalCount ?? 0,
  };
}

function normalizeRepoCi(node) {
  const rollup = node?.defaultBranchRef?.target?.statusCheckRollup;
  if (!node?.nameWithOwner || !rollup) return null;
  const contexts = (rollup.contexts?.nodes ?? []).map((c) => ({
    name: c.name || c.context || "Check",
    failed:
      c.conclusion === "FAILURE" ||
      c.conclusion === "TIMED_OUT" ||
      c.conclusion === "ACTION_REQUIRED" ||
      c.state === "FAILURE" ||
      c.state === "ERROR",
    pending: c.conclusion === null && c.state !== "SUCCESS" && c.state !== "FAILURE" && c.state !== "ERROR",
    url: c.detailsUrl || c.targetUrl || node.url,
  }));
  const failedChecks = contexts.filter((c) => c.failed);
  return {
    id: node.nameWithOwner,
    repo: node.nameWithOwner,
    url: failedChecks[0]?.url || contexts[0]?.url || node.url,
    branch: node.defaultBranchRef?.name ?? "main",
    commitMsg: node.defaultBranchRef?.target?.messageHeadline ?? "",
    updatedAt: node.defaultBranchRef?.target?.committedDate ?? "",
    state: rollup.state, // SUCCESS | FAILURE | ERROR | PENDING | EXPECTED
    failedChecks,
    checksCount: contexts.length,
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
    this.tab = "prs"; // "prs" | "issues" | "ci"
    this.scope = "all"; // PRs: "all"|"mine"|"review" | Issues: "all"|"assigned"|"authored" | CI: "all"|"failing"
    this.statusFilter = "all"; // PRs: "all"|"failing"|"approved"|"changes"|"draft"
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
      this.fetchAll(cx);
      cx.timer.every(120000, (timerCx) => this.fetchAll(timerCx));
    }
  }

  getCache() {
    const raw = shared(CACHE_KEY);
    return raw && typeof raw === "object"
      ? raw
      : { viewer: "", mine: [], reviews: [], issues: [], repoCi: [], fetchedAt: 0 };
  }

  fetchAll(cx) {
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
        const issues = (parsed?.data?.issues?.nodes ?? [])
          .map((n) => normalizeIssue(n, viewer))
          .filter(Boolean);
        const repoCi = (parsed?.data?.repos?.repositories?.nodes ?? [])
          .map((n) => normalizeRepoCi(n))
          .filter(Boolean)
          .sort((a, b) => {
            const af = a.state === "FAILURE" || a.state === "ERROR" ? 1 : 0;
            const bf = b.state === "FAILURE" || b.state === "ERROR" ? 1 : 0;
            if (af !== bf) return bf - af;
            return (b.updatedAt || "").localeCompare(a.updatedAt || "");
          });

        setShared(CACHE_KEY, {
          viewer,
          mine,
          reviews,
          issues,
          repoCi,
          fetchedAt: Date.now(),
        });
        this.error = "";
      } catch (err) {
        this.error = String(err?.message || err || "Failed to load GitHub data").slice(0, 180);
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

  launchWithAgent(repo, tabTitle, task) {
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

    const repoShort = (repo || "").split("/").pop()?.toLowerCase() ?? "";
    const allSpaces = spaces();
    const matchedSpace =
      allSpaces.find((s) => (s.name || "").toLowerCase() === repoShort) ??
      allSpaces.find((s) => (s.folder || "").toLowerCase().endsWith(`/${repoShort}`)) ??
      allSpaces.find((s) => s.active) ??
      allSpaces[0];

    run("layout.select", { stack: "center-stage", child: "work" });
    if (matchedSpace?.id) run("space.select", { id: matchedSpace.id });
    run("tab.new", {
      name: tabTitle,
      space: matchedSpace?.id,
      folder: matchedSpace?.folder || undefined,
      argv: def.run,
      task,
    });
  }

  sendPrToAgent(pr) {
    const isFailing = pr.ciState === "FAILURE" || pr.ciState === "ERROR";
    const task =
      pr.kind === "review"
        ? `Review PR #${pr.number} (${pr.url}) in ${pr.repo}: "${pr.title}". Run \`gh pr diff ${pr.number} --repo ${pr.repo}\` and \`gh pr view ${pr.number} --repo ${pr.repo}\`, then give a concise code review.`
        : isFailing
          ? `Investigate and fix the failing CI checks on PR #${pr.number} (${pr.url}) in ${pr.repo}: "${pr.title}". Start with \`gh pr checks ${pr.number} --repo ${pr.repo}\`.`
          : `Check PR #${pr.number} (${pr.url}) in ${pr.repo}: "${pr.title}". Run \`gh pr view ${pr.number} --repo ${pr.repo}\` and help with next steps.`;
    this.launchWithAgent(pr.repo, `PR #${pr.number}`, task);
  }

  sendIssueToAgent(issue) {
    const task = `Work on GitHub Issue #${issue.number} (${issue.url}) in ${issue.repo}: "${issue.title}". Run \`gh issue view ${issue.number} --repo ${issue.repo}\` to inspect the full details and help implement or investigate it.`;
    this.launchWithAgent(issue.repo, `Issue #${issue.number}`, task);
  }

  sendCiToAgent(ci) {
    const failedList = ci.failedChecks.map((c) => c.name).join(", ") || "CI / GitHub Pages";
    const task = `Investigate and fix the failing CI / workflow (${failedList}) on branch \`${ci.branch}\` in ${ci.repo} (${ci.url}). Use \`gh run list --repo ${ci.repo} --branch ${ci.branch} --limit 5\` and \`gh run view --log-failed\` to diagnose the failure.`;
    this.launchWithAgent(ci.repo, `CI ${ci.repo.split("/").pop()}`, task);
  }

  render() {
    const t = theme();
    const cache = this.getCache();
    const mine = Array.isArray(cache.mine) ? cache.mine : [];
    const reviews = Array.isArray(cache.reviews) ? cache.reviews : [];
    const issues = Array.isArray(cache.issues) ? cache.issues : [];
    const repoCi = Array.isArray(cache.repoCi) ? cache.repoCi : [];

    const seen = new Set();
    const allPrs = [];
    for (const pr of [...reviews, ...mine]) {
      if (seen.has(pr.id)) continue;
      seen.add(pr.id);
      allPrs.push(pr);
    }
    allPrs.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

    const prFailCount = allPrs.filter((p) => p.ciState === "FAILURE" || p.ciState === "ERROR").length;
    const ciFailCount = repoCi.filter((c) => c.state === "FAILURE" || c.state === "ERROR").length;

    const currentSource =
      this.tab === "prs"
        ? this.scope === "mine"
          ? mine
          : this.scope === "review"
            ? reviews
            : allPrs
        : this.tab === "issues"
          ? this.scope === "assigned"
            ? issues.filter((i) => i.assignedToMe)
            : this.scope === "authored"
              ? issues.filter((i) => i.author === cache.viewer)
              : issues
          : this.scope === "failing"
            ? repoCi.filter((c) => c.state === "FAILURE" || c.state === "ERROR")
            : repoCi;

    const repos = [...new Set(currentSource.map((x) => x.repo).filter(Boolean))].sort();

    const filtered = currentSource.filter((item) => {
      if (this.repoFilter !== "all" && item.repo !== this.repoFilter) return false;
      if (this.tab === "prs") {
        if (this.statusFilter === "failing" && item.ciState !== "FAILURE" && item.ciState !== "ERROR")
          return false;
        if (this.statusFilter === "approved" && item.reviewDecision !== "APPROVED") return false;
        if (this.statusFilter === "changes" && item.reviewDecision !== "CHANGES_REQUESTED")
          return false;
        if (this.statusFilter === "draft" && !item.isDraft) return false;
      }
      if (this.search) {
        const hay =
          `${item.number ?? ""} ${item.title ?? ""} ${item.repo ?? ""} ${item.branch ?? ""} ${item.author ?? ""} ${item.commitMsg ?? ""}`.toLowerCase();
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
      // Header + Main Tabs (PRs / Issues / CI & Pages)
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
          .child(div().font_semibold().text_size(14).child("GitHub"))
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
          .child(div().w(1).h(16).bg(t.border).mx(2))
          .child(
            pill("gh-tab-prs", "Pull Requests", this.tab === "prs", allPrs.length, prFailCount > 0 ? "#f14c4c" : null, (cx) => {
              this.tab = "prs";
              this.scope = "all";
              this.statusFilter = "all";
              this.repoFilter = "all";
              cx.notify();
            })
          )
          .child(
            pill("gh-tab-issues", tr("gh.issues_tab"), this.tab === "issues", issues.length, null, (cx) => {
              this.tab = "issues";
              this.scope = "all";
              this.repoFilter = "all";
              cx.notify();
            })
          )
          .child(
            pill(
              "gh-tab-ci",
              tr("gh.ci_tab"),
              this.tab === "ci",
              ciFailCount > 0 ? ciFailCount : repoCi.length,
              ciFailCount > 0 ? "#f14c4c" : null,
              (cx) => {
                this.tab = "ci";
                this.scope = ciFailCount > 0 ? "failing" : "all";
                this.repoFilter = "all";
                cx.notify();
              }
            )
          )
          .child(div().flex_1())
          .child(
            h_flex()
              .w(210)
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
                this.fetchAll(cx);
              })
              .child(
                this.loading
                  ? svg(ICON.spinner).size(12).text_color(t.accent).spin(900)
                  : svg(ICON.refresh).size(12).text_color(t.muted)
              )
              .child(div().child(tr("set.ai_refresh")))
          )
      )
      // Sub-Filters Bar
      .child(
        v_flex()
          .px(18)
          .py(10)
          .gap(8)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome ?? t.background)
          .when(this.tab === "prs", (bar) =>
            bar.child(
              h_flex()
                .gap(6)
                .items_center()
                .flex_wrap()
                .child(
                  pill("gh-scope-all", tr("todos.filter_all"), this.scope === "all", allPrs.length, null, (cx) => {
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
                  pill("gh-st-all", tr("gh.status_all"), this.statusFilter === "all", null, null, (cx) => {
                    this.statusFilter = "all";
                    cx.notify();
                  })
                )
                .child(
                  pill(
                    "gh-st-fail",
                    tr("gh.ci_fail"),
                    this.statusFilter === "failing",
                    prFailCount > 0 ? prFailCount : null,
                    "#f14c4c",
                    (cx) => {
                      this.statusFilter = this.statusFilter === "failing" ? "all" : "failing";
                      cx.notify();
                    }
                  )
                )
                .child(
                  pill("gh-st-ok", tr("gh.approved"), this.statusFilter === "approved", null, null, (cx) => {
                    this.statusFilter = this.statusFilter === "approved" ? "all" : "approved";
                    cx.notify();
                  })
                )
                .child(
                  pill("gh-st-chg", tr("gh.changes_req"), this.statusFilter === "changes", null, null, (cx) => {
                    this.statusFilter = this.statusFilter === "changes" ? "all" : "changes";
                    cx.notify();
                  })
                )
                .child(
                  pill("gh-st-draft", tr("gh.draft"), this.statusFilter === "draft", null, null, (cx) => {
                    this.statusFilter = this.statusFilter === "draft" ? "all" : "draft";
                    cx.notify();
                  })
                )
            )
          )
          .when(this.tab === "issues", (bar) =>
            bar.child(
              h_flex()
                .gap(6)
                .items_center()
                .flex_wrap()
                .child(
                  pill("gh-iss-all", tr("todos.filter_all"), this.scope === "all", issues.length, null, (cx) => {
                    this.scope = "all";
                    cx.notify();
                  })
                )
                .child(
                  pill(
                    "gh-iss-assigned",
                    tr("gh.assigned_to_me"),
                    this.scope === "assigned",
                    issues.filter((i) => i.assignedToMe).length,
                    null,
                    (cx) => {
                      this.scope = "assigned";
                      cx.notify();
                    }
                  )
                )
                .child(
                  pill(
                    "gh-iss-authored",
                    tr("gh.created_by_me"),
                    this.scope === "authored",
                    issues.filter((i) => i.author === cache.viewer).length,
                    null,
                    (cx) => {
                      this.scope = "authored";
                      cx.notify();
                    }
                  )
                )
            )
          )
          .when(this.tab === "ci", (bar) =>
            bar.child(
              h_flex()
                .gap(6)
                .items_center()
                .flex_wrap()
                .child(
                  pill("gh-ci-all", tr("todos.filter_all"), this.scope === "all", repoCi.length, null, (cx) => {
                    this.scope = "all";
                    cx.notify();
                  })
                )
                .child(
                  pill(
                    "gh-ci-fail",
                    tr("gh.ci_fail"),
                    this.scope === "failing",
                    ciFailCount,
                    ciFailCount > 0 ? "#f14c4c" : null,
                    (cx) => {
                      this.scope = "failing";
                      cx.notify();
                    }
                  )
                )
            )
          )
          // Dynamic Repo filter
          .when(repos.length > 1, (bar) =>
            bar.child(
              h_flex()
                .gap(5)
                .items_center()
                .flex_wrap()
                .child(div().text_size(11).text_color(t.dim).mr(2).child(`${tr("gh.repos")}:`))
                .child(
                  pill("gh-repo-all", tr("todos.filter_all"), this.repoFilter === "all", null, null, (cx) => {
                    this.repoFilter = "all";
                    cx.notify();
                  })
                )
                .children(
                  repos.map((rp) =>
                    pill(`gh-repo-${rp}`, rp, this.repoFilter === rp, null, null, (cx) => {
                      this.repoFilter = this.repoFilter === rp ? "all" : rp;
                      cx.notify();
                    })
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
                .child(div().text_size(13).text_color(t.muted).child(tr("gh.empty")))
            )
          )
          // Render PR rows
          .when(this.tab === "prs", (col) =>
            col.children(
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
                          .child(div().text_size(12).font_weight(600).text_color(t.muted).child(`${pr.repo} #${pr.number}`))
                          .when(Boolean(ciEl), (row) => row.child(ciEl))
                          .when(Boolean(revEl), (row) => row.child(revEl))
                      )
                      .child(div().text_size(13.5).font_weight(600).text_color(t.foreground).truncate().child(pr.title))
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
                          .when(Boolean(pr.updatedAt), (row) => row.child(div().child(relativeTime(pr.updatedAt))))
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
                            this.sendPrToAgent(pr);
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
          )
          // Render Issues rows
          .when(this.tab === "issues", (col) =>
            col.children(
              filtered.map((issue) =>
                h_flex()
                  .id(`gh-issue-${issue.id}`)
                  .w_full()
                  .p(12)
                  .gap(12)
                  .rounded(10)
                  .items_center()
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .hover((s) => s.bg(t.hover))
                  .child(
                    v_flex()
                      .flex_1()
                      .min_w(0)
                      .gap(5)
                      .child(
                        h_flex()
                          .gap(6)
                          .items_center()
                          .flex_wrap()
                          .child(div().text_size(12).font_weight(600).text_color(t.muted).child(`${issue.repo} #${issue.number}`))
                          .children(
                            issue.labels.map((lb) =>
                              div()
                                .px(6)
                                .py(1)
                                .rounded(5)
                                .bg(t.canvas ?? t.background)
                                .border_1()
                                .border_color(t.border)
                                .text_size(10)
                                .text_color(t.muted)
                                .child(lb.name)
                            )
                          )
                      )
                      .child(div().text_size(13.5).font_weight(600).text_color(t.foreground).truncate().child(issue.title))
                      .child(
                        h_flex()
                          .gap(10)
                          .items_center()
                          .text_size(11)
                          .text_color(t.dim)
                          .child(div().child(`@${issue.author}`))
                          .when(issue.comments > 0, (row) => row.child(div().child(`💬 ${issue.comments}`)))
                          .when(Boolean(issue.updatedAt), (row) => row.child(div().child(relativeTime(issue.updatedAt))))
                      )
                  )
                  .child(
                    h_flex()
                      .gap(6)
                      .flex_none()
                      .items_center()
                      .child(
                        h_flex()
                          .id(`gh-iss-ag-${issue.id}`)
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
                            this.sendIssueToAgent(issue);
                          })
                          .child(svg(ICON.sparkles).size(11).text_color(t.accent))
                          .child(div().child(tr("gh.work_issue")))
                      )
                      .child(
                        h_flex()
                          .id(`gh-iss-open-${issue.id}`)
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
                            this.openUrl(issue.url);
                          })
                          .child("GitHub ↗")
                      )
                  )
              )
            )
          )
          // Render CI & GitHub Pages rows
          .when(this.tab === "ci", (col) =>
            col.children(
              filtered.map((ci) => {
                const isFail = ci.state === "FAILURE" || ci.state === "ERROR";
                const badge = ciBadge(ci.state);
                return h_flex()
                  .id(`gh-ci-${ci.id}`)
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
                          .child(div().text_size(12.5).font_weight(600).text_color(t.foreground).child(ci.repo))
                          .when(Boolean(badge), (row) => row.child(badge))
                          .children(
                            ci.failedChecks.slice(0, 3).map((fc) =>
                              div()
                                .px(6)
                                .py(1)
                                .rounded(5)
                                .bg("#f14c4c15")
                                .text_size(10)
                                .text_color("#f14c4c")
                                .child(fc.name)
                            )
                          )
                      )
                      .when(Boolean(ci.commitMsg), (row) =>
                        row.child(div().text_size(12.5).text_color(t.muted).truncate().child(ci.commitMsg))
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
                              .child(ci.branch)
                          )
                          .child(div().child(`${ci.checksCount} checks`))
                          .when(Boolean(ci.updatedAt), (row) => row.child(div().child(relativeTime(ci.updatedAt))))
                      )
                  )
                  .child(
                    h_flex()
                      .gap(6)
                      .flex_none()
                      .items_center()
                      .when(isFail, (row) =>
                        row.child(
                          h_flex()
                            .id(`gh-ci-ag-${ci.id}`)
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
                              this.sendCiToAgent(ci);
                            })
                            .child(svg(ICON.sparkles).size(11).text_color(t.accent))
                            .child(div().child(tr("gh.ask_fix_ci")))
                        )
                      )
                      .child(
                        h_flex()
                          .id(`gh-ci-open-${ci.id}`)
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
                            this.openUrl(ci.url);
                          })
                          .child("Actions ↗")
                      )
                  );
              })
            )
          )
      );
  }
}
