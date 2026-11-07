// Public-only top-languages card generator (contribution-driven, no manual org list).
//
// Why this exists: the card should show languages across every public repository
// the account has contributed to, for all contribution years, without a personal
// token and without hardcoding any organization name.
//
// Discovery source: GitHub public contribution history. For each contribution year
// we read the per-repository commit/issue/PR/review groups, filter to public repos,
// deduplicate by stable repository ID (handles renames/transfers), and aggregate
// languages. We also add the user's own public repos via ownerAffiliations so owned
// repos that predate contribution tracking still appear.
//
// Weighting (commit-count proxy): GitHub exposes no per-author language bytes, so the
// card cannot show "bytes you personally wrote". Instead each repository's language
// bytes are weighted by the number of commits YOU made to that repo (from the
// contribution graph). This is a proxy for "where you actually worked", not an exact
// per-author byte count. See https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const token = process.env.GH_TOKEN;
const login = process.env.CARD_USER;
const out = process.env.CARD_OUT || "profile/top-langs.svg";
const unweightedOut = process.env.UNWEIGHTED_CARD_OUT || "profile/top-langs-unweighted.svg";
const statsOut = process.env.STATS_OUT || "profile/stats.svg";
const coreDir = process.env.CORE_DIR;
const langsCount = Number(process.env.LANGS_COUNT || 8);

if (!token || !login || !coreDir) {
  throw new Error("GH_TOKEN, CARD_USER and CORE_DIR are required");
}

const gql = async (query, variables) => {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "readme-cards",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
};

// 1) own public repos (ownerAffiliations filters the viewed user, not the viewer)
const OWN_QUERY = `query ($login: String!, $first: Int!) {
  user(login: $login) {
    repositories(first: $first, ownerAffiliations: [OWNER], isFork: false) {
      nodes { id name nameWithOwner isPrivate stargazerCount languages(first: 10) { edges { size node { name color } } } }
    }
  }
}`;

// 2) contribution years + per-year public repo groups (commit group also returns
//    your commit count per repo, used as the contribution weight)
const YEARS_QUERY = `query ($login: String!) {
  user(login: $login) { contributionsCollection { contributionYears } }
}`;
const YEAR_QUERY = `query ($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      commitContributionsByRepository(maxRepositories: 100) {
        repository { id name nameWithOwner isPrivate stargazerCount }
        contributions { totalCount }
      }
      issueContributionsByRepository(maxRepositories: 100) { repository { id name nameWithOwner isPrivate stargazerCount } }
      pullRequestContributionsByRepository(maxRepositories: 100) { repository { id name nameWithOwner isPrivate stargazerCount } }
      pullRequestReviewContributionsByRepository(maxRepositories: 100) { repository { id name nameWithOwner isPrivate stargazerCount } }
    }
  }
}`;

const repos = new Map(); // id -> { id, nameWithOwner, isPrivate, languages }
const addRepo = (node, languages = []) => {
  if (!node || !node.id) return;
  if (!repos.has(node.id)) {
    repos.set(node.id, {
      id: node.id,
      name: node.name,
      nameWithOwner: node.nameWithOwner,
      isPrivate: node.isPrivate,
      stars: node.stargazerCount ?? 0,
      languages,
    });
  }
};

// own public repos (with language bytes already inlined)
const ownIds = new Set();
const own = await gql(OWN_QUERY, { login, first: 100 });
for (const node of own.user.repositories.nodes) {
  if (node) {
    addRepo(node, node.languages?.edges ?? []);
    if (node.id) ownIds.add(node.id);
  }
}

// contribution-driven public repos (languages fetched separately by id)
const { contributionYears } = (await gql(YEARS_QUERY, { login })).user
  .contributionsCollection;
const langCache = new Map(); // id -> edges
const fetchLanguages = async (id) => {
  if (langCache.has(id)) return langCache.get(id);
  const q = `query ($id: ID!) {
    node(id: $id) {
      ... on Repository { languages(first: 10) { edges { size node { name color } } } }
    }
  }`;
  const data = await gql(q, { id });
  const edges = data.node?.languages?.edges ?? [];
  langCache.set(id, edges);
  return edges;
};

// per-repo commit count (your contributions) -> contribution weight
const commitCounts = new Map();
const contributedIds = new Set(); // repos reached through contribution records
let scannedYears = 0;
for (const year of contributionYears) {
  const from = `${year}-01-01T00:00:00Z`;
  const to = `${year}-12-31T23:59:59Z`;
  const col = (
    await gql(YEAR_QUERY, { login, from, to })
  ).user.contributionsCollection;
  for (const item of col.commitContributionsByRepository) {
    addRepo(item.repository);
    if (item.repository?.id) contributedIds.add(item.repository.id);
    if (item.repository?.id) {
      const c = item.contributions?.totalCount || 0;
      commitCounts.set(item.repository.id, (commitCounts.get(item.repository.id) || 0) + c);
    }
  }
  for (const key of [
    "issueContributionsByRepository",
    "pullRequestContributionsByRepository",
    "pullRequestReviewContributionsByRepository",
  ]) {
    for (const item of col[key]) {
      addRepo(item.repository);
      if (item.repository?.id) contributedIds.add(item.repository.id);
    }
  }
  scannedYears += 1;
}

// fetch languages for contributed (non-owned) repos, then aggregate with commit weighting
let publicRepos = 0;
let bytesRaw = 0;
const languages = {};
const unweightedLanguages = {};
const repoDetails = [];
for (const repo of repos.values()) {
  if (repo.isPrivate) continue;
  const weight = commitCounts.get(repo.id) || 1; // proxy: your commit activity in this repo
  const edges = repo.languages?.length ? repo.languages : await fetchLanguages(repo.id);
  publicRepos += 1;
  const repoLanguages = edges.filter((edge) => edge?.node);
  const rawBytes = repoLanguages.reduce((sum, edge) => sum + edge.size, 0);
  repoDetails.push({
    name: repo.nameWithOwner,
    commits: commitCounts.get(repo.id) || 0,
    weight,
    rawBytes,
    weightedBytes: rawBytes * weight,
    languages: repoLanguages,
  });
  for (const edge of edges) {
    if (!edge || !edge.node) continue;
    const key = edge.node.name;
    // Both cards use the same repositories and fetched language bytes.
    for (const [target, size] of [
      [languages, edge.size * weight],
      [unweightedLanguages, edge.size],
    ]) {
      const current = target[key];
      if (current) {
        current.size += size;
        current.count += 1;
      } else {
        target[key] = {
          name: key,
          color: edge.node.color || "#555555",
          size,
          count: 1,
        };
      }
    }
    bytesRaw += edge.size;
  }
}
if (bytesRaw === 0) {
  throw new Error("no language bytes fetched; refusing to overwrite the card");
}

// upstream default formatting: size^1 * count^0 (count is repo count, exponent 0)
// --- keep the README note in sync with the number computed above -------------------
// Reuses publicRepos (already counted for the card). No second discovery pass.
const weightedTotal = repoDetails.reduce((sum, repo) => sum + repo.weightedBytes, 0);
const commitTotal = repoDetails.reduce((sum, repo) => sum + repo.commits, 0);
const percent = (part, total) => total ? `${(part / total * 100).toFixed(2)}%` : "0.00%";
const integer = (value) => value.toLocaleString("en-US");
const cell = (value) => String(value).replace(/\|/g, "&#124;").replace(/[\r\n]/g, " ");
const detailRows = repoDetails
  .sort((a, b) => b.weightedBytes - a.weightedBytes || a.name.localeCompare(b.name))
  .map((repo) => {
    const mainLanguages = [...repo.languages]
      .sort((a, b) => b.size - a.size)
      .slice(0, 3)
      .map((edge) => `${cell(edge.node.name)} ${percent(edge.size, repo.rawBytes)}`)
      .join("、") || "—";
    return `| [${cell(repo.name)}](https://github.com/${repo.name}) | ${integer(repo.commits)} | ${integer(repo.weight)} | ${integer(repo.rawBytes)} | ${percent(repo.rawBytes, bytesRaw)} | ${percent(repo.weightedBytes, weightedTotal)} | ${mainLanguages} |`;
  });
const detailsBlock = [
  "<!-- lang-repo-details:start -->",
  "<details>",
  `<summary>展开仓库统计明细（${publicRepos} 个公开库 · ${integer(commitTotal)} 次 commit）</summary>`,
  "",
  "按加权占比从高到低排列；所有数值与上方卡片使用同一次扫描的数据。",
  "",
  "| 仓库 | 你的 commit 数 | 权重 | 语言字节数（B） | 无加权占比 | 加权占比 | 仓库主要语言（前三） |",
  "| :--- | ---: | ---: | ---: | ---: | ---: | :--- |",
  ...detailRows,
  `| **合计** | **${integer(commitTotal)}** | — | **${integer(bytesRaw)}** | **100.00%** | **100.00%** | — |`,
  "",
  "- commit 数：GitHub 各年公开贡献记录中归属于你的 commit 数之和；0 表示该扫描未发现你的 commit 贡献记录。",
  "- 权重 = commit 数；为 0 时按现有卡片算法取 1。仓库可能由 issue、PR、review 或个人公开库列表发现。",
  "- 无加权占比 = 本仓库语言字节数 ÷ 全部仓库语言字节数；加权占比 = 本仓库语言字节数 × 权重 ÷ 全部仓库的加权字节数。",
  "- 语言字节数是 GitHub 返回的仓库语言数据（每库最多前 10 种语言），并非你个人编写的字节数；主要语言的百分比以本仓库采集到的语言字节数为分母。",
  "- 表格包含全部采集到的语言；卡片仅展示各自前 20 种语言并重新归一化，因此表格按仓库汇总的占比与卡片按语言展示的占比口径不同。百分比四舍五入后可能不恰好相加为 100%。",
  "",
  "</details>",
  "<!-- lang-repo-details:end -->",
].join("\n");
const README_PATH = process.env.README_PATH || "README.md";
const noteLine = `同一批 ${publicRepos} 个公开库（个人公开库 ＋ 各年公开贡献记录发现的组织/他人公开库）；左图按你的 commit 数加权，右图按原始语言字节数汇总。`;
try {
  if (existsSync(README_PATH)) {
    const md = readFileSync(README_PATH, "utf8");
    const withNote = md.replace(/^(?:按你 commit 数加权 · |同一批 \d+ 个公开库).*$/m, noteLine);
    const detailsPattern = /<!-- lang-repo-details:start -->[\s\S]*?<!-- lang-repo-details:end -->/;
    const updated = detailsPattern.test(withNote)
      ? withNote.replace(detailsPattern, () => detailsBlock)
      : withNote.replace(noteLine, () => `${noteLine}\n\n${detailsBlock}`);
    if (updated !== md) {
      writeFileSync(README_PATH, updated);
      console.log(`updated ${README_PATH}: ${noteLine}`);
    } else {
      console.log(`${README_PATH}: note and repository details already current`);
    }
  }
} catch (err) {
  console.log(`::warning::could not update README note: ${err.message}`);
}
const sorted = Object.fromEntries(
  Object.entries(languages).sort(([, a], [, b]) => b.size - a.size),
);

const toUrl = (p) => pathToFileURL(path.join(coreDir, p)).href;
const { renderTopLanguages } = await import(toUrl("build/cards/top-languages.js"));
const { pickColorParams } = await import(toUrl("build/common/color.js"));
// --- stats card from the SAME scan -------------------------------------------------
// No second discovery pass: the repo set above already knows which repos are public,
// how many stars they carry, and which ones the account contributed to across years.
const publicList = [...repos.values()].filter((r) => !r.isPrivate);
// "Total Stars Earned" counts stars on repositories the account OWNS, not on every
// repo it merely contributed to - otherwise a big third-party project would inflate it.
const ownPublic = publicList.filter((r) => ownIds.has(r.id));
const totalStars = ownPublic.reduce((sum, r) => sum + (r.stars ?? 0), 0);

const USER_STATS_QUERY = `query ($login: String!) {
  user(login: $login) {
    name
    login
    followers { totalCount }
    pullRequests(first: 1) { totalCount }
    mergedPullRequests: pullRequests(states: MERGED) { totalCount }
    openIssues: issues(states: OPEN) { totalCount }
    closedIssues: issues(states: CLOSED) { totalCount }
    reviews: contributionsCollection { totalPullRequestReviewContributions }
    repositoryDiscussions { totalCount }
    repositoryDiscussionComments(onlyAnswers: true) { totalCount }
    repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount }
  }
}`;
const su = (await gql(USER_STATS_QUERY, { login })).user;

const searchCommitCount = async (user) => {
  const res = await fetch(
    "https://api.github.com/search/commits?per_page=1&q=" + encodeURIComponent(`author:${user}`),
    {
      headers: {
        Authorization: `bearer ${token}`,
        Accept: "application/vnd.github.cloak-preview",
        "User-Agent": "readme-cards",
      },
    },
  );
  const json = await res.json();
  if (typeof json.total_count !== "number") {
    throw new Error("commit search failed: " + JSON.stringify(json).slice(0, 200));
  }
  return json.total_count;
};

const totalCommits = await searchCommitCount(login);
const totalPRs = su.pullRequests.totalCount;
const totalPRsMerged = su.mergedPullRequests.totalCount;
const totalIssues = su.openIssues.totalCount + su.closedIssues.totalCount;
const totalReviews = su.reviews.totalPullRequestReviewContributions;
const { calculateRank } = await import(toUrl("build/calculateRank.js"));
const { renderStatsCard } = await import(toUrl("build/cards/stats.js"));

const statsData = {
  name: su.name || su.login,
  totalStars,
  totalCommits,
  totalPRs,
  totalPRsMerged,
  mergedPRsPercentage: totalPRs ? (totalPRsMerged / totalPRs) * 100 : 0,
  totalReviews,
  totalIssues,
  totalDiscussionsStarted: su.repositoryDiscussions?.totalCount ?? 0,
  totalDiscussionsAnswered: su.repositoryDiscussionComments?.totalCount ?? 0,
  contributedTo: su.repositoriesContributedTo.totalCount,
  // own repos excluded, matching upstream's default (contribs_include_own_repos = false)
  allTimeContributedTo: [...contributedIds].filter((id) => !ownIds.has(id)).length,
  rank: calculateRank({
    all_commits: true,
    commits: totalCommits,
    prs: totalPRs,
    reviews: totalReviews,
    issues: totalIssues,
    repos: ownPublic.length,
    stars: totalStars,
    followers: su.followers.totalCount,
  }),
};

const svg = renderTopLanguages(sorted, {
  ...pickColorParams({ theme: "buefy" }),
  layout: "compact",
  langs_count: langsCount,
  hide_title: false,
});

writeFileSync(out, svg);

const unweightedSorted = Object.fromEntries(
  Object.entries(unweightedLanguages).sort(([, a], [, b]) => b.size - a.size),
);
const unweightedSvg = renderTopLanguages(unweightedSorted, {
  ...pickColorParams({ theme: "buefy" }),
  layout: "compact",
  langs_count: langsCount,
  hide_title: false,
});
writeFileSync(unweightedOut, unweightedSvg);
console.log(
  `wrote ${unweightedOut}: ${Object.keys(unweightedSorted).length} languages from ` +
    `${publicRepos} public repos (${bytesRaw} raw bytes, unweighted)`,
);

const statsSvg = renderStatsCard(
  statsData,
  {
    ...pickColorParams({ theme: "buefy" }),
    show_icons: true,
    include_all_commits: true,
    show: [
      "reviews",
      "discussions_started",
      "discussions_answered",
      "prs_merged",
      "prs_merged_percentage",
      "all_time_contribs",
    ],
  },
  login,
);
writeFileSync(statsOut, statsSvg);
console.log(
  `wrote ${statsOut}: stars=${totalStars} commits=${totalCommits} prs=${totalPRs} ` +
    `merged=${totalPRsMerged} issues=${totalIssues} contributedTo=${statsData.contributedTo}/${statsData.allTimeContributedTo}`,
);
console.log(
  `wrote ${out}: ${Object.keys(sorted).length} languages from ${publicRepos} public repos ` +
    `(${bytesRaw} raw bytes, commit-weighted); scanned ${scannedYears}/${contributionYears.length} contribution years`,
);