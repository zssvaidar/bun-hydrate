# bun-hydrate Spec 2 — Gap Analysis & Detailed Design

**Document:** `spec-2`
**Status:** Draft
**Reviews:** `user-process-landscape` (UPL), `spec-1`
**Purpose:** Identify what's missing or underspecified in UPL/spec-1, reconcile them with each other and with the actual state of this repository, and turn the gaps into a concrete design that can be built against without re-litigating decisions mid-implementation.

---

## 0. How to read this document

Part 1 is the audit: what's missing, where the two source docs disagree with each other, and where they disagree with the code that already exists in this repo. Part 2 is the design: concrete decisions that close those gaps, written in the same FR-style as `spec-1` so it can be merged into the roadmap directly. Part 3 is the small set of decisions that genuinely need your input rather than an engineering default. Part 4 restates the roadmap with the gaps slotted in.

---

## Part 1 — Gap Analysis

### 1.1 Reality check: the repo vs. the vision

`spec-1` and UPL describe a multi-package framework (`@bun-hydrate/core`, `/http`, `/database`, `/auth`, `/react`, `/cli`, ...) with a CLI (`bun hydrate ...`), generators, and a documented developer lifecycle. The repository as it stands today is a single flat package:

| Spec says | Repo has |
|---|---|
| `name: "bun-hydrate"`, `packages/*` monorepo (spec-1 §3) | `package.json` name is `"bun-ter"` (`package.json:2`), no `packages/` workspace at all |
| `bun hydrate dev/build/test/db:migrate/...` CLI (spec-1 §24, UPL §3.1) | No CLI exists; scripts are plain `bun --watch index.tsx` / `bun run scripts/build.ts` (`package.json:5-7`) |
| `src/modules/<name>/{controller,service,repository,schema,routes}` convention (spec-1 §11, §27) | `src/core/{controller,routes,serverMain}.tsx` — a single hand-written prototype, no module generator, no modules yet |
| Typed config with `defineConfig`/`env.*` validated at startup (FR-030/031) | `.env.example` has three untyped keys (`host`, `port`, `protocol`) that aren't even the ones the code reads — `controller.tsx:7-8` reads `PORT`/`HOST` (uppercase), `.env.example:1-3` defines lowercase `host`/`port`/`protocol`. This exact class of bug was already hit and fixed once (commit `fb61ab7`, "Fix case-sensitive env var bug"), which is a strong signal that FR-030's "typed config validated at startup" isn't a nice-to-have here — it's preventing a bug that has already shipped. |
| `/health`, `/ready`, `/metrics` (FR-160/161/162) | Only `/health` exists (`controller.tsx:22-33`); no readiness or metrics endpoint |
| Routes as declarative module data, single source of truth | Routes are defined **twice** and inconsistently: `routes.tsx` (used nowhere) and `serverMain.tsx:37-50` (actually used), each with a different `Home`/`PageHomeOne` element. `controller.tsx:64-67` additionally hand-rolls a third, regex-based route for `/page/:id` that bypasses both route tables entirely. |
| "Small core," no mandatory infra deps (§2.5) | `lodash` is a direct dependency (`package.json:19`) with no import of it anywhere in `src/` — dead weight against the framework's own stated principle |
| Deployment neutrality, "SHOULD NOT require a specific cloud provider" (FR-211) | A fully built, opinionated, single-target deployment pipeline already exists: Jenkins → HashiCorp Vault (AppRole) → AWS S3 artifact upload → SSM `RunShellScript` fan-out → a systemd unit (`node-app.service`) running from a `releases/<version>` + `current` symlink layout baked onto an AMI, with its own health-check-gated rollback (`deploy.sh:54-70`). None of this is mentioned in either source doc. |

**Takeaway:** the two documents describe the destination well. Neither describes the starting point, and the starting point already has real operational commitments (a live deploy pipeline, a naming mismatch, a config bug class) that the design needs to account for, not just the greenfield feature list.

### 1.2 Contradictions between UPL and spec-1

1. **DB command set differs.** UPL §10: `db:migration create <name>`, `db:migrate`, `db:rollback`, `db:status`. spec-1 FR-192: `db:migrate`, `db:rollback`, `db:seed`. Neither list is a superset of the other (`db:migration create` vs. implicit "create migration"; `db:status` vs. `db:seed` — both are needed, but only one doc mentions each).
2. **Binary name is unsettled.** spec-1 FR-190 offers `hydrate` **or** `bun hydrate` as alternatives. UPL uses `bun hydrate` exclusively throughout. Two names for the same binary will fragment docs, error messages, and muscle memory from day one.
3. **`services` is a first-class command in UPL but absent from spec-1's CLI FR.** UPL §11 introduces `bun hydrate services up` for local Postgres/Redis; spec-1 FR-190's core command list (`create, dev, build, start, test, worker`) and FR-192 (db commands) never mention it, and UPL's own §21 discoverability example lists `services` as a top-level `--help` entry that spec-1 doesn't back with a requirement.
4. **UPL §13 implies HTTP-level test helpers wrap "a production server," spec-1 FR-200 doesn't specify whether that's an in-process fetch (no socket) or a real bound port.** This matters for parallel test execution and CI speed and should be pinned down (see §2.9).

### 1.3 Missing from both documents

**Security**
- No CSRF protection requirement anywhere, despite SSR forms being an explicit use case (UPL §9, spec-1 §17).
- No security-headers requirement (CSP, `X-Content-Type-Options`, `Referrer-Policy`, HSTS) — a `helmet()`-equivalent.
- No CORS requirement, despite the framework explicitly targeting standalone API use (spec-1 §1, "API" project type in UPL §4).
- No cookie-flag requirements (`Secure`, `HttpOnly`, `SameSite`) or session-fixation guidance under FR-070 Authentication.
- No password-hashing requirement (bcrypt/argon2/scrypt) under Authentication.
- **No hydration-payload XSS requirement.** FR-121 says the framework "SHALL provide a browser hydration pipeline" but never states how server-computed state gets serialized into the HTML document. This is the single most common React-SSR vulnerability class (unescaped `</script>` breakout via `JSON.stringify` embedded in a `<script>` tag) and needs to be a hard requirement, not an implementation detail.
- No secrets-management story beyond flat `.env` files, despite the real deploy pipeline already using Vault + AWS SSM for credentials — FR-030 should at least acknowledge a pluggable secrets source.
- No trusted-proxy / `X-Forwarded-For` policy for rate limiting (FR-170) or request IDs, despite the real deployment sitting behind a load balancer and (per `cloud-init-cloudflared.sh`) a Cloudflare tunnel.

**API & data contracts**
- No API versioning strategy (URI vs. header) even though "stable public APIs" is a v1.0 requirement (§28).
- No pagination convention (cursor vs. offset), despite `pagination.ts` being named explicitly as a shared-type example (spec-1 §18, UPL §9).
- No file-upload/multipart-parsing requirement connecting an incoming `Request` to the Storage abstraction (FR-180) — only the storage `.put()` call is specified, not how a browser upload becomes a `File`.
- No OpenAPI/Swagger generation FR, even though UPL §12 explicitly promises the validation schema will produce "API documentation metadata" — that promise is never turned into a requirement in spec-1.
- No client-side data-fetching story after hydration — FR-131 covers backend schema → types → frontend client, but not what actually issues the `fetch` (a generated typed client? a bare `fetch` wrapper? React Query/SWR integration?).

**Scaling & ops**
- No multi-process/scaling model. `Bun.serve()` is a single process; nothing says whether horizontal scale on one host is "run N systemd instances behind a local reverse proxy," Bun's `reusePort`, or purely "someone else's job." This directly affects the WebSocket design (FR-110, pub/sub across processes) and the queue/worker design (FR-090/091).
- No distributed tracing requirement — FR-160-162 cover health/readiness/metrics but never traces, despite the reference architecture (spec-1 §30) chaining HTTP → service → DB → event → job across processes, which is exactly where a request ID alone stops being enough to debug (UPL §14 promises a "traceable developer workflow" but the events/jobs legs of that trace are unaddressed).
- No graceful-shutdown interaction with WebSockets or in-flight queue jobs — FR-003 only discusses HTTP requests.
- No environment-parity story (staging, preview/PR environments) — Configure (UPL §5) only mentions `.env`, `.env.local`, `.env.production`.

**Process / lifecycle**
- No CI gate step in the lifecycle at all — UPL's loop goes Test → Debug → Build → Deploy with no "and a CI pipeline runs lint/typecheck/tests/security-scan before any of this is allowed to deploy," despite Jenkins already existing in this repo.
- No rollback story at the *framework* level — the real `deploy.sh` already implements symlink-swap rollback on failed health check, but nothing in UPL's Deploy/Observe sections tells a developer how to trigger or reason about a rollback.
- No dependency-update process (audit/renovate/dependabot cadence).
- No onboarding/first-run checklist for a second developer joining an existing project (clone → install → services up → seed → dev, with concrete commands).
- No frontend generator. UPL §7 generates `controller/service/repository/middleware/module`, all backend; §9 describes full-stack feature development with pages/components/forms but never gives it a `generate page`/`generate component` command.
- No accessibility, i18n, or localization mentioned anywhere (not even as an explicit non-goal — §29 of spec-1 lists nine non-goals and i18n isn't one of them, so it currently reads as silently out of scope rather than a decision).
- No test-coverage/quality-gate thresholds tied to the Build step.
- No telemetry/analytics disclosure for the CLI itself (does `bun hydrate` phone home usage data — many modern CLIs do this by default and it should be an explicit yes/no, not silence).
- No framework-package versioning/deprecation policy beyond the v0.1→v1.0 feature roadmap — nothing about semver discipline or breaking-change policy *after* 1.0, which §28 implies is the point of reaching 1.0 at all ("stable public APIs").
- No monorepo build/release tooling decision for the `packages/*` layout in spec-1 §3 (Bun workspaces alone vs. Turborepo/Nx for task graph, Changesets for independent package versioning/publishing).

### 1.4 Summary table

| Category | Missing item | In UPL? | In spec-1? |
|---|---|---|---|
| Security | CSRF, CORS, security headers, cookie flags, password hashing, hydration XSS | No | No |
| Security | Secrets management beyond `.env` | No | No |
| API | Versioning, pagination convention, OpenAPI generation, upload parsing | Partial (mentions docs) | No |
| Scaling | Multi-process model, distributed tracing | No | No |
| Process | CI gate, rollback UX, dependency updates, onboarding, frontend generator | No | No |
| Governance | i18n/a11y decision, telemetry disclosure, post-1.0 semver policy, monorepo tooling | No | No |
| Repo reality | Package rename, config key casing/validation, dead `lodash` dep, duplicated route tables, single deploy target undocumented | N/A | N/A |

---

## Part 2 — Detailed Design (closing the gaps)

Numbered to continue spec-1's `FR-2xx` block cleanly.

### 2.1 Repository migration (do this before anything else)

- **MG-001**: Rename the package from `bun-ter` to `bun-hydrate` in `package.json`, and decide now whether v0.1 ships as this single flat package or is restructured into the `packages/*` layout immediately. Recommendation: **stay flat through v0.1–v0.2** (kernel + backend foundation), and only split into `packages/*` at the start of v0.3, once there are enough independently-versionable units (auth, cache, queue) to justify workspace overhead. Splitting on day one with one consumer (the kernel itself) buys nothing yet.
- **MG-002**: Collapse `routes.tsx` and the route array inside `serverMain.tsx` into one source of truth. The `/page/:id` regex branch in `controller.tsx:64-67` must become a real route in that same table, not a third parallel mechanism — this is exactly the "routes SHALL support parameters" requirement (FR-010) already half-implemented ad hoc.
- **MG-003**: Fix the config casing bug class at the root, not the symptom. `.env.example` must declare the exact keys the typed config schema (FR-031) validates (`PORT`, `HOST` or whatever the canonical casing becomes), and `env.*` validation must fail startup on an unset required key — this turns "fixed twice already" into "cannot regress."
- **MG-004**: Drop the unused `lodash` dependency, or replace one real call site with it and document why — per the framework's own §2.5 "small core" principle, an unused infra dependency in the reference project undermines the pitch.

### 2.2 Security baseline (FR-220 series)

- **FR-220 Security headers.** The framework SHALL ship a default security-headers middleware (CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS when served over HTTPS) enabled by default, overridable via config.
- **FR-221 CORS.** The framework SHALL provide `cors()` middleware with an explicit allow-list config; wildcard origins SHALL NOT be the default when credentials are enabled.
- **FR-222 CSRF.** For session-authenticated, cookie-based requests, the framework SHALL provide double-submit-cookie or synchronizer-token CSRF protection, opt-out for pure token/API-key APIs (which are not vulnerable to CSRF in the same way).
- **FR-223 Cookie flags.** Session cookies SHALL default to `HttpOnly`, `Secure` (in production), and `SameSite=Lax` (or `Strict` where configured).
- **FR-224 Password hashing.** The auth module SHALL use argon2id (fallback bcrypt) with no framework API that accepts or stores a plaintext/reversibly-encrypted password.
- **FR-225 Hydration payload safety.** Server state serialized into the initial HTML document for hydration SHALL be escaped against `</script>` and Unicode line-separator breakout (e.g. via a serializer like `devalue` or an equivalent escape routine), never raw `JSON.stringify` interpolation into a template string.
- **FR-226 Trusted proxy config.** Rate limiting (FR-170) and request-ID/IP-derived logic SHALL read client IP from a configurable trusted-proxy chain (`X-Forwarded-For`), not the raw socket address, with an explicit list of trusted hop count/CIDRs — untrusted by default.
- **FR-227 Secrets source abstraction.** Typed configuration (FR-031) SHALL support pluggable secret sources behind the same `env.*` API — flat `.env` for local dev, and an adapter interface that the existing Vault/SSM-based deploy pipeline can implement without the app code changing.

### 2.3 API contract conventions (FR-230 series)

- **FR-230 API versioning.** Default convention: URI-prefixed (`/api/v1/...`); the router SHALL support mounting multiple versions concurrently.
- **FR-231 Pagination.** The framework SHALL ship a standard cursor-based pagination helper (`schema.paginated(ItemSchema)` → `{ items, nextCursor }`) as the default `pagination.ts` shared type UPL/spec-1 already assume exists; offset pagination remains available but is not the default.
- **FR-232 File uploads.** `ctx.formData()` (FR-012) SHALL expose parsed `File`/`Blob` parts that can be passed directly to `storage.put()` (FR-180) with size/MIME-type limits configurable per-route.
- **FR-233 OpenAPI generation.** Validation schemas (FR-050) SHALL be introspectable to generate an OpenAPI 3.x document at `/openapi.json`, fulfilling the "API documentation metadata" promise in UPL §12 that spec-1 never implemented.
- **FR-234 Typed client fetch.** The framework SHALL provide a thin typed `fetch` wrapper generated from route schemas (request/response types inferred, not regenerated by a codegen step) for use in `src/web`; it SHALL be usable directly or wrapped by React Query/SWR — the framework does not mandate either.

### 2.4 Scaling & tracing (FR-240 series)

- **FR-240 Process model.** v0.1–v0.3 target **one Bun process per container/instance**; horizontal scale is achieved by running multiple instances behind an external load balancer (matches the existing AWS deployment's ability to target multiple EC2 instances via SSM resource groups). In-process clustering (`reusePort`) is an explicit non-goal until a documented need arises.
- **FR-241 WebSocket fan-out.** Because of FR-240, `ws.publish()` (FR-110) is process-local by default; a Redis pub/sub adapter (mirroring the Cache/Queue adapter pattern) is required before WebSockets are used across more than one instance — call this out explicitly rather than let it be discovered in production.
- **FR-242 Distributed tracing.** The framework SHOULD support OpenTelemetry trace propagation: the request ID (FR-150) becomes (or maps to) a W3C `traceparent`, and job dispatch (FR-090) / event emission (FR-100) propagate the same trace context, so the "HTTP → service → DB → event → job" chain in spec-1 §30 is debuggable end-to-end, not just at the HTTP layer.
- **FR-243 Shutdown scope.** Graceful shutdown (FR-003) SHALL also: stop accepting new WebSocket upgrades, allow in-flight queue jobs to finish (or requeue) within the same timeout window, and close DB/cache connections last.

### 2.5 Process & governance additions

- **PR-001 CI gate.** Insert a mandatory stage between Test and Build in the lifecycle (UPL §2, §18): lint → typecheck → unit/integration tests → dependency audit, all required green before `bun hydrate build` runs in CI. The existing Jenkinsfile only builds and deploys today — a `Test`/`Verify` stage should be added ahead of `Build`.
- **PR-002 Rollback UX.** Document (and eventually wrap in the CLI) the rollback semantics the real `deploy.sh` already implements: failed post-deploy health check auto-reverts the `current` symlink to the previous release and restarts the service; a developer-facing `bun hydrate deploy:rollback` command is a reasonable v0.6+ CLI target that calls the same mechanism rather than reinventing it.
- **PR-003 Frontend generator.** Add `bun hydrate generate page <Name>` / `generate component <Name>` to the generator set (spec-1 FR-191, UPL §7), producing `src/web/pages/<Name>/index.tsx` + a colocated test, matching the backend generators' pattern.
- **PR-004 Onboarding checklist.** Document the second-developer flow explicitly: `git clone` → `bun install` → `bun hydrate services up` → `bun hydrate db:migrate` → `bun hydrate db:seed` → `bun hydrate dev`. This is implied across UPL §3–§11 but never written as one sequence.
- **PR-005 i18n/a11y decision.** Add both to spec-1 §29 Non-goals explicitly for v0.1–v1.0 (generated component templates use semantic HTML and accessible form patterns by default, but a full i18n framework is out of scope) — turns silence into a stated, revisitable decision.
- **PR-006 Telemetry disclosure.** The CLI SHALL NOT collect or transmit usage analytics without explicit opt-in, stated in the CLI's own `--help` output and README.
- **PR-007 Monorepo tooling.** When the `packages/*` split happens (see MG-001), use Bun workspaces for linking + Changesets for independent versioning/publishing of `@bun-hydrate/*` packages; do not adopt Nx/Turborepo unless build-graph caching becomes an actual bottleneck.
- **PR-008 Post-1.0 stability policy.** Public APIs follow semver; a breaking change requires a deprecation warning for at least one minor version before removal, documented in a `CHANGELOG.md` per package.

### 2.6 CLI/command reconciliation

Canonical decision, replacing the conflicting lists in §1.2:

- **Single binary name: `bun hydrate`** (not a bare `hydrate`) — this matches how Bun itself expects tool invocation (`bun <script/tool>`) and is what UPL uses throughout; spec-1 FR-190 should drop the bare-`hydrate` alternative.
- **Canonical DB commands** (merging both lists): `db:migration create <name>`, `db:migrate`, `db:rollback`, `db:seed`, `db:status`.
- **`services` is a first-class top-level command**, added to spec-1 FR-190's core command list alongside `create/dev/generate/test/build/start/db/worker`, with `services up` / `services down` / `services ps` (the last two currently missing even from UPL, which only shows `up`).
- **HTTP test helper (spec-1 FR-200) binds no real socket** — it drives the app's fetch handler in-process (matches `Bun.serve`'s underlying `fetch` contract), so `testApp.post(...)` in UPL §13's example never needs a production server, an actual bound port, or port-conflict handling in parallel test runs.

---

## Part 3 — Decisions that need your input

These aren't engineering defaults — they're calls only you can make:

1. **Is the existing Jenkins/Vault/AWS SSM pipeline the long-term canonical deploy target**, or a stopgap that the framework's `hydrate build`/`deploy` story should eventually replace/abstract? This changes whether PR-002's rollback command wraps *that* pipeline specifically or a generic adapter interface.
2. **Flat package now vs. `packages/*` monorepo immediately** (MG-001) — I recommended staying flat through v0.2, but if you already have multiple consumers/teams planned, splitting earlier may be worth the workspace overhead sooner.
3. **Scope of the rename** — renaming `bun-ter` → `bun-hydrate` in `package.json` is uncontroversial, but do you want the git history / repo name itself addressed too (it's already `bun-hydrate` at the remote level, just not in the manifest)?

---

## Part 4 — Revised roadmap (gaps slotted into spec-1 §28)

- **Before v0.1 starts:** MG-001…MG-004 (rename, single route source, config-casing fix, drop dead dependency).
- **v0.1 — Application Kernel:** add FR-225 (hydration payload safety) — it's a kernel-level concern (SSR + template string) not a later add-on.
- **v0.2 — Backend Foundation:** add FR-230/231/232 (API versioning, pagination, uploads) alongside validation/DI/DB, since they're foundational contract shapes, not later polish.
- **v0.3 — Production Backend:** add FR-220-224/226/227 (security headers, CORS, CSRF, cookie flags, password hashing, trusted proxy, secrets abstraction) and FR-242 (tracing) — this version already targets auth/logging/metrics/rate-limiting, so the security baseline belongs in the same milestone, not bolted on after.
- **v0.4 — Distributed Systems:** add FR-240/241/243 (process model, WS fan-out adapter, shutdown scope) — directly relevant once jobs/queues/workers exist.
- **v0.5 — Full-stack:** add FR-233/234 (OpenAPI generation, typed client fetch).
- **v0.6 — Developer Experience:** add PR-003/004 (frontend generator, onboarding checklist), CLI reconciliation from §2.6.
- **v1.0 — Stable Framework:** add PR-001/006/007/008 (CI gate, telemetry disclosure, monorepo/release tooling, post-1.0 semver policy) as explicit exit criteria alongside the existing stability/documentation/examples requirements.
