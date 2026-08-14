import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRepoOpportunityScan,
  createL402BackendRateLimit,
  createL402GatewayGuard,
  parseOpportunityLimit,
  parsePublicGitHubRepository,
} from "../src/l402/repo-opportunity-scan.js";

test("normalizes public GitHub repository inputs", () => {
  assert.equal(parsePublicGitHubRepository("owner/repo"), "owner/repo");
  assert.equal(
    parsePublicGitHubRepository("https://github.com/owner/repo.git"),
    "owner/repo",
  );
  assert.throws(
    () => parsePublicGitHubRepository("https://gitlab.com/owner/repo"),
    /github\.com/,
  );
  assert.throws(
    () => parsePublicGitHubRepository("https://github.com/owner/repo/issues/1"),
    /owner\/repository/,
  );
});

test("bounds the candidate limit", () => {
  assert.equal(parseOpportunityLimit(undefined), 5);
  assert.equal(parseOpportunityLimit("10"), 10);
  assert.throws(() => parseOpportunityLimit("0"), /1 to 10/);
  assert.throws(() => parseOpportunityLimit("2.5"), /1 to 10/);
});

test("requires a configured private gateway credential", () => {
  const disabledError = runGuard(createL402GatewayGuard(""), "anything");
  assert.equal(disabledError.statusCode, 503);

  const unauthorizedError = runGuard(
    createL402GatewayGuard("expected-token"),
    "wrong-token",
  );
  assert.equal(unauthorizedError.statusCode, 401);

  assert.equal(
    runGuard(createL402GatewayGuard("expected-token"), "expected-token"),
    undefined,
  );
});

test("caps authenticated backend traffic even if the gateway token leaks", () => {
  let clock = 0;
  const middleware = createL402BackendRateLimit(2, { now: () => clock });
  const headers = new Map();
  const res = {
    set(name, value) {
      headers.set(name, value);
    },
  };

  assert.equal(runMiddleware(middleware, res), undefined);
  assert.equal(runMiddleware(middleware, res), undefined);
  assert.equal(runMiddleware(middleware, res).statusCode, 429);
  assert.equal(headers.get("Retry-After"), "60");

  clock = 60_000;
  assert.equal(runMiddleware(middleware, res), undefined);
});

test("ranks unassigned low-competition issues above crowded hardware work", async () => {
  const fetchImpl = githubFixtureFetch({
    repository: {
      full_name: "example/project",
      html_url: "https://github.com/example/project",
      description: "Example repository",
      default_branch: "main",
      language: "JavaScript",
      license: { spdx_id: "MIT" },
      private: false,
      archived: false,
      disabled: false,
      fork: false,
      pushed_at: "2026-08-13T12:00:00Z",
    },
    issues: [
      {
        number: 11,
        title: "Fix deterministic parser regression",
        body: "A focused parser bug with a reproduction.",
        html_url: "https://github.com/example/project/issues/11",
        labels: [{ name: "good first issue" }, { name: "bug" }],
        assignees: [],
        comments: 0,
        updated_at: "2026-08-13T12:00:00Z",
      },
      {
        number: 12,
        title: "Paid hardware wallet Bluetooth bounty",
        body: "Requires a Ledger device and Bluetooth testing. Reward in sats.",
        html_url: "https://github.com/example/project/issues/12",
        labels: [{ name: "bounty" }, { name: "needs hardware" }],
        assignees: [],
        comments: 2,
        updated_at: "2026-08-13T12:00:00Z",
      },
    ],
    pulls: [
      {
        number: 99,
        title: "Implement hardware wallet support",
        body: "Closes #12",
        html_url: "https://github.com/example/project/pull/99",
        draft: false,
      },
    ],
  });

  const report = await buildRepoOpportunityScan(
    { repo: "example/project", limit: "5" },
    {
      fetchImpl,
      now: "2026-08-14T12:00:00Z",
    },
  );

  assert.equal(report.decision, "inspect_top_candidate");
  assert.equal(report.candidates[0].issueNumber, 11);
  assert.equal(report.candidates[0].actionability, "high");
  assert.equal(report.candidates[0].competition.length, 0);

  const hardwareCandidate = report.candidates.find(
    (candidate) => candidate.issueNumber === 12,
  );
  assert.equal(hardwareCandidate.payoutSignal, "unverified");
  assert.deepEqual(hardwareCandidate.competition.map((pull) => pull.number), [99]);
  assert.ok(hardwareCandidate.risks.includes("possible_hardware_dependency"));
  assert.ok(hardwareCandidate.risks.includes("open_pull_request_competition"));
});

test("refuses to recommend work in an archived repository", async () => {
  const fetchImpl = githubFixtureFetch({
    repository: {
      full_name: "example/archive",
      html_url: "https://github.com/example/archive",
      private: false,
      archived: true,
      disabled: false,
      fork: false,
      license: null,
    },
    issues: [],
    pulls: [],
  });

  const report = await buildRepoOpportunityScan(
    { repo: "https://github.com/example/archive" },
    { fetchImpl, now: "2026-08-14T12:00:00Z" },
  );

  assert.equal(report.decision, "avoid_repository");
  assert.ok(report.repository.risks.includes("repository_archived"));
});

test("maps GitHub rate limits to a retryable service failure", async () => {
  const fetchImpl = async () => jsonResponse({}, 403);
  await assert.rejects(
    buildRepoOpportunityScan(
      { repo: "example/project" },
      { fetchImpl, now: "2026-08-14T12:00:00Z" },
    ),
    (error) => error.statusCode === 503 && /repository request failed/.test(error.message),
  );
});

test("does not reveal whether the configured GitHub token can see a private repo", async () => {
  const fetchImpl = githubFixtureFetch({
    repository: {
      full_name: "example/private-project",
      private: true,
    },
    issues: [],
    pulls: [],
  });

  await assert.rejects(
    buildRepoOpportunityScan(
      { repo: "example/project" },
      { fetchImpl, now: "2026-08-14T12:00:00Z" },
    ),
    (error) => error.statusCode === 404 &&
      error.message === "repository request failed: 404",
  );
});

function runGuard(guard, candidate) {
  let captured;
  guard(
    {
      get(name) {
        return name.toLowerCase() === "x-l402-backend-token" ? candidate : undefined;
      },
    },
    {},
    (error) => {
      captured = error;
    },
  );
  return captured;
}

function runMiddleware(middleware, res) {
  let captured;
  middleware({}, res, (error) => {
    captured = error;
  });
  return captured;
}

function githubFixtureFetch(fixture) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/example/project" ||
        parsed.pathname === "/repos/example/archive") {
      return jsonResponse(fixture.repository);
    }
    if (parsed.pathname.endsWith("/issues")) {
      return jsonResponse(fixture.issues);
    }
    if (parsed.pathname.endsWith("/pulls")) {
      return jsonResponse(fixture.pulls);
    }
    return jsonResponse({}, 404);
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}
