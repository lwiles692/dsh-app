# dsh-app

Wraps [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) as a multi-client app: a Fastify gateway (auth, reverse proxy, WebSocket passthrough) plus a Tauri 2 client, fronting a loopback-only dsh Host for browser, desktop, and mobile access.

## Essentials

- Package manager is **pnpm** — never npm or yarn. `gateway/` and `app/` are two independent pnpm projects; there is no root workspace.
- No test/lint/typecheck suite exists. Upstream protocol regressions are covered by `scripts/verify-upstream.sh` — mandatory after any change to the upstream pin in `vendor/`.
- `vendor/deepseek-harness/` is a shallow clone pinned to a verified commit, for reading/debugging only — never edited, never part of the build.

## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.

## Guides

- [Issue tracker](docs/agents/issue-tracker.md) — issues and specs as markdown under `.scratch/`, one directory per feature
- [Triage labels](docs/agents/triage-labels.md) — five-role status vocabulary, label string equals role name
- [Domain docs](docs/agents/domain.md) — consuming `CONTEXT.md` + `docs/adr/` (created lazily; proceed silently if absent)
