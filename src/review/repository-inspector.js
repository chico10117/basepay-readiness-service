import {
  readResponseText,
  safeFetch,
  sanitizeEvidenceText,
  TargetAccessError,
} from "./target-policy.js";

const GITHUB_API = process.env.GITHUB_API ?? "https://api.github.com";
const GITHUB_TOKEN = process.env.GITHUB_PUBLIC_API_TOKEN ?? "";
const MAX_FILES = Math.max(1, Number(process.env.REVIEW_MAX_FILES ?? "40"));
const MAX_TOTAL_BYTES = Math.max(10_000, Number(process.env.REVIEW_MAX_DOWNLOAD_BYTES ?? "250000"));
const MAX_FILE_BYTES = Math.max(2_000, Number(process.env.REVIEW_MAX_FILE_BYTES ?? "40000"));

export async function inspectRepository(target) {
  if (target.kind !== "github_repo") {
    throw new TargetAccessError("repository inspection requires a public GitHub repository");
  }

  const repoPath = `${target.owner}/${target.repo}`;
  const metadata = await githubJson(`/repos/${repoPath}`);
  if (metadata.private || metadata.visibility === "private") {
    throw new TargetAccessError("private repositories require a future GitHub App integration");
  }

  const branch = metadata.default_branch || "main";
  const ref = await githubJson(`/repos/${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`);
  const commitSha = ref?.object?.sha;
  if (!commitSha) throw new TargetAccessError("GitHub repository has no readable default branch");

  const tree = await githubJson(`/repos/${repoPath}/git/trees/${commitSha}?recursive=1`, 20_000_000);
  const entries = Array.isArray(tree.tree)
    ? tree.tree.filter(entry => entry.type === "blob" && typeof entry.path === "string")
    : [];
  const selected = selectFiles(entries);
  const files = [];
  let totalBytes = 0;

  for (const entry of selected) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    const declaredSize = Number(entry.size ?? 0);
    if (declaredSize > MAX_FILE_BYTES) continue;

    try {
      const content = await githubJson(
        `/repos/${repoPath}/contents/${entry.path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}?ref=${encodeURIComponent(commitSha)}`,
      );
      if (content.encoding !== "base64" || typeof content.content !== "string") continue;
      const decoded = Buffer.from(content.content.replace(/\s/g, ""), "base64");
      if (decoded.byteLength > MAX_FILE_BYTES || totalBytes + decoded.byteLength > MAX_TOTAL_BYTES) {
        continue;
      }
      totalBytes += decoded.byteLength;
      files.push({
        path: entry.path,
        size: decoded.byteLength,
        content: decoded.toString("utf8").slice(0, MAX_FILE_BYTES),
      });
    } catch (error) {
      if (error instanceof TargetAccessError) continue;
      throw error;
    }
  }

  const snapshot = {
    type: "github_repository",
    repository: repoPath,
    source_url: metadata.html_url || target.url,
    default_branch: branch,
    commit_sha: commitSha,
    visibility: metadata.visibility || "public",
    language: metadata.language || null,
    size_kb: metadata.size || null,
    file_count: entries.length,
    tree_truncated: Boolean(tree.truncated),
    retrieved_at: new Date().toISOString(),
  };

  return {
    snapshot,
    evidence: {
      type: "github_repository",
      metadata: {
        name: metadata.full_name,
        description: sanitizeEvidenceText(metadata.description || "", 1000),
        default_branch: branch,
        commit_sha: commitSha,
        html_url: metadata.html_url || target.url,
        language: metadata.language || null,
        open_issues_count: metadata.open_issues_count ?? null,
        pushed_at: metadata.pushed_at || null,
        license: metadata.license?.spdx_id || null,
      },
      tree: {
        file_count: entries.length,
        selected_file_count: files.length,
        truncated: Boolean(tree.truncated),
        selected_paths: files.map(file => file.path),
      },
      files,
    },
  };
}

async function githubJson(path, maxBytes = 1_000_000) {
  const response = await safeFetch(`${GITHUB_API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "x402-wallet-readiness-review-worker",
      ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
  });
  const text = await readResponseText(response, maxBytes);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new TargetAccessError(`GitHub returned invalid JSON (${response.status})`);
  }
  if (!response.ok) {
    throw new TargetAccessError(
      `GitHub request failed (${response.status}): ${sanitizeEvidenceText(payload.message || "unknown error", 300)}`,
      { retryable: response.status >= 500 || response.status === 429 },
    );
  }
  return payload;
}

function selectFiles(entries) {
  return entries
    .filter(entry => {
      const path = entry.path.toLowerCase();
      if (path.includes("node_modules/") || path.includes("vendor/")) return false;
      if (/(^|\/)(\.env|.*\.pem|.*\.key|id_rsa)(\.|$)/i.test(path)) return false;
      return /\.(md|mdx|json|ya?ml|toml|ini|js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|php|sol|sh|html|css)$/.test(path) ||
        /(^|\/)(dockerfile|makefile|readme|license)$/i.test(path);
    })
    .sort((left, right) => fileScore(right.path) - fileScore(left.path))
    .slice(0, MAX_FILES);
}

function fileScore(path) {
  const lower = path.toLowerCase();
  let score = 0;
  if (/readme|package\.json|pyproject|cargo\.toml|go\.mod|dockerfile|makefile/.test(lower)) score += 10;
  if (/x402|payment|checkout|webhook|wallet|facilitator|middleware|route|api|server/.test(lower)) score += 8;
  if (/src\/|app\/|api\/|server\//.test(lower)) score += 5;
  if (/test|spec/.test(lower)) score += 2;
  if (/\.env\.example|config/.test(lower)) score += 4;
  return score - lower.length / 10000;
}
