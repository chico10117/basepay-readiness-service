# Repository Guidelines

## Project Structure & Module Organization

`src/index.js` is the Express entrypoint and defines the API surface. Durable order and settlement logic lives in `src/order-store.js` and `src/settlement-reconciler.js`; automated review code is grouped under `src/review/`, with reusable routers under `src/routes/`. Browser assets are in `public/`. Put operational CLIs in `scripts/`, deployment units in `deploy/`, and database/systemd infrastructure in `ops/`. Tests belong in `test/` and use the same kebab-case naming as their target modules. Treat `reports/`, `campaigns/`, and `AUTOMATED_REVIEW_PLAN.md` as documentation rather than runtime inputs.

## Build, Test, and Development Commands

- `npm ci` installs the locked dependency set.
- `npm start` runs the service on `PORT` (default `4021`); there is no compile step.
- `npm run check` performs syntax checks across source and script files.
- `npm test` runs all Node test-runner suites. The PostgreSQL integration test skips unless `TEST_ORDER_DATABASE_URL` is set.
- `npm run worker` starts the automated review worker.
- `npm run reconcile:settlements` performs an immediate settlement-journal replay.

Use `.env.example` as the configuration inventory, but export values through the shell or service manager; the application does not load `.env` automatically.

## Coding Style & Naming Conventions

Use JavaScript ESM (`import`/`export`), two-space indentation, double quotes, semicolons, and trailing commas in multiline constructs. Follow existing patterns: `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for environment-backed constants, and kebab-case filenames such as `target-policy.js`. Keep changes narrow, favor small helpers, and preserve explicit validation and useful error messages. Run `npm run check` before submitting; no separate formatter or linter is configured.

## Testing Guidelines

Write `test/*.test.js` suites with `node:test` and `node:assert/strict`. Name tests by observable behavior, and add regression coverage for payment validation, SSRF protections, settlement idempotency, and failure handling when those paths change. Keep unit tests deterministic; gate database-dependent cases behind `TEST_ORDER_DATABASE_URL`. No numeric coverage threshold is enforced.

## Commit & Pull Request Guidelines

History follows Conventional Commits: `feat(review): ...`, `fix(settlement): ...`, and `docs(review): ...`. Use an imperative, concise subject and a focused scope. Pull requests should explain behavior and operational impact, link the relevant issue, list `npm run check` and `npm test` results, and call out migrations or new environment variables. Include screenshots for changes under `public/`.

## Security & Configuration

Never commit private keys, seed phrases, API keys, bearer tokens, payment authorizations, or production database URLs. Preserve public-HTTPS and private-network blocking for review and callback targets. Update `.env.example` whenever adding safe configuration names, with secrets left blank.
