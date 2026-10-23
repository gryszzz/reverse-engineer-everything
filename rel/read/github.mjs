import { requestHeaders } from "../outside-in/fetch.mjs";

const OPEN_SOURCE = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "MPL-2.0",
  "LGPL-2.1",
  "LGPL-2.1-only",
  "LGPL-3.0",
  "LGPL-3.0-only",
  "GPL-2.0",
  "GPL-2.0-only",
  "GPL-3.0",
  "GPL-3.0-only",
  "AGPL-3.0",
  "AGPL-3.0-only",
  "CC0-1.0",
]);

const FILE_OK =
  /^(readme\.md|openapi\.(yaml|yml|json)|swagger\.(yaml|yml|json)|schema\.(graphql|gql)|postman.*\.json|collection\.json)$/iu;

export async function readGithubRepo({
  owner,
  repo,
  fetchImpl,
  sleep,
  minIntervalMs,
}) {
  const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const calls = [];
  const repoResponse = await get(fetchImpl, repoUrl, calls, sleep, 0);
  if (!repoResponse.ok)
    return {
      documents: [],
      skipped: [
        {
          target: `https://github.com/${owner}/${repo}`,
          reason: `The public repository API returned HTTP ${repoResponse.status}. No files were read.`,
        },
      ],
      calls,
    };
  let meta;
  try {
    meta = JSON.parse(repoResponse.body);
  } catch {
    return {
      documents: [],
      skipped: [
        {
          target: repoUrl,
          reason: "The repository description could not be parsed.",
        },
      ],
      calls,
    };
  }
  if (meta.private === true) {
    return {
      documents: [],
      skipped: [
        {
          target: `https://github.com/${owner}/${repo}`,
          reason: "Private repositories are not read.",
        },
      ],
      calls,
    };
  }
  const license = meta.license?.spdx_id ?? null;
  if (!OPEN_SOURCE.has(license)) {
    return {
      documents: [],
      skipped: [
        {
          target: `https://github.com/${owner}/${repo}`,
          reason: license
            ? `License ${license} is not a recognized open-source license. Repository files were not read.`
            : "No open-source license was published. Repository files were not read.",
        },
      ],
      calls,
      license,
    };
  }
  const documents = [];
  const skipped = [];
  const readme = await get(
    fetchImpl,
    `${repoUrl}/readme`,
    calls,
    sleep,
    minIntervalMs,
  );
  const readmeBody = readme.ok ? decodeContent(readme.body) : null;
  if (readmeBody) {
    documents.push({
      url: `https://github.com/${owner}/${repo}`,
      role: "docs",
      kind: "sdk-readme",
      type: "text/markdown; charset=utf-8",
      body: readmeBody,
    });
  } else {
    skipped.push({
      target: `${repoUrl}/readme`,
      reason: "The README was not available.",
    });
  }
  const listing = await get(
    fetchImpl,
    `${repoUrl}/contents/`,
    calls,
    sleep,
    minIntervalMs,
  );
  let files = [];
  try {
    const parsed = JSON.parse(listing.body || "[]");
    files = Array.isArray(parsed) ? parsed : [];
  } catch {
    skipped.push({
      target: `${repoUrl}/contents/`,
      reason: "The file list could not be parsed.",
    });
  }
  let taken = 0;
  for (const file of files) {
    if (file?.type !== "file" || typeof file.name !== "string") continue;
    if (/^readme\.md$/iu.test(file.name)) continue;
    if (!FILE_OK.test(file.name)) continue;
    if (taken >= 4) {
      skipped.push({
        target: file.name,
        reason: "Past the 4 repository schema file limit.",
      });
      continue;
    }
    const fileUrl = `${repoUrl}/contents/${encodeURIComponent(file.name)}`;
    const fetched = await get(fetchImpl, fileUrl, calls, sleep, minIntervalMs);
    const body = fetched.ok ? decodeContent(fetched.body) : null;
    if (!body) {
      skipped.push({
        target: file.name,
        reason: "The file content was not available.",
      });
      continue;
    }
    taken += 1;
    documents.push({
      url: `https://github.com/${owner}/${repo}/blob/HEAD/${file.name}`,
      role: "docs",
      kind: kindFor(file.name),
      type: typeFor(file.name),
      body,
    });
  }
  skipped.push({
    target: `https://github.com/${owner}/${repo}`,
    reason: "Other repository files were not read. Source code is not copied.",
  });
  return {
    documents,
    skipped,
    calls,
    license,
    name: meta.full_name ?? `${owner}/${repo}`,
  };
}

function kindFor(name) {
  if (/\.(graphql|gql)$/iu.test(name)) return "graphql";
  if (/openapi|swagger/iu.test(name)) return "openapi";
  return null;
}

function typeFor(name) {
  if (name.endsWith(".json")) return "application/json; charset=utf-8";
  if (/\.ya?ml$/iu.test(name)) return "application/yaml; charset=utf-8";
  if (/\.(graphql|gql)$/iu.test(name)) return "text/plain; charset=utf-8";
  return "text/markdown; charset=utf-8";
}

function decodeContent(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed.encoding !== "base64" || typeof parsed.content !== "string")
      return null;
    return Buffer.from(parsed.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

async function get(fetchImpl, url, calls, sleep, wait) {
  if (wait > 0) await sleep(wait);
  const headers = requestHeaders();
  delete headers.authorization;
  delete headers.Authorization;
  calls.push({ url, authorization: false });
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    headers,
  });
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    body: await response.text(),
  };
}
