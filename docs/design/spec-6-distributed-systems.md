# bun-hydrate Spec 6: Distributed Systems Detailed Design (v0.4)

**Document:** `spec-6`
**Status:** Accepted. Decisions D1–D12 (§17) taken as recommended.
**Builds on:**
- `spec-1` §14 (FR-090 jobs, FR-091 workers), §15 (FR-100 events), §23 (FR-180 storage) and §28 (v0.4: jobs, workers, events, Redis, queue adapters, storage adapters).
- `spec-2` FR-232 (uploads, left over from v0.2), FR-240 (process model), FR-241 (WebSocket fan-out), FR-242 (trace propagation into jobs and events) and FR-243 (shutdown scope).
- `spec-5` §16 "As built" (v0.3).

**Out of scope:**
- `Jenkinsfile` and `deploy.sh` (unchanged; see §12.4 for what a deploy of the worker needs).
- Kafka, and SQS as a built adapter (both get an adapter contract instead: D2).
- Email sending as a framework package.
- Typed API client and OpenAPI (v0.5).

---

## 0. Summary

v0.3 made one process production-ready. v0.4 makes the app work as **several processes**: web instances behind a load balancer, plus worker processes. Work moves between them durably, and so do messages.

| Area | Package | What ships |
|---|---|---|
| Redis | `@bun-hydrate/redis` (new) | One connection manager per process: shared prefix, readiness check, correct shutdown (§2). Used by cache, rate limit, queue, events and fan-out. |
| Jobs and workers | `@bun-hydrate/queue` (new; the name from spec-1 §3) | `defineJob` / `dispatch` / `createWorker`: retries with backoff, delays, idempotency keys, timeouts with leases, dead jobs, recurring (cron) schedules. Adapters: memory, database (default, transactional), Redis (§3–§5). |
| Events | `@bun-hydrate/events` (new) | Typed `defineEvent` / `emit` / `on`. In-process listeners run after commit. Durable listeners run as jobs, which gives the outbox guarantee without an outbox table (§6). |
| Storage and uploads | `@bun-hydrate/storage` (new), `@bun-hydrate/core` | A `Storage` interface with memory, local-filesystem and S3-compatible adapters (on `Bun.S3Client`). Signed URLs. `ctx.upload()` with size limits and content sniffing (§7–§8). |
| WebSocket fan-out | `@bun-hydrate/core`, `@bun-hydrate/redis` | `app.publish()` goes through a `PubSub` adapter; the Redis adapter delivers to every instance (§9). |
| Process model and shutdown | `@bun-hydrate/core`, `@bun-hydrate/cli` | Separate web and worker roles from one artifact. `hydrate worker`. Ordered shutdown: HTTP, then jobs, then subscriptions, then connections (§10–§11). |
| Tracing and metrics | `@bun-hydrate/core`, `@bun-hydrate/observability` | `traceparent` travels through jobs and events. Metrics for queue latency, job duration and outcome, queue depth, events and fan-out (§13). |
| Orchestration | `@bun-hydrate/cli` | New features `redis`, `jobs:database` / `jobs:redis`, `events`, `storage:local` / `storage:s3`, `realtime:redis`. Generators for jobs, events and listeners. `jobs:*` commands (§14). |

**Guarantees in one paragraph.** Jobs and durable listeners are delivered **at least once**:
- A job that was dispatched inside a database transaction exists only if the transaction commits.
- A job whose worker dies is retried after its lease expires.
- A job that keeps failing ends up **dead**: it is kept, inspectable and retryable, never silently dropped.
- Handlers must therefore be idempotent. The framework helps with idempotency keys and `job.attempt`.

Delivery to in-process listeners and WebSocket fan-out is **at most once**: fast, and lost if the process dies at the wrong moment. The docs say which API gives which guarantee, next to each API.

---

## 1. Design principles for v0.4

1. **No new infrastructure by default.** An app with only a database gets durable jobs, events and schedules (D1). Redis adds throughput and cross-instance fan-out; it is never required.
2. **One adapter contract per concept, tested once.** Every queue adapter passes the same exported contract suite (`queueContract()`), and so does every storage adapter (`storageContract()`). That suite is also the extension point for SQS, GCS or anything else (D2).
3. **The transaction is the unit of truth.** Dispatching a job or emitting an event inside `db.transaction()` either happens with the commit, or not at all.
4. **Failures are visible.** Every job ends in a state someone can see: `completed`, retried, or `dead` (with its last error). Every dropped at-most-once message is counted in a metric.
5. **Same ergonomics as v0.3.** Definitions are plain objects checked by `tsc`. Payloads are validated with Standard Schema. Clocks are injectable. Everything can be wired with `hydrate add`.

---

## 2. Redis connection management (`@bun-hydrate/redis`)

In v0.3, the cache and the rate limit each opened their own `RedisClient` from a URL. v0.4 adds three more users: the queue, events and fan-out. Two facts found while writing this spec make a shared manager necessary:
- **Bun 1.3.11 keeps the process alive after `close()` on a client that is still subscribed.** Probed: it hangs with exit 124 under `timeout 5`; after `unsubscribe()`, `close()` exits cleanly. Every subscriber must unsubscribe before closing, or graceful shutdown never completes.
- **A subscribed connection cannot run other commands** (Redis protocol), so pub/sub needs its own connection.

```ts
import { createRedis } from "@bun-hydrate/redis";

const redis = createRedis({ url: config.redisUrl, prefix: "myapp:" }); // lazy: connects on first use
redis.client;                    // commands (GET/SET/EVAL/…), one per process
redis.key("jobs", "ready");      // "myapp:jobs:ready", so several apps can share one Redis
await redis.subscribe("ws:*", (channel, message) => { … });   // the dedicated subscriber connection
app.readinessCheck("redis", () => redis.ping());
app.onStop(() => redis.close()); // unsubscribes everything first, then closes both connections
```

- `subscribe` supports patterns and returns an `unsubscribe` function. The subscriber connection is opened only when it is first needed.
- `close()` is idempotent. It unsubscribes all channels, then closes the subscriber, then the command client. A test asserts that a process which subscribed exits within 1 s after `close()`.
- `RedisCache`, `RedisRateLimitStore`, the Redis queue, the Redis event transport and the Redis pub/sub accept `{ redis }` in addition to their current `url`/`client` options, so nothing breaks.
- Key prefix: `REDIS_PREFIX` (default: `package.json` name + `:`).

---

## 3. Jobs (`@bun-hydrate/queue`, FR-090)

### 3.1 Defining and dispatching

```ts
// src/jobs/send-welcome-email.job.ts
import { defineJob } from "@bun-hydrate/queue";
import { schema } from "@bun-hydrate/validation";

export const sendWelcomeEmail = defineJob({
  name: "send-welcome-email",                   // stable identifier stored with the job
  payload: schema.object({ accountId: schema.uuid() }),
  queue: "default",                             // optional; workers choose which queues they serve
  retry: { attempts: 5, backoff: "exponential" }, // default: 3 attempts, exponential from 10s
  timeout: "2m",                                // default: 5m; see leases (§3.3)
  inject: [AccountRepository, Mailer] as const, // resolved from the container per run (same rule as classes)
  async handle({ accountId }, { job, services: [accounts, mailer] }) {
    const account = await accounts.findById(accountId);
    if (!account) return;                       // nothing to do is success
    await mailer.send({ to: account.email, template: "welcome", idempotencyKey: job.id });
  },
});
```

```ts
// anywhere with the container: a service, a route, a listener
await jobs.dispatch(sendWelcomeEmail, { accountId }, { delay: "5m", idempotencyKey: `welcome:${accountId}` });
```

- **Typed by definition object.** `dispatch(def, payload)` infers the payload type from the schema. A string name is only used for storage and logs.
- **Validated twice.** The payload is validated at dispatch, so bad input fails at the caller. It is validated again when the job runs, so a job enqueued by older code fails clearly as `INVALID_PAYLOAD` (a dead job, no retries) instead of crashing inside the handler.
- **JSON only.** Payloads must survive `JSON.stringify`; `Date` becomes a string. The docs recommend passing IDs rather than whole records, because the data may change before the job runs.
- **Options:**
  - `delay` (a duration) or `runAt` (a `Date`).
  - `idempotencyKey`: at most one job with this key exists while it is pending, active or retained (§3.4). A second dispatch returns the existing job's id and does nothing.
  - `priority` (0–9, higher first): best effort within a queue.
- `dispatch` returns `{ id, deduplicated: boolean }`.

### 3.2 Job states

```text
             dispatch                claim (lease)             handler resolves
  ──────────▶ pending ─────────────────▶ active ────────────────────▶ completed ──▶ (deleted after retention)
                ▲  ▲                        │ │
    retry with  │  │ lease expired          │ │ handler throws, attempts left
    backoff ────┘  └──────(worker died)─────┘ │
                                              │ throws NonRetryableError, attempts exhausted,
                                              ▼ or payload invalid
                                            dead ──▶ hydrate jobs:retry <id> → pending
```

- **`attempt`** counts claims. A lease that expires (the worker crashed) counts as an attempt: a job that crashes its worker every time must end up dead, not loop forever.
- **A graceful shutdown that stops a job early does not count as an attempt** (§11). The job goes back to `pending` at once.
- **`NonRetryableError`** (exported) skips the remaining attempts. Use it for bad input and business rejections.
- **Backoff:** `exponential` (default: base 10 s, factor 2, ±20% jitter, capped at 1 h), `fixed` (a duration), or a function of `attempt`.

### 3.3 Leases, timeouts and cancellation

- **Leases.** A claim sets `lockedUntil = now + timeout + 30s` and `lockedBy = workerId`. While the handler runs, the worker renews the lease every `timeout / 3`, so long jobs are safe and dead workers are detected within one lease.
- **Timeouts.** A handler that exceeds `timeout` is aborted through `job.signal` (an `AbortSignal` passed to `fetch`, `Bun.sleep`, queries and so on). The attempt then fails with `JOB_TIMEOUT` and is retried.
- **Cancellation cannot be forced.** JavaScript can't kill a running promise. A handler that ignores `job.signal` keeps running after the timeout, but its result is discarded once its lease is gone. The docs state this plainly and recommend passing `job.signal` everywhere.

### 3.4 Retention and dead jobs

- **Completed jobs:**
  - Without an idempotency key, they are deleted at once (by default).
  - With a key, they are kept for `idempotencyWindow` (default 24 h), so re-dispatching within the window is still deduplicated.
- **Dead jobs** are kept for `deadRetention` (default 14 d), with `lastError` (message, code, stack trimmed to 4 KiB). `hydrate jobs:dead` lists them; `hydrate jobs:retry` re-queues them.
- **Maintenance.** Purging and requeueing expired leases run inside the worker every minute. Only one worker at a time does it: a maintenance lease row (database) or `SET NX PX` (Redis).

### 3.5 Recurring jobs (cron)

```ts
// src/worker.ts
worker.schedule(cleanupExpiredSessions, "17 * * * *");   // every hour at :17, UTC
worker.schedule(sendDigest, "0 8 * * 1-5", { timezone: "Europe/Berlin", payload: {} });
```

- **Cron parser.** An in-house 5-field parser (about 150 lines, tested against a table of expressions) supporting `*`, lists, ranges, steps and `@hourly`/`@daily`/`@weekly`. Seconds-level schedules are refused: that is a loop, not a schedule.
- **Exactly one job per time slot across all workers.** Every worker that runs the schedule dispatches the job for a slot with `idempotencyKey = "cron:<job>:<slot ISO time>"`. Deduplication makes it happen once, with no leader election.
- **Missed slots.** If no worker was running during a slot, it is skipped, and the next one runs. Catch-up is a documented non-feature: a digest for 03:00 sent at 09:00 is usually worse than none.

---

## 4. Workers (FR-091)

```ts
// src/worker.ts (scaffolded by `hydrate add jobs:*`; yours to edit)
import { createWorker } from "@bun-hydrate/queue";
import { jobs, allJobs } from "./jobs";               // generated registry (§14.2)
import { createContainer } from "./container";

const worker = createWorker({
  queue: jobs,                  // same adapter as the web process
  handlers: allJobs,            // definitions this worker runs
  container: createContainer(), // services for `inject`
  queues: ["default", "mail"],  // default: every queue that `handlers` use
  concurrency: 10,              // jobs in flight in this process
  health: { port: config.workerPort }, // optional /health, /ready and /metrics for orchestrators
});

worker.schedule(cleanupExpiredSessions, "17 * * * *");
await worker.start();           // SIGTERM/SIGINT → graceful stop (§11)
```

- **Runs with `hydrate worker`** (development: watches and restarts like `hydrate dev`). In production it runs `bun dist/worker.js`.
- **`hydrate build` bundles `src/worker.ts`** into `dist/worker.js` when the file exists. It is the same self-contained artifact rule as `dist/index.js`, and both files share `migrations/`.
- **Per-job context.** Each run gets a logger bound to `jobId`, `job` (the name), `attempt` and `traceId`, plus a container scope that is disposed after the run (the same per-request scoping as HTTP).
- **Concurrency.** Claims are batched up to the free slots. The next claim waits until a slot is free, so a slow job never causes over-fetching.
- **Workers claim only job names they have handlers for.** During a rolling deploy, a job dispatched by new code waits for a new worker instead of failing on an old one. A job that no running worker can handle stays `pending`. `hydrate jobs:status` lists such names with the age of their oldest job, so a forgotten handler is visible, not silent.
- **Embedded mode (D4).** `startWorkerIn(app, options)` runs the same worker inside the web process, started and stopped by the app's lifecycle. It is meant for single-instance deployments and for the memory adapter in development.

---

## 5. Queue adapters

### 5.1 Contract

```ts
interface QueueAdapter {
  enqueue(jobs: NewJob[]): Promise<EnqueueResult[]>;               // honors idempotency keys
  claim(queues: string[], names: string[], limit: number, lease: Lease): Promise<ClaimedJob[]>; // only jobs this worker can run
  renew(ids: string[], lease: Lease): Promise<string[]>;           // returns the ids still held
  complete(id: string, result: Completion): Promise<void>;          // completed | retry(at) | dead(error) | release
  requeueExpired(now: number): Promise<number>;
  counts(queues?: string[]): Promise<Record<string, Record<JobState, number>>>;
  list(filter: JobFilter): Promise<Page<JobRecord>>;                // for jobs:dead and the CLI
  retry(ids: string[]): Promise<number>;
  purge(filter: PurgeFilter): Promise<number>;
  close(): Promise<void>;
}
```

`queueContract(makeAdapter, { clock })` is exported from `@bun-hydrate/testing/queue`. Every adapter must pass it:
- ordering and priority;
- delays;
- deduplication while pending, active and retained;
- two concurrent claimers never getting the same job (200 jobs, 8 claimers, no duplicates, none lost);
- lease expiry and renewal;
- retry and dead transitions;
- purge;
- close.

### 5.2 Memory (tests and development)

The memory adapter keeps everything in one process with an injectable clock. `createTestQueue()` wraps it with test helpers:

```ts
const queue = createTestQueue();
await registerAccount(...);
expect(queue.dispatched(sendWelcomeEmail)).toEqual([{ accountId: expect.any(String) }]);
await queue.runAll({ handlers: [sendWelcomeEmail], container });   // runs due jobs to completion, deterministically
```

`hydrate worker` refuses to start with the memory adapter, since a separate process could never see its jobs. It says to use embedded mode instead.

### 5.3 Database (default: D1)

A `hydrate_jobs` table is created by the `jobs:database` feature migration:

```sql
create table if not exists hydrate_jobs (
  id varchar(36) primary key,            -- UUIDv7: time-ordered
  queue varchar(64) not null,
  name varchar(200) not null,
  payload text not null,                 -- JSON
  state varchar(16) not null,            -- pending | active | completed | dead
  priority smallint not null default 0,
  attempt integer not null default 0,
  max_attempts integer not null,
  run_at bigint not null,                -- epoch ms: when it may next run
  locked_until bigint,
  locked_by varchar(64),
  idempotency_key varchar(255) unique,   -- NULLs don't collide (SQLite, Postgres, MySQL)
  trace_parent varchar(55),
  last_error text,
  created_at bigint not null,
  finished_at bigint
);
create index if not exists hydrate_jobs_claim on hydrate_jobs (queue, state, run_at);
create index if not exists hydrate_jobs_locked on hydrate_jobs (state, locked_until);
```

- **Claiming** takes one statement per dialect. Both SQLite and Postgres forms were probed:
  - **Postgres:** `update … where id in (select id … where state = 'pending' and run_at <= $now order by priority desc, run_at, id limit $n for update skip locked) returning *`. Concurrent workers never block each other.
  - **MySQL 8:** the same, with `select … for update skip locked` and then `update` in one transaction (MySQL has no `update … returning`).
  - **SQLite:** `update … where id in (select … limit $n) returning *` (SQLite 3.51 in Bun 1.3.11). SQLite serializes writers, so this is safe. Because the web and worker processes now share one SQLite file, the database package enables `journal_mode = WAL` and `busy_timeout = 5000` for file databases. SQLite remains single-host only; the docs say so.
- **Transactional dispatch.** `enqueue` uses `db.sql`, so inside `db.transaction()` the job row commits or rolls back with the business data. That is the property that makes the database adapter the right default.
- **Polling (D5).** `Bun.SQL` has no `LISTEN`/`NOTIFY` (probed: `pg.listen` is undefined). Workers poll adaptively: immediately while a claim returns a full batch, then 200 ms, doubling to 2 s when idle. Latency is typically under 250 ms under load and at most about 2 s when idle, at a cost of one indexed query per worker per 2 s.
- **Metrics without scans.** `counts()` uses the claim index; queue depth is sampled at most every 15 s per worker.

### 5.4 Redis

For high throughput, or when jobs must not touch the application database. Layout, all under `redis.key("queue", …)`:

| Key | Type | Content |
|---|---|---|
| `job:<id>` | hash | payload, name, queue, attempt, max, trace, error, timestamps |
| `pending:<queue>` | sorted set | id → score `(9 - priority) * 1e13 + runAt`, so due and higher-priority jobs sort first |
| `active` | sorted set | id → `lockedUntil` |
| `dead:<queue>` | sorted set | id → finishedAt |
| `idem:<key>` | string | job id, with a TTL (pending + retention window) |

- **Every transition is one Lua script** (`EVAL`, probed working): enqueue with its idempotency check, claim (`ZRANGEBYSCORE` due, then `ZREM`, then `ZADD active`), renew, complete, retry, requeueExpired. Scripts are loaded once, then run with `EVALSHA` and an `EVAL` fallback.
- **Wake-up.** Instead of polling, idle workers wait on `BLMOVE` (probed) on a `notify:<queue>` list that enqueue pushes to, with a 2 s timeout. There is no busy loop, and a new job is noticed within about 1 ms.
- **Transactions.** Dispatch inside `db.transaction()` is deferred to `db.afterCommit()` (§6.3). This is at least once from the commit on, but a crash between commit and enqueue loses the job. The docs name this gap and point to the database adapter when that matters (D1).
- **Durability** is exactly Redis's configured persistence (AOF recommended). The docs say this.

### 5.5 SQS and others (D2)

These are not built in v0.4. The adapter contract, the contract test suite, and a documented example adapter (about 150 lines on `fetch` with SigV4) in `docs/extending/queue-adapters.md` are the deliverable. SQS mapping notes: the visibility timeout is the lease; `ChangeMessageVisibility` renews it; deduplication needs FIFO queues; delays over 15 minutes need a re-enqueue.

---

## 6. Events (`@bun-hydrate/events`, FR-100)

### 6.1 API

```ts
// src/events/account-registered.event.ts
export const AccountRegistered = defineEvent("account.registered", schema.object({ accountId: schema.uuid(), email: schema.email() }));

// emit, e.g. in the register route or a service
await events.emit(AccountRegistered, { accountId: account.id, email: account.email });

// in-process listener: runs after commit, best effort, in this process only
events.on(AccountRegistered, async ({ email }, { log }) => log.info("new account", { email }));

// durable listener: becomes a job, at least once, retried, any worker
events.on(AccountRegistered, sendWelcomeEmailListener, { durable: true, retry: { attempts: 5 } });
```

- **Event names** are dotted, past tense (`order.shipped`), and unique in the app: `defineEvent` rejects duplicates at startup. The payload is validated on emit.
- **`emit` returns** once every durable listener's job is enqueued and in-process listeners are scheduled. It does not wait for in-process listeners to finish, so a slow listener cannot slow down the request that emitted.

### 6.2 Delivery modes (D3)

| Mode | Guarantee | How | Use for |
|---|---|---|---|
| In-process (`on`) | At most once; this process | Runs after the emitting transaction commits (or immediately outside one). Errors are logged and counted, never thrown back to the emitter. | Cache invalidation, local notifications, logging |
| Durable (`on(…, { durable: true })`) | At least once; any worker; retried | `emit` enqueues one job per durable listener (named `event:<event>:<listener>`) through the queue. With the database adapter, that happens in the same transaction. | Emails, webhooks, projections, anything that must happen |
| Broadcast (`events.broadcast`) | At most once; every instance | Published on the `PubSub` transport (§9); every instance runs its in-process listeners | Invalidating caches on every instance, config reloads |

This is the transactional-outbox pattern: the jobs table *is* the outbox. There is no separate relay process, and there are no events without a consumer.

### 6.3 `db.afterCommit()` (database package)

```ts
db.afterCommit(() => log.info("committed"));   // runs after the outermost transaction commits; now if none
```

Callbacks are dropped on rollback, so nothing fires for work that was undone. Callbacks registered inside a savepoint that is rolled back are dropped too. In-process listeners, and Redis dispatch inside transactions, use this.

### 6.4 Listener context and tracing

Listeners receive `{ event, log, traceId, services }`. The emitter's trace context is stored with durable jobs and broadcast messages (§13), so a request's trace continues through its listeners and jobs.

---

## 7. Storage (`@bun-hydrate/storage`, FR-180)

### 7.1 Interface

```ts
interface Storage {
  put(key: string, body: Blob | ReadableStream | Uint8Array | string, options?: PutOptions): Promise<StoredObject>;
  get(key: string): Promise<StoredFile | null>;          // { body (stream), size, contentType, etag, lastModified, text(), bytes() }
  head(key: string): Promise<ObjectInfo | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;                    // deleting a missing key is not an error
  list(prefix: string, page?: { cursor?: string; limit?: number }): Promise<Page<ObjectInfo>>;
  signedUrl(key: string, options: { expiresIn: Duration; download?: string }): Promise<string>;
}
interface PutOptions { contentType?: string; cacheControl?: string; metadata?: Record<string, string> }
```

- **Keys** are validated in one place for every adapter. Rejected: empty keys, a leading `/`, `\`, NUL, `.` or `..` segments, and more than 1024 bytes. Keys are NFC-normalized. `storage.key("avatars", accountId, "original.png")` builds keys safely.
- **Streaming.** `put` and `get` stream, so a 2 GB file never sits in memory. `get` returns `null` for missing keys.
- **Scoping.** `storage.scope("avatars/")` returns a scoped view, like `cache.namespace`.

### 7.2 Adapters

| Adapter | Notes |
|---|---|
| `MemoryStorage` | For tests and the contract suite |
| `LocalStorage({ root, signingKey })` | Writes to a temp file, then `rename`, so readers never see half a file. It checks the real path stays under `root`, in case of symlinks. `contentType` and metadata go to a sidecar under `<root>/.meta/`. `signedUrl` returns an app URL signed with HMAC (D7), served by `storageRoutes()`. |
| `S3Storage({ bucket, region?, endpoint?, … })` | On `Bun.S3Client` (built into Bun; confirmed present in 1.3.11). Works with AWS S3, MinIO, R2 and other S3-compatible stores. Credentials come from `S3_*` env or `_FILE` secrets. `signedUrl` is S3 presigning. `list` uses ListObjectsV2 with the continuation token as the cursor. |

`storageContract(makeStorage)` is exported from `@bun-hydrate/testing/storage`. It covers:
- round-trips of text, binary, a 10 MB stream and a Unicode key;
- content type and metadata;
- missing keys;
- listing with pagination, and prefix isolation;
- rejection of key traversal;
- signed URL expiry;
- deleting a missing key.

The S3 adapter runs the contract against an in-process fake S3 server (the minimal REST subset, in `@bun-hydrate/testing`). It also runs against a real bucket when `TEST_S3_URL` is set.

### 7.3 Serving stored files

```ts
app.route("/files", storageRoutes(storage));   // GET /files/<key>?expires=…&sig=…  (LocalStorage only)
```

- The signature covers the key, the expiry and the `download` name. Comparison is constant time.
- Responses are hardened against stored XSS from uploaded files:
  - `Content-Type` comes from stored metadata, never from the extension;
  - `X-Content-Type-Options: nosniff`;
  - `Content-Security-Policy: sandbox; default-src 'none'`;
  - `Content-Disposition: attachment` for everything except images, PDF and plain text.
- `Range` requests are supported (via `Bun.file().slice`), so video and resumable downloads work. `ETag`/`If-None-Match` give 304s.

---

## 8. Uploads (`@bun-hydrate/core`, FR-232)

```ts
.put("/me/avatar", requireAuth(), bodyLimit("5mb"), async (ctx) => {
  const file = await ctx.upload("avatar", { maxSize: "2mb", types: ["image/png", "image/jpeg", "image/webp"] });
  const stored = await storage.put(storage.key("avatars", principal(ctx)!.id), file, { contentType: file.type });
  return { url: await storage.signedUrl(stored.key, { expiresIn: "1h" }) };
})
```

- **Body size.** New App option `maxBodySize` (default `"10mb"`) is passed to `Bun.serve({ maxRequestBodySize })`, so oversize bodies are refused before they are read. Today's default is Bun's 128 MB. `bodyLimit(size)` raises or lowers the limit per route. It checks `Content-Length` early and counts streamed bytes otherwise, answering `413 PAYLOAD_TOO_LARGE`.
- **`ctx.upload(field, rules)`** returns one `File`; `ctx.uploads(field, rules & { maxFiles })` returns several. They fail with a 422 in the v0.2 validation-error shape, so the React form helpers show a per-field message.
- **Types are sniffed (D8).** The first bytes are checked against signatures for PNG, JPEG, GIF, WebP, PDF and ZIP-based formats. A file whose bytes don't match an allowed type is rejected, whatever its name or declared type. The sniffed type becomes `file.type`. Text types are accepted only as valid UTF-8.
- **File names** from the client are never used as storage keys. `file.safeName` provides a sanitized display name (for `Content-Disposition`).
- **Temp files.** Bun parses multipart in memory. The v0.4 default cap of 10 MB keeps that safe. Streaming multipart for very large uploads is a documented limit; direct-to-S3 presigned PUT is the recommended pattern for big files, and the docs give a recipe.

---

## 9. WebSocket fan-out (`@bun-hydrate/core`, FR-241)

```ts
new App({ pubsub: redisPubSub(redis) })     // default: localPubSub()
app.publish("room:lobby", message);          // reaches subscribers on every instance
```

```ts
interface PubSub {
  publish(topic: string, message: string | Uint8Array): Promise<void>;
  subscribe(pattern: string, deliver: (topic: string, message: string | Uint8Array) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
```

- **Delivery path (D6).** With `redisPubSub`, `app.publish` only publishes to Redis (channel `<prefix>ws:<topic>`). Every instance, including the publisher, receives the message through one pattern subscription (`<prefix>ws:*`) and delivers it with Bun's local `server.publish`. With one path for all subscribers, ordering per publisher is the same everywhere, at the cost of one Redis round trip (about 1 ms) for local subscribers too.
- **Direct `ws.publish()` stays local.** Bun's own `ws.publish()` is a process-local shortcut. The docs and the generated room example use `app.publish()`.
- **Failure behaviour.** If Redis is unreachable, `app.publish` rejects (the caller decides) and `/ready` reports `redis` as failing. Messages lost while it is down are not replayed: fan-out is at most once, and clients that need history fetch it over HTTP after reconnecting.
- **Binary messages** are sent as Redis bulk strings, with a one-byte type prefix so text and binary survive the trip.

---

## 10. Process model (FR-240)

| Role | Entry | Built to | Scales by |
|---|---|---|---|
| Web | `src/main.ts` | `dist/index.js` | More instances behind the load balancer (FR-240) |
| Worker | `src/worker.ts` | `dist/worker.js` | More worker processes or instances; `concurrency` per process |
| Embedded (D4) | web process with `startWorkerIn(app)` | `dist/index.js` | Single instance only |

- **One artifact, two entry points.** Both entries share `migrations/`, the container setup (`src/container.ts`, scaffolded) and config.
- **Who migrates.** Exactly one role migrates on start, when `MIGRATE_ON_START` is set: the web role. Workers never migrate. They check `hydrate_migrations` at start and refuse to run if there are pending migrations whose features they depend on. A worker must never run against a schema that is older than its code.
- **Worker health.** With `WORKER_PORT` set, the worker serves `/health`, `/ready` (database and Redis reachable, not shutting down) and `/metrics`. Without it, the worker opens no port.
- **Clustering.** In-process clustering (`reusePort`) remains a non-goal (FR-240).

---

## 11. Shutdown scope (FR-243)

On SIGTERM, each process runs the phases below in order, within one overall `shutdownTimeout` (default 30 s, the same as v0.1):

| # | Web process | Worker process |
|---|---|---|
| 1 | Stop accepting: new requests get 503 `SHUTTING_DOWN`; new WebSocket upgrades are refused | Stop claiming; schedules stop |
| 2 | Drain in-flight requests; close sockets with 1012 (v0.3) | Wait for in-flight jobs. At `shutdownTimeout − 5 s`, abort the rest through `job.signal` and **release** them: back to `pending`, attempt not counted, lease cleared |
| 3 | Run in-process listeners already scheduled (bounded by the remaining time) | Flush final metrics and logs |
| 4 | Unsubscribe pub/sub and broadcast channels | Unsubscribe |
| 5 | Close Redis, then the database (last, since earlier phases may still write) | Same |

- **Implementation.** Phases map onto the v0.3 lifecycle's reverse-order stop hooks, plus two new named phases on `App`: `onDrain` (2–3) and `onDisconnect` (4–5). Resources registered at start therefore close in the documented order without every app having to order its hooks.
- **Tests:**
  - A worker with a job sleeping 60 s gets SIGTERM, exits 0 within the timeout, and the job is `pending` again with its attempt unchanged.
  - A web process with an open subscription exits (the Redis quirk in §2).
  - Killing a worker with SIGKILL during a job: after the lease expires, another worker completes the job, with `attempt = 2`.

---

## 12. Configuration and deployment

### 12.1 New environment variables (all optional unless a feature needs them)

| Variable | Feature | Default |
|---|---|---|
| `REDIS_URL`, `REDIS_PREFIX` | `redis` | —, package name |
| `WORKER_CONCURRENCY`, `WORKER_QUEUES`, `WORKER_PORT` | jobs | 10, all, none |
| `QUEUE_POLL_MAX_INTERVAL` | `jobs:database` | 2s |
| `STORAGE_ROOT`, `STORAGE_SIGNING_KEY` | `storage:local` | `data/storage`, required in production |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `storage:s3` | Bun's S3 defaults |
| `MAX_BODY_SIZE` | core | 10mb |

As in v0.3, every variable supports `_FILE`, and invalid values stop the process at startup with every problem listed at once.

### 12.2 Build

`hydrate build` adds `dist/worker.js` when `src/worker.ts` (or `hydrate.config.ts` `worker`) exists. The bundle carries the same `SAFE_MINIFY` and V8 syntax check as the web bundle.

### 12.3 Docker example

`docs/deploy/docker-compose.yml` shows one image with two commands (`bun dist/index.js`, `bun dist/worker.js`), with Postgres and Redis. It doubles as the e2e topology in §15.

### 12.4 Existing deploy scripts

`deploy.sh` and `Jenkinsfile` are untouched, as requested. Running a worker on the existing EC2 setup needs one more systemd unit (`ExecStart=bun dist/worker.js`, same `EnvironmentFile`). The docs show that unit. Adopting it in `deploy.sh` is a separate change for you to schedule.

---

## 13. Tracing and metrics

- **Trace context.** Jobs store the dispatcher's `traceparent`. The worker starts a child span per attempt, and its logs carry `traceId`/`spanId` (FR-242). Events carry the context into listeners and durable jobs. A request that registers a user can therefore be followed from HTTP, through the emitted event and its listener job, to the mail call, by one `traceId` in the logs. An OpenTelemetry exporter stays out of scope; the log correlation works today.
- **New metrics** (`createMetrics()` observers; cardinality is bounded by job and event definitions, not by payloads):

| Metric | Type | Labels |
|---|---|---|
| `jobs_dispatched_total` | counter | queue, job, deduplicated |
| `jobs_finished_total` | counter | queue, job, outcome (`completed`, `retry`, `dead`, `released`) |
| `job_duration_seconds` | histogram | queue, job |
| `job_queue_latency_seconds` (deferred from spec-5 §7) | histogram | queue, job (from `runAt` to claim) |
| `jobs` | gauge, sampled | queue, state |
| `events_emitted_total` | counter | event |
| `event_listener_failures_total` | counter | event, listener |
| `pubsub_messages_total` | counter | direction (`out`, `in`), outcome |
| `storage_operations_total` | counter | adapter, operation, outcome |

---

## 14. CLI and feature orchestration

### 14.1 New features

| Feature | Requires | Installs |
|---|---|---|
| `redis` | — | `src/platform/redis.ts` (a shared `AppRedis`, readiness, shutdown); `REDIS_URL` |
| `jobs:database` | — | `hydrate_jobs` migration, `src/jobs/queue.ts`, scaffolds `src/worker.ts` and `src/container.ts`, `jobs:*` commands |
| `jobs:redis` | `redis` | Same files, Redis adapter; conflicts with `jobs:database` |
| `events` | `jobs:database` **or** `jobs:redis` (durable listeners need a queue) | `src/events/bus.ts`, generated `src/events/index.ts` |
| `storage:local` / `storage:s3` | — | `src/platform/storage.ts` (`AppStorage` token); for local, the `/files` route; conflict with each other |
| `realtime:redis` | `redis` | Sets `pubsub: redisPubSub(redis)` in `installPlatform` |

v0.3's `cache:redis` gains `requires: ["redis"]` and uses the shared connection. Existing projects keep their current file (it is theirs), and `hydrate doctor` notes the newer template.

### 14.2 Generators, and registries as orchestrator outputs

```bash
bun hydrate generate job send-welcome-email            # src/jobs/send-welcome-email.job.ts + test
bun hydrate generate event account.registered          # src/events/account-registered.event.ts
bun hydrate generate listener account.registered send-welcome --durable
```

Each generator records its definition in `hydrate.features.json` (`extra["job:send-welcome-email"]`), the mechanism v0.3 uses for `generate module --auth` permissions. The orchestrator regenerates `src/jobs/index.ts` (`allJobs`) and `src/events/index.ts` (listeners wired to events). Adding a job therefore never means editing a registry by hand, and deleting one is `hydrate jobs:forget <name>` plus deleting the file.

### 14.3 Commands

| Command | Purpose |
|---|---|
| `hydrate worker [--queues a,b] [--concurrency n]` | Run `src/worker.ts` (development: with reload) |
| `hydrate jobs:status` | Counts per queue and state, oldest pending age, active leases |
| `hydrate jobs:dead [--queue q] [--job name]` | Dead jobs with last error, newest first |
| `hydrate jobs:retry <id…> \| --all-dead [--job name]` | Back to pending, attempts reset |
| `hydrate jobs:purge --completed \| --dead [--older-than 7d]` | Delete old rows |
| `hydrate jobs:dispatch <name> --payload-stdin` | Enqueue by hand (payload validated), e.g. to backfill |

Like v0.3's `auth:*` commands, these run the app's own code with `DATABASE_URL` (and `REDIS_URL`).

---

## 15. Reference app changes

- **Events and jobs.**
  - `account.registered` is emitted on registration. Its durable listener dispatches `send-welcome-email`.
  - The app's `Mailer` interface has a `LogMailer` that appends to `data/outbox.jsonl` in development and tests; a real transport is the app's choice, not the framework's.
  - `cleanup-expired-sessions` runs hourly via `worker.schedule`. This also fixes v0.3's unbounded `sessions` table.
- **Storage and uploads.** `PUT /api/v1/users/me/avatar` accepts PNG, JPEG or WebP up to 2 MB into `storage:local` (`storage:s3` in the Docker example). `GET` returns a signed URL, and the Home page shows the avatar.
- **Fan-out.** Chat rooms (`/ws/rooms/:room`) work across instances with `realtime:redis` when `REDIS_URL` is set, and locally without it.
- **Process roles.** `src/worker.ts` exists, and `hydrate build` produces `dist/worker.js`.
- **Features.** The app is produced with `hydrate add jobs:database events storage:local` (plus `redis realtime:redis` when Redis is configured), then wired by hand as printed, like v0.3.

---

## 16. Test plan (what "done" means)

As in v0.1–v0.3, each item is written as a failing test first. Suites that need Redis, Postgres or S3 run when `TEST_REDIS_URL`, `TEST_POSTGRES_URL` or `TEST_S3_URL` is set. Before v0.4 is called done, all of them run against the local Postgres 16 and Redis.

| Area | Key tests |
|---|---|
| Redis manager | lazy connect; prefixing; a subscribed process exits within 1 s after `close()`; `close()` is idempotent; readiness fails when Redis is down |
| Queue contract (memory, SQLite, Postgres, Redis) | FIFO within priority; delays; dedup while pending, active and retained; 8 concurrent claimers over 200 jobs give no duplicates and lose none; lease expiry requeues and counts the attempt; renew keeps long jobs; retry and backoff times (injected clock); dead after max attempts; `NonRetryableError`; purge; counts |
| Transactional dispatch | a job dispatched in a rolled-back transaction never runs (database); Redis dispatch waits for commit and is skipped on rollback |
| Worker | concurrency cap respected; a timeout aborts `job.signal` and retries; payload revalidation leads to dead `INVALID_PAYLOAD`; jobs without a handler are never claimed and show up in `jobs:status`; per-job scope disposed; logs carry jobId and traceId |
| Cron | parser table (steps, ranges, lists, `@daily`, invalid); next-slot computation across DST in a named timezone; two workers → one job per slot |
| Events | typed payload validation; in-process listeners run after commit and not on rollback; a listener error is logged and counted, and the emitter succeeds; durable listeners enqueue in the same transaction and retry; broadcast reaches listeners on two instances |
| Storage contract (memory, local, fake S3; real S3 when configured) | the round-trips and edge cases in §7.2; local: atomic writes, path escape via symlink refused; signed URL: expiry, tampering → 403, Range → 206, nosniff/CSP/disposition headers |
| Uploads | over `maxBodySize` → 413 before the body is read; `bodyLimit` per route; wrong magic bytes → 422 even with the right extension and type; multiple files; `safeName` |
| Fan-out | two app instances with `redisPubSub`: a message published on A reaches a client on B and on A; Redis down → publish rejects, `/ready` 503 |
| Shutdown | SIGTERM with an in-flight job → exit 0, job released with attempt unchanged; SIGKILL → another worker completes it after the lease (attempt 2); a web process with subscriptions exits cleanly |
| Features | `jobs:database`, `jobs:redis`, `events`, `storage:*`, `redis`, `realtime:redis` added to a fresh project: type-check, generated tests pass, remove round-trip (the v0.3 matrix extended); `generate job/event/listener` registries regenerate; `jobs:*` commands against SQLite |
| Reference app e2e | register → `outbox.jsonl` gets the welcome mail from a **separate worker process**; avatar upload → signed URL → image served with the safe headers; two web instances plus Redis → chat message crosses instances; worker SIGTERM mid-job → job completes after restart; `hydrate build` → `dist/worker.js` runs from a directory without `node_modules` |

---

## 17. Decisions needed before implementation

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Default durable queue | (a) database adapter as the default (transactional dispatch, no new infrastructure), Redis opt-in; (b) Redis required for jobs | **(a)**: correctness (commit and job together) by default; Redis when throughput needs it |
| D2 | SQS (spec-1 FR-091 "potential backends") | (a) adapter contract, contract tests and a documented example, no built adapter; (b) build an SQS adapter now | **(a)**: no AWS account in CI to prove it; the contract makes a community or later adapter safe |
| D3 | Events durability | (a) in-process after commit, plus durable listeners as jobs (the queue is the outbox); (b) a separate event log (Redis Streams or Kafka) | **(a)**: one delivery mechanism to operate; replay and fan-out-to-many-consumers logs are v0.5+ if needed |
| D4 | Where workers run | (a) separate process by default, embedded opt-in; (b) always embedded in web | **(a)**: jobs must not compete with requests for the event loop, and should scale separately |
| D5 | Database queue wake-up | (a) adaptive polling (200 ms → 2 s); (b) Postgres `LISTEN/NOTIFY` via a raw connection | **(a)**: `Bun.SQL` has no `LISTEN` (probed); polling is portable across SQLite, Postgres and MySQL |
| D6 | Fan-out delivery path | (a) every message via Redis, including local subscribers; (b) local immediately, remote via Redis with an instance-id filter | **(a)**: one path, the same ordering everywhere; the ~1 ms cost is acceptable for chat-like traffic |
| D7 | Serving local storage files | (a) HMAC-signed app URLs (`/files/…?expires&sig`); (b) a public static directory | **(a)**: uploaded files are private by default; public assets stay in `public/` |
| D8 | Upload type checking | (a) sniff magic bytes and reject mismatches; (b) trust the declared `Content-Type` | **(a)**: declared types are attacker-controlled; stored XSS via "image" uploads is a classic |
| D9 | Recurring jobs in v0.4 | (a) include (in-house cron parser, dedup per slot); (b) defer | **(a)**: the reference app needs it (session cleanup), and it rides on idempotency keys |
| D10 | Shared Redis package | (a) new `@bun-hydrate/redis` used by all Redis adapters; (b) each package keeps its own client | **(a)**: one place for the subscriber-shutdown quirk, prefixing and readiness |
| D11 | Retention of completed jobs | (a) delete at once unless keyed (then keep for the idempotency window, 24 h); (b) keep all for N hours | **(a)**: the jobs table stays small; history belongs in logs and metrics |
| D12 | Jobs a worker has no handler for | (a) never claimed: they wait for a worker that can run them, and are reported by `jobs:status`; (b) claimed and marked dead | **(a)**: during a rolling deploy, old workers must not kill jobs that new code dispatched |

---

## 18. Implementation order

Each step is a separate commit with its tests green:

1. **Database:** `db.afterCommit()`; SQLite WAL and `busy_timeout` for file databases.
2. **`@bun-hydrate/redis`:** manager, subscriber handling, the exit test; cache and rate-limit accept `{ redis }`.
3. **`@bun-hydrate/queue` core:** `defineJob`, dispatch, the memory adapter, `queueContract()`, `createTestQueue()`.
4. **Worker:** claims, concurrency, leases and renewal, timeouts and `job.signal`, retries and backoff, dead jobs, per-job scope and logs, graceful release.
5. **Database adapter:** SQLite, then Postgres, then MySQL claim SQL; polling; maintenance lease.
6. **Redis adapter:** Lua scripts, `BLMOVE` wake-up, afterCommit dispatch.
7. **Cron:** parser, next-slot computation, per-slot deduplication.
8. **`@bun-hydrate/events`:** in-process after commit, durable listeners, broadcast.
9. **Core:** `PubSub` interface, `redisPubSub`, `app.publish` through it; shutdown phases (`onDrain` / `onDisconnect`).
10. **`@bun-hydrate/storage`:** interface and key rules, memory, local with signed routes, S3 with the fake server, `storageContract()`.
11. **Core uploads:** `maxBodySize`, `bodyLimit`, `ctx.upload(s)`, sniffing.
12. **Observability:** job, event, pub/sub and storage metrics; trace propagation.
13. **CLI:** `hydrate worker`, the worker build entry, `jobs:*` commands; features `redis`, `jobs:*`, `events`, `storage:*`, `realtime:redis`; `generate job/event/listener` with registry outputs.
14. **Reference app:** `hydrate add …`, the welcome-mail flow, session cleanup, avatars, a worker process, and cross-instance chat; e2e with two web instances, one worker, Postgres and Redis.
15. **Docs:** README, `.env.example`, the Docker Compose example, the systemd worker unit, extending-adapters guides, and a spec-6 "as built" pass.

---

## 19. Risks found while writing this spec

- **Redis subscriber shutdown** (probed, 1.3.11): `close()` on a subscribed client keeps the process alive. It is mitigated centrally in `@bun-hydrate/redis` (§2) and pinned by a test, so a Bun fix or regression is noticed.
- **No `LISTEN` in `Bun.SQL`** (probed): polling is the design (D5). If Bun adds it, the database adapter can add a wake-up without an API change.
- **SQLite with two processes:** WAL plus `busy_timeout` handle normal contention. A single SQLite file on network storage is not supported, and the docs say so.
- **Handlers that ignore `job.signal`** can outlive their lease and run twice. This is inherent to at-least-once delivery. It is mitigated by lease renewal, by discarding results from expired leases, and by the idempotency guidance; it cannot be eliminated.
- **`Bun.S3Client` compatibility** across providers is only as good as Bun's implementation. The contract suite runs against a fake server always and a real bucket when configured. Provider quirks found later go to the as-built pass.
- **In-memory multipart parsing** limits uploads to the body cap. Large files should use presigned direct uploads; the docs show how.
