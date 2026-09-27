# Writing a queue or storage adapter

bun-hydrate ships queue adapters for memory, the database (SQLite, Postgres) and Redis. Its
storage adapters cover memory, the local disk and S3-compatible stores. Anything else (SQS, a
managed Postgres queue, Google Cloud Storage, Azure Blob) plugs in through the same interfaces.
The contract test suites decide whether an adapter is correct: an adapter that passes them works
with the worker, events, `hydrate jobs:*` and `storageRoutes()` unchanged (spec-6 §5.1, §7.2).

## Queue adapters

### The interface

`QueueAdapter` (from `@bun-hydrate/queue`) stores jobs. It never schedules or runs them: the worker does.

Two rules make adapters testable and interchangeable:

- **Adapters never read a clock.** Every time (`now`, `runAt`, `lockedUntil`) arrives as an argument. The contract tests can therefore drive time deterministically.
- **Leases are the only locking.** A claimed job belongs to `workerId` until `lockedUntil`:
  - `renew` extends only leases the worker still holds;
  - `complete` returns `false` once the lease was lost, and the result is discarded;
  - `requeueExpired` gives abandoned jobs back to pending, counting the attempt, or to dead when none are left.

| Method | Must |
|---|---|
| `enqueue(jobs)` | Store jobs as given. A job whose `idempotencyKey` matches a pending, active or retained completed job is not stored: return `{ deduplicated: true }` with the existing id. |
| `claim({ queues, names, limit, workerId, now, lockedUntil })` | Return up to `limit` due jobs (`runAt <= now`). Only return jobs in `queues` whose name is in `names`, because workers never claim jobs they cannot run (D12). Order: priority (9 first), then `runAt`, then creation. Mark them active, lease them, and increment `attempt`. Two concurrent claimers must never get the same job. |
| `complete(id, workerId, completion)` | Apply `completed` (delete, or keep when `keep`), `retry` (pending at `runAt`, with the error), `dead` or `released`. `released` means pending now, with the claim not counted. |
| `get`, `list`, `counts` | Serve `hydrate jobs:*` and metrics. `list` pages newest first. |
| `retry(ids, now)`, `purge(filter)` | Operator actions: revive dead jobs with fresh attempts; delete finished jobs older than a cut-off. |
| `onWake(listener)` (optional) | Call `listener` when jobs are enqueued, so idle workers skip their poll delay. |
| `transactional` (optional property) | `true` only if `enqueue` joins the caller's `db.transaction()`. Otherwise `Queue.dispatch` inside a transaction waits for the commit (`db.afterCommit`). |

### Run the contract

```ts
// test/sqs.test.ts
import { queueContract } from "@bun-hydrate/testing/queue";
import { SqsQueueAdapter } from "../src/sqs";

queueContract("sqs", async () => {
  const adapter = new SqsQueueAdapter({ queueUrl: await createTestQueue() });
  return { adapter, cleanup: () => deleteTestQueue(adapter) };
});
```

It runs about 15 tests, among them:
- FIFO within a priority;
- delays;
- deduplication while a job is pending, active and retained;
- 8 concurrent claimers over 200 jobs with no duplicates and no losses;
- lease expiry and renewal;
- retries, dead jobs and release;
- purge, counts and paging.

### Notes for SQS (spec-6 D2)

No SQS adapter ships with bun-hydrate, because there is no AWS account in CI to prove one. The
contract maps onto SQS like this:

- **Leases** are the visibility timeout. `claim` is `ReceiveMessage` with `VisibilityTimeout = lockedUntil - now`, and `renew` is `ChangeMessageVisibility`. Store the receipt handle per job id, because `complete` needs it for `DeleteMessage`.
- **`names` filtering** has no SQS equivalent. Use one SQS queue per job name, or have `claim` return the messages it cannot run with visibility 0.
- **Priorities** need one SQS queue per band. **Idempotency** needs a FIFO queue's deduplication, which covers 5 minutes, not 24 hours; or keep a table of keys.
- **`list`, `counts`, `retry` and `purge`** need a side table (DynamoDB or the app's database). Dead jobs map to a dead-letter queue.

Where the contract cannot be met, say so in the adapter's README and skip only those tests. Don't
bend the worker to fit.

## Storage adapters

Extend `StorageBase` (from `@bun-hydrate/storage`) and implement six protected methods. Keys
arrive already validated and NFC-normalized: no `..`, no leading `/`, no control characters, and at
most 1024 bytes. The public methods handle validation, default content types and `scope()`.

| Method | Must |
|---|---|
| `write(key, body, { contentType, contentDisposition })` | Store the body. A body can be a `ReadableStream`: stream it, never buffer it whole. Readers must never see a partial object. Return the new `ObjectInfo`, whose `etag` changes whenever the content does. |
| `read(key)` | Return a `StoredFile` with a streaming `body`, or `null`. |
| `stat(key)` | Return `ObjectInfo`, or `null`. |
| `remove(key)` | Delete the object. Deleting a missing key is not an error. |
| `listKeys(prefix, cursor, limit)` | Return keys in order, with `nextCursor` (the last key) while more remain. |
| `sign(key, { expiresIn, download })` | Return a URL that serves the object until it expires, as an attachment named `download` when given. Make it presigned by the store, or served by your own route as `LocalStorage` does with `storageRoutes()`. |

```ts
import { storageContract } from "@bun-hydrate/testing/storage";

storageContract("gcs", async () => ({ storage: new GcsStorage({ bucket: testBucket }) }));
```

The contract covers text and binary round-trips, a 10 MB streamed body, Unicode keys, missing
keys, overwrites and etags, ordered paginated listing, key validation, `scope()` and signed URLs.
`S3Storage` runs it against `startFakeS3()` from `@bun-hydrate/testing/s3`, and against a real
store when `TEST_S3_URL` is set.

## Metrics for your adapter

The metrics object from `createMetrics()` (`@bun-hydrate/observability`) works with any adapter:

- `metrics.observeStorage(storage, "gcs")` returns the storage wrapped to count `storage_operations_total{adapter,operation,outcome}`.
- `metrics.observeQueueDepth(adapter)` samples the `jobs{queue,state}` gauge from `counts()`.
- `metrics.jobObserver()` gives the queue's `onDispatch` and the worker's `onFinished` callbacks.
