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
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const token = process.env.GH_TOKEN;
const login = process.env.CARD_USER;
const out = process.env.CARD_OUT || "profile/top-langs.svg";
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
for (const repo of repos.values()) {
  if (repo.isPrivate) continue;
  const weight = commitCounts.get(repo.id) || 1; // proxy: your commit activity in this repo
  const edges = repo.languages?.length ? repo.languages : await fetchLanguages(repo.id);
  publicRepos += 1;
  for (const edge of edges) {
    if (!edge || !edge.node) continue;
    const key = edge.node.name;
    const sized = edge.size * weight;
    const current = languages[key];
    if (current) {
      current.size += sized;
      current.count += 1;
    } else {
      languages[key] = {
        name: key,
        color: edge.node.color || "#555555",
        size: sized,
        count: 1,
      };
    }
    bytesRaw += edge.size;
  }
}
if (bytesRaw === 0) {
  throw new Error("no language bytes fetched; refusing to overwrite the card");
}

// upstream default formatting: size^1 * count^0 (count is repo count, exponent 0)
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
const totalStars = publicList.reduce((sum, r) => sum + (r.stars ?? 0), 0);

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
    repos: publicList.length,
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

// --- note to the right of the card -------------------------------------------------
// GitHub strips inline CSS from README markdown, so a normal-weight, non-wrapping
// note cannot be written as page text. SVG text is not subject to that: it keeps an
// explicit font-weight and never wraps. We widen the card and append the note.
// Scope text lives here so it always matches what the generator actually counted.
const NOTE =
  process.env.CARD_NOTE ||
  `按你 commit 数加权 · ${publicRepos} 个公开库（个人公开＋各年贡献记录发现）`;
const CARD_W = 300;
const GAP_L = 18;
const GAP_R = 14;
const cjk = /[\u3000-\u9fff\uff00-\uffef]/;
const noteWidth = [...NOTE].reduce((w, ch) => w + (cjk.test(ch) ? 11 : 6.2), 0);
const totalW = Math.ceil(CARD_W + GAP_L + noteWidth + GAP_R);
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
if (svg.split('width="300"').length !== 2) {
  throw new Error("svg width attribute not in expected shape; refusing to widen");
}
let outSvg = svg
  .replace('width="300"', `width="${totalW}"`)
  .replace('viewBox="0 0 300 340"', `viewBox="0 0 ${totalW} 340"`)
  .replace('width="299"', `width="${totalW - 1}"`)
  .replace(
    "</style>",
    `.card-note { font: 400 11px 'Segoe UI', Ubuntu, "Helvetica Neue", Sans-Serif; fill: #363636; }
        </style>`,
  )
  .replace(
    "</svg>",
    `<text x="${CARD_W + GAP_L}" y="39" class="card-note" data-testid="card-note">${esc(NOTE)}</text>
      </svg>`,
  );
writeFileSync(out, outSvg);

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