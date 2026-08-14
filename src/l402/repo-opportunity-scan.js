import { createHash, timingSafeEqual } from "node:crypto";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const GITHUB_API_VERSION = "2022-11-28";

const POSITIVE_LABEL_WEIGHTS = new Map([
  ["good first issue", 25],
  ["help wanted", 20],
  ["bounty", 20],
  ["reward", 20],
  ["paid", 20],
  ["bug", 5],
]);

const RISKY_LABELS = new Set([
  "blocked",
  "duplicate",
  "needs design",
  "needs discussion",
  "needs hardware",
  "needs repro",
  "question",
  "wontfix",
]);

const HARDWARE_PATTERN =
  /\b(hardware|device|iphone|ipad|android phone|raspberry pi|ledger|trezor|camera|gps|bluetooth|nfc|usb)\b/i;
const PAYOUT_PATTERN =
  /\b(bounty|reward|paid|payment|sats?|satoshi|bitcoin|btc|lightning)\b/i;

export function parsePublicGitHubRepository(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate) {
    throw inputError("repo is required as owner/name or a public GitHub URL");
  }

  let slug = candidate;
  if (/^https?:\/\//i.test(candidate)) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      throw inputError("repo must be a valid public GitHub repository URL");
    }
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
      throw inputError("repo URL must use https://github.com");
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) {
      throw inputError("repo URL must point to one GitHub owner/repository");
    }
    slug = `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
  }

  const parts = slug.split("/");
  if (parts.length === 2) {
    parts[1] = parts[1].replace(/\.git$/i, "");
  }
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[1])
  ) {
    throw inputError("repo must be a public GitHub owner/repository slug");
  }

  return `${parts[0]}/${parts[1]}`;
}

export function parseOpportunityLimit(value) {
  if (value == null || value === "") return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw inputError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

export function createL402GatewayGuard(expectedToken) {
  return (req, _res, next) => {
    try {
      if (!expectedToken) {
        const error = new Error("L402 backend gateway is not configured");
        error.statusCode = 503;
        throw error;
      }

      const candidate = String(req.get("x-l402-backend-token") ?? "");
      if (!secureStringEqual(candidate, expectedToken)) {
        const error = new Error("valid L402 gateway credential required");
        error.statusCode = 401;
        throw error;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export function createL402BackendRateLimit(maxRequests, options = {}) {
  const limit = Number.isInteger(maxRequests) && maxRequests > 0
    ? maxRequests
    : 30;
  const now = options.now ?? Date.now;
  const windowMs = 60_000;
  let windowStartedAt = now();
  let requests = 0;

  return (_req, res, next) => {
    const currentTime = now();
    if (currentTime - windowStartedAt >= windowMs) {
      windowStartedAt = currentTime;
      requests = 0;
    }

    if (requests >= limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowMs - (currentTime - windowStartedAt)) / 1000),
      );
      res.set("Retry-After", String(retryAfterSeconds));
      const error = new Error("L402 backend request limit exceeded");
      error.statusCode = 429;
      next(error);
      return;
    }

    requests += 1;
    next();
  };
}

export async function buildRepoOpportunityScan(input, options = {}) {
  const repo = parsePublicGitHubRepository(input?.repo);
  const limit = parseOpportunityLimit(input?.limit);
  const fetchImpl = options.fetchImpl ?? fetch;
  const githubApi = options.githubApi ?? "https://api.github.com";
  const githubToken = options.githubToken ?? "";
  const nowValue = typeof options.now === "function"
    ? options.now()
    : options.now ?? new Date();
  const now = new Date(nowValue);
  const startedAt = Date.now();

  const repository = await fetchGitHubJson(
    `/repos/${repo}`,
    "repository",
    { fetchImpl, githubApi, githubToken },
  );

  if (repository.private) {
    const error = new Error("repository request failed: 404");
    error.statusCode = 404;
    throw error;
  }

  const [issueRows, pullRows] = await Promise.all([
    fetchGitHubJson(
      `/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=50`,
      "open issues",
      { fetchImpl, githubApi, githubToken },
    ),
    fetchGitHubJson(
      `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=50`,
      "open pull requests",
      { fetchImpl, githubApi, githubToken },
    ),
  ]);

  const issues = Array.isArray(issueRows)
    ? issueRows.filter((issue) => !issue.pull_request)
    : [];
  const pulls = Array.isArray(pullRows) ? pullRows : [];
  const references = indexPullRequestReferences(pulls);
  const candidates = issues
    .map((issue) => scoreIssue(issue, references.get(Number(issue.number)) ?? [], now))
    .sort(compareCandidates)
    .slice(0, limit);

  const repositoryRisks = [];
  if (repository.archived) repositoryRisks.push("repository_archived");
  if (repository.disabled) repositoryRisks.push("repository_disabled");
  if (repository.fork) repositoryRisks.push("repository_is_fork");
  if (!repository.license?.spdx_id) repositoryRisks.push("license_not_detected");

  const topCandidate = candidates[0] ?? null;
  const decision = repository.archived || repository.disabled
    ? "avoid_repository"
    : topCandidate?.actionability === "high" && topCandidate.competition.length === 0
      ? "inspect_top_candidate"
      : candidates.length > 0
        ? "manual_review_required"
        : "no_open_issue_candidate";

  return {
    service: "Agent Commerce Desk L402 Repo Opportunity Scan",
    version: "1",
    generatedAt: now.toISOString(),
    source: "GitHub public REST API",
    access: {
      protocol: "L402",
      paymentVerifiedBy: "Aperture gateway",
      gatewayChallengeIsAuthoritative: true,
    },
    request: { repo, limit },
    repository: {
      fullName: repository.full_name ?? repo,
      htmlUrl: repository.html_url ?? `https://github.com/${repo}`,
      description: repository.description ?? null,
      defaultBranch: repository.default_branch ?? null,
      primaryLanguage: repository.language ?? null,
      license: repository.license?.spdx_id ?? null,
      archived: Boolean(repository.archived),
      disabled: Boolean(repository.disabled),
      fork: Boolean(repository.fork),
      openIssueRowsInspected: issues.length,
      openPullRequestRowsInspected: pulls.length,
      pushedAt: repository.pushed_at ?? null,
      risks: repositoryRisks,
    },
    decision,
    candidates,
    guardrails: [
      "A score is triage evidence, not maintainer assignment or payout confirmation.",
      "Recheck the issue, comments, linked pull requests, and contribution rules before work.",
      "Do not start hardware-gated work without matching local hardware and testability.",
      "Treat every payout keyword as unverified until an authorized payer and amount are explicit.",
    ],
    latencyMs: Date.now() - startedAt,
  };
}

function scoreIssue(issue, competingPulls, now) {
  const labels = normalizeLabels(issue.labels);
  const reasons = [];
  const risks = [];
  let score = 25;

  for (const label of labels) {
    const weight = POSITIVE_LABEL_WEIGHTS.get(label);
    if (weight) {
      score += weight;
      reasons.push(`label:${label}`);
    }
    if (RISKY_LABELS.has(label)) {
      score -= 20;
      risks.push(`label:${label}`);
    }
  }

  const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
  if (assignees.length === 0) {
    score += 15;
    reasons.push("unassigned");
  } else {
    score -= 15;
    risks.push("already_assigned");
  }

  const comments = Number(issue.comments ?? 0);
  if (comments === 0) {
    score += 10;
    reasons.push("no_comments");
  } else if (comments <= 3) {
    score += 5;
    reasons.push("low_comment_count");
  } else if (comments > 10) {
    score -= 5;
    risks.push("high_discussion_count");
  }

  const updatedAt = new Date(issue.updated_at ?? issue.created_at ?? 0);
  const ageDays = Number.isFinite(updatedAt.getTime())
    ? Math.max(0, Math.floor((now.getTime() - updatedAt.getTime()) / 86_400_000))
    : null;
  if (ageDays != null && ageDays <= 30) {
    score += 10;
    reasons.push("updated_within_30_days");
  } else if (ageDays != null && ageDays <= 90) {
    score += 5;
    reasons.push("updated_within_90_days");
  } else if (ageDays != null && ageDays > 365) {
    score -= 10;
    risks.push("stale_over_one_year");
  }

  const issueText = `${issue.title ?? ""}\n${issue.body ?? ""}`;
  if (HARDWARE_PATTERN.test(issueText)) {
    score -= 30;
    risks.push("possible_hardware_dependency");
  }

  const payoutSignal = PAYOUT_PATTERN.test(issueText) ||
    labels.some((label) => ["bounty", "reward", "paid"].includes(label));
  if (payoutSignal) {
    reasons.push("unverified_payout_keyword");
  }

  if (competingPulls.length > 0) {
    score -= Math.min(50, competingPulls.length * 25);
    risks.push("open_pull_request_competition");
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  return {
    issueNumber: Number(issue.number),
    title: String(issue.title ?? ""),
    htmlUrl: issue.html_url ?? null,
    score: boundedScore,
    actionability: boundedScore >= 65 ? "high" : boundedScore >= 40 ? "medium" : "low",
    labels,
    assignees: assignees.map((assignee) => assignee.login).filter(Boolean),
    comments,
    updatedAt: issue.updated_at ?? null,
    payoutSignal: payoutSignal ? "unverified" : "none_detected",
    reasons: [...new Set(reasons)],
    risks: [...new Set(risks)],
    competition: competingPulls.slice(0, 5).map((pull) => ({
      number: Number(pull.number),
      title: String(pull.title ?? ""),
      htmlUrl: pull.html_url ?? null,
      draft: Boolean(pull.draft),
    })),
  };
}

function indexPullRequestReferences(pulls) {
  const index = new Map();
  for (const pull of pulls) {
    const text = `${pull.title ?? ""}\n${pull.body ?? ""}`;
    const numbers = new Set();
    for (const match of text.matchAll(/(?:#|\/issues\/)(\d+)\b/g)) {
      numbers.add(Number(match[1]));
    }
    for (const number of numbers) {
      const current = index.get(number) ?? [];
      current.push(pull);
      index.set(number, current);
    }
  }
  return index;
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return [...new Set(labels
    .map((label) => typeof label === "string" ? label : label?.name)
    .filter(Boolean)
    .map((label) => String(label).trim().toLowerCase()))];
}

function compareCandidates(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  return new Date(right.updatedAt ?? 0) - new Date(left.updatedAt ?? 0);
}

async function fetchGitHubJson(path, label, options) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "agent-commerce-desk-l402-repo-scan/1.0.0",
    "x-github-api-version": GITHUB_API_VERSION,
  };
  if (options.githubToken) {
    headers.authorization = `Bearer ${options.githubToken}`;
  }

  const response = await options.fetchImpl(new URL(path, options.githubApi), { headers });
  if (!response.ok) {
    const error = new Error(`${label} request failed: ${response.status}`);
    error.statusCode = response.status === 403 || response.status === 429
      ? 503
      : response.status;
    throw error;
  }
  return response.json();
}

function secureStringEqual(candidate, expected) {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
