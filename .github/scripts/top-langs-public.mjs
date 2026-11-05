// Public-only top-languages card generator.
//
// Why this exists: upstream resolves `affiliations: [ORGANIZATION_MEMBER]`
// against the API *viewer*, so a bot token (GITHUB_TOKEN) can never see the
// organisation repos the account belongs to, and a personal token is needed
// otherwise. This script builds the same language map from PUBLIC data only
// (own public repos + an explicit org list), then reuses the upstream renderer
// so the card looks identical.
//
// NOTE: do not pass `affiliations:` in the own-repos query. GitHub resolves that
// filter against the API *viewer*, so under a bot token it silently drops the
// user's own repos; omitting it returns them regardless of viewer.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const token = process.env.GH_TOKEN;
const login = process.env.CARD_USER;
const orgs = (process.env.CARD_ORGS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const out = process.env.CARD_OUT || "profile/top-langs.svg";
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

const LANGS = "languages(first: 10) { edges { size node { name color } } }";
const OWN_QUERY = `query ($login: String!, $first: Int!) {
  user(login: $login) {
    repositories(first: $first, isFork: false) {
      nodes { nameWithOwner ${LANGS} }
    }
  }
}`;
const ORG_QUERY = `query ($login: String!, $first: Int!) {
  organization(login: $login) {
    repositories(first: $first, isFork: false) {
      nodes { nameWithOwner isPrivate ${LANGS} }
    }
  }
}`;

const repos = [];
const own = await gql(OWN_QUERY, { login, first: 100 });
for (const node of own.user.repositories.nodes) {
  if (node) repos.push(node);
}
for (const org of orgs) {
  try {
    const data = await gql(ORG_QUERY, { login: org, first: 100 });
    for (const node of data.organization.repositories.nodes) {
      // defensive: a bot token cannot read private repos anyway
      if (node && !node.isPrivate) repos.push(node);
    }
  } catch (err) {
    console.log(`::warning::org ${org} skipped: ${err.message}`);
  }
}

const languages = {};
let bytes = 0;
for (const repo of repos) {
  for (const edge of repo.languages?.edges ?? []) {
    if (!edge || !edge.node) continue;
    const key = edge.node.name;
    const current = languages[key];
    if (current) {
      current.size += edge.size;
      current.count += 1;
    } else {
      languages[key] = {
        name: key,
        color: edge.node.color || "#555555",
        size: edge.size,
        count: 1,
      };
    }
    bytes += edge.size;
  }
}
if (bytes === 0) {
  throw new Error("no language bytes fetched; refusing to overwrite the card");
}

// upstream default weighting: size^1 * count^0
const sorted = Object.fromEntries(
  Object.entries(languages).sort(([, a], [, b]) => b.size - a.size),
);

const toUrl = (p) => pathToFileURL(path.join(coreDir, p)).href;
const { renderTopLanguages } = await import(toUrl("build/cards/top-languages.js"));
const { pickColorParams } = await import(toUrl("build/common/color.js"));

const svg = renderTopLanguages(sorted, {
  ...pickColorParams({ theme: "buefy" }),
  layout: "compact",
  langs_count: langsCount,
  hide_title: false,
});
writeFileSync(out, svg);
console.log(
  `wrote ${out}: ${Object.keys(sorted).length} languages from ${repos.length} public repos (${bytes} bytes)`,
);