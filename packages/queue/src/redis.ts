import type { Redis } from "@bun-hydrate/redis";
import {
  emptyCounts,
  type ClaimRequest,
  type Completion,
  type EnqueueResult,
  type JobCounts,
  type JobFilter,
  type JobPage,
  type JobRecord,
  type JobState,
  type NewJob,
  type PurgeFilter,
  type QueueAdapter,
} from "./adapter";
import { LEASE_EXPIRED } from "./memory";

/**
 * Key layout (spec-6 §5.4), all under `<prefix>queue:`:
 *   job:<id>                hash: the job
 *   queues, names:<queue>   sets: what exists, for counts and maintenance
 *   pending:<queue>:<name>  zset: score (9 - priority) * 1e13 + runAt, so a range per priority band finds due jobs
 *   active:<queue>          zset: lockedUntil
 *   completed:<queue>, dead:<queue>  zset: finishedAt
 *   idem:<key>              string: the job holding an idempotency key
 *   index                   zset (all scores 0): ids, listed newest first by lexical order (UUIDv7)
 * Every state change is one Lua script, so it is atomic. (Standalone Redis: scripts touch keys
 * they compute, which Redis Cluster does not allow.)
 */
const PENDING_SCORE = "local function score(priority, runAt) return (9 - tonumber(priority)) * 1e13 + tonumber(runAt) end";

const ENQUEUE = `
local p = ARGV[1]
local id, q, name, priority, runAt, key = ARGV[2], ARGV[3], ARGV[4], ARGV[6], ARGV[8], ARGV[10]
${PENDING_SCORE}
if key ~= "" then
  local existing = redis.call("GET", p .. "idem:" .. key)
  if existing then return {existing, 1} end
  redis.call("SET", p .. "idem:" .. key, id)
end
local fields = {"id", id, "queue", q, "name", name, "payload", ARGV[5], "state", "pending", "priority", priority,
  "attempt", "0", "maxAttempts", ARGV[7], "runAt", runAt, "createdAt", ARGV[9]}
if key ~= "" then table.insert(fields, "idempotencyKey"); table.insert(fields, key) end
if ARGV[11] ~= "" then table.insert(fields, "traceParent"); table.insert(fields, ARGV[11]) end
redis.call("HSET", p .. "job:" .. id, unpack(fields))
redis.call("SADD", p .. "queues", q)
redis.call("SADD", p .. "names:" .. q, name)
redis.call("ZADD", p .. "pending:" .. q .. ":" .. name, score(priority, runAt), id)
redis.call("ZADD", p .. "index", 0, id)
return {id, 0}`;

const CLAIM = `
local p, worker, now, lockedUntil, limit = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4], tonumber(ARGV[5])
local i = 6
local queues, names = {}, {}
for j = 1, tonumber(ARGV[i]) do queues[j] = ARGV[i + j] end
i = i + #queues + 1
for j = 1, tonumber(ARGV[i]) do names[j] = ARGV[i + j] end
local candidates = {}
for _, q in ipairs(queues) do
  for _, name in ipairs(names) do
    local key = p .. "pending:" .. q .. ":" .. name
    for band = 0, 9 do
      local low = band * 1e13
      local found = redis.call("ZRANGEBYSCORE", key, low, low + now, "WITHSCORES", "LIMIT", 0, limit)
      for f = 1, #found, 2 do table.insert(candidates, {found[f], tonumber(found[f + 1]), key, q}) end
    end
  end
end
table.sort(candidates, function(a, b) if a[2] ~= b[2] then return a[2] < b[2] end return a[1] < b[1] end)
local claimed = {}
for c = 1, math.min(limit, #candidates) do
  local id, key, q = candidates[c][1], candidates[c][3], candidates[c][4]
  local jobKey = p .. "job:" .. id
  redis.call("ZREM", key, id)
  redis.call("HINCRBY", jobKey, "attempt", 1)
  redis.call("HSET", jobKey, "state", "active", "lockedBy", worker, "lockedUntil", lockedUntil)
  redis.call("ZADD", p .. "active:" .. q, lockedUntil, id)
  table.insert(claimed, redis.call("HGETALL", jobKey))
end
return claimed`;

const RENEW = `
local p, worker, lockedUntil = ARGV[1], ARGV[2], ARGV[3]
local renewed = {}
for i = 4, #ARGV do
  local id = ARGV[i]
  local jobKey = p .. "job:" .. id
  local job = redis.call("HMGET", jobKey, "state", "lockedBy", "queue")
  if job[1] == "active" and job[2] == worker then
    redis.call("HSET", jobKey, "lockedUntil", lockedUntil)
    redis.call("ZADD", p .. "active:" .. job[3], lockedUntil, id)
    table.insert(renewed, id)
  end
end
return renewed`;

const COMPLETE = `
local p, id, worker, outcome, now = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5]
${PENDING_SCORE}
local jobKey = p .. "job:" .. id
local job = redis.call("HMGET", jobKey, "state", "lockedBy", "queue", "name", "priority", "attempt", "idempotencyKey")
if job[1] ~= "active" or job[2] ~= worker then return 0 end
local q, name = job[3], job[4]
redis.call("ZREM", p .. "active:" .. q, id)
redis.call("HDEL", jobKey, "lockedBy", "lockedUntil")
if outcome == "completed" then
  if ARGV[6] == "1" then
    redis.call("HSET", jobKey, "state", "completed", "finishedAt", now)
    redis.call("ZADD", p .. "completed:" .. q, now, id)
  else
    redis.call("DEL", jobKey)
    redis.call("ZREM", p .. "index", id)
    if job[7] then redis.call("DEL", p .. "idem:" .. job[7]) end
  end
elseif outcome == "retry" then
  redis.call("HSET", jobKey, "state", "pending", "runAt", ARGV[6], "lastError", ARGV[7])
  redis.call("ZADD", p .. "pending:" .. q .. ":" .. name, score(job[5], ARGV[6]), id)
elseif outcome == "dead" then
  redis.call("HSET", jobKey, "state", "dead", "finishedAt", now, "lastError", ARGV[7])
  redis.call("ZADD", p .. "dead:" .. q, now, id)
else
  redis.call("HSET", jobKey, "state", "pending", "runAt", now, "attempt", tonumber(job[6]) - 1)
  redis.call("ZADD", p .. "pending:" .. q .. ":" .. name, score(job[5], now), id)
end
return 1`;

const REQUEUE_EXPIRED = `
local p, now, reason = ARGV[1], ARGV[2], ARGV[3]
${PENDING_SCORE}
local count = 0
for _, q in ipairs(redis.call("SMEMBERS", p .. "queues")) do
  for _, id in ipairs(redis.call("ZRANGEBYSCORE", p .. "active:" .. q, "-inf", "(" .. now)) do
    local jobKey = p .. "job:" .. id
    local job = redis.call("HMGET", jobKey, "attempt", "maxAttempts", "name", "priority")
    redis.call("ZREM", p .. "active:" .. q, id)
    redis.call("HDEL", jobKey, "lockedBy", "lockedUntil")
    if tonumber(job[1]) >= tonumber(job[2]) then
      redis.call("HSET", jobKey, "state", "dead", "finishedAt", now, "lastError", reason)
      redis.call("ZADD", p .. "dead:" .. q, now, id)
    else
      redis.call("HSET", jobKey, "state", "pending", "runAt", now, "lastError", reason)
      redis.call("ZADD", p .. "pending:" .. q .. ":" .. job[3], score(job[4], now), id)
    end
    count = count + 1
  end
end
return count`;

const RETRY = `
local p, now = ARGV[1], ARGV[2]
${PENDING_SCORE}
local count = 0
for i = 3, #ARGV do
  local id = ARGV[i]
  local jobKey = p .. "job:" .. id
  local job = redis.call("HMGET", jobKey, "state", "queue", "name", "priority")
  if job[1] == "dead" then
    redis.call("ZREM", p .. "dead:" .. job[2], id)
    redis.call("HSET", jobKey, "state", "pending", "attempt", 0, "runAt", now)
    redis.call("HDEL", jobKey, "finishedAt")
    redis.call("ZADD", p .. "pending:" .. job[2] .. ":" .. job[3], score(job[4], now), id)
    count = count + 1
  end
end
return count`;

const PURGE = `
local p, state, before = ARGV[1], ARGV[2], ARGV[3]
local count = 0
for _, q in ipairs(redis.call("SMEMBERS", p .. "queues")) do
  local set = p .. state .. ":" .. q
  for _, id in ipairs(redis.call("ZRANGEBYSCORE", set, "-inf", "(" .. before)) do
    local key = redis.call("HGET", p .. "job:" .. id, "idempotencyKey")
    if key then redis.call("DEL", p .. "idem:" .. key) end
    redis.call("DEL", p .. "job:" .. id)
    redis.call("ZREM", p .. "index", id)
    redis.call("ZREM", set, id)
    count = count + 1
  end
end
return count`;

class Script {
  readonly sha: string;
  constructor(readonly source: string) {
    this.sha = new Bun.CryptoHasher("sha1").update(source).digest("hex");
  }
}

const SCRIPTS = {
  enqueue: new Script(ENQUEUE),
  claim: new Script(CLAIM),
  renew: new Script(RENEW),
  complete: new Script(COMPLETE),
  requeueExpired: new Script(REQUEUE_EXPIRED),
  retry: new Script(RETRY),
  purge: new Script(PURGE),
};

const NUMBER_FIELDS = ["priority", "attempt", "maxAttempts", "runAt", "createdAt", "lockedUntil", "finishedAt"] as const;

/** A Redis hash (flat array from Lua, or an object) → JobRecord. */
function toRecord(hash: unknown): JobRecord {
  const entries: [string, string][] = Array.isArray(hash)
    ? Array.from({ length: hash.length / 2 }, (_, i) => [String(hash[2 * i]), String(hash[2 * i + 1])])
    : Object.entries(hash as Record<string, string>);
  const record: Record<string, unknown> = Object.fromEntries(entries);
  for (const field of NUMBER_FIELDS) if (record[field] !== undefined) record[field] = Number(record[field]);
  return record as unknown as JobRecord;
}

export interface RedisQueueAdapterOptions {
  redis: Redis;
}

/**
 * Jobs in Redis (spec-6 §5.4): for throughput, or when jobs must not touch the application
 * database. Not transactional: dispatch inside db.transaction() waits for the commit. Durability is
 * whatever Redis persistence is configured (AOF recommended).
 */
export class RedisQueueAdapter implements QueueAdapter {
  readonly transactional = false;
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(options: RedisQueueAdapterOptions) {
    this.redis = options.redis;
    this.prefix = `${this.redis.key("queue")}:`;
  }

  async enqueue(jobs: readonly NewJob[]): Promise<EnqueueResult[]> {
    const results: EnqueueResult[] = [];
    for (const job of jobs) {
      const [id, deduplicated] = (await this.run(SCRIPTS.enqueue, [
        job.id,
        job.queue,
        job.name,
        job.payload,
        String(job.priority),
        String(job.maxAttempts),
        String(job.runAt),
        String(job.createdAt),
        job.idempotencyKey ?? "",
        job.traceParent ?? "",
      ])) as [string, number];
      results.push({ id, deduplicated: deduplicated === 1 });
    }
    await this.redis.publish(this.notifyChannel(), "job").catch(() => {});
    return results;
  }

  async claim({ queues, names, limit, workerId, now, lockedUntil }: ClaimRequest): Promise<JobRecord[]> {
    if (queues.length === 0 || names.length === 0 || limit < 1) return [];
    const claimed = (await this.run(SCRIPTS.claim, [
      workerId,
      String(now),
      String(lockedUntil),
      String(limit),
      String(queues.length),
      ...queues,
      String(names.length),
      ...names,
    ])) as unknown[];
    return claimed.map(toRecord);
  }

  async renew(ids: readonly string[], workerId: string, lockedUntil: number): Promise<string[]> {
    if (ids.length === 0) return [];
    return (await this.run(SCRIPTS.renew, [workerId, String(lockedUntil), ...ids])) as string[];
  }

  async complete(id: string, workerId: string, completion: Completion): Promise<boolean> {
    const extra =
      completion.outcome === "completed"
        ? [completion.keep ? "1" : "0"]
        : completion.outcome === "retry"
          ? [String(completion.runAt), completion.error]
          : completion.outcome === "dead"
            ? ["", completion.error]
            : [];
    return (await this.run(SCRIPTS.complete, [id, workerId, completion.outcome, String(completion.now), ...extra])) === 1;
  }

  async requeueExpired(now: number): Promise<number> {
    return (await this.run(SCRIPTS.requeueExpired, [String(now), LEASE_EXPIRED])) as number;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const hash = await this.redis.client.send("HGETALL", [this.key("job", id)]);
    const empty = Array.isArray(hash) ? hash.length === 0 : Object.keys((hash ?? {}) as object).length === 0;
    return empty ? undefined : toRecord(hash);
  }

  /** Newest first. Filters are applied while scanning the index, so this is for tools, not hot paths. */
  async list({ state, queue, name, limit = 50, cursor }: JobFilter = {}): Promise<JobPage> {
    const matches: JobRecord[] = [];
    let from = cursor === undefined ? "+" : `(${cursor}`;
    for (;;) {
      const ids = (await this.redis.client.send("ZREVRANGEBYLEX", [this.key("index"), from, "-", "LIMIT", "0", "200"])) as string[];
      for (const id of ids) {
        const job = await this.get(id);
        if (job && (!state || job.state === state) && (!queue || job.queue === queue) && (!name || job.name === name)) {
          matches.push(job);
          if (matches.length > limit) return { items: matches.slice(0, limit), nextCursor: matches[limit - 1]!.id };
        }
      }
      if (ids.length < 200) return { items: matches, nextCursor: null };
      from = `(${ids.at(-1)}`;
    }
  }

  async counts(): Promise<JobCounts> {
    const client = this.redis.client;
    const counts: JobCounts = {};
    for (const queue of (await client.send("SMEMBERS", [this.key("queues")])) as string[]) {
      const row = emptyCounts();
      for (const name of (await client.send("SMEMBERS", [this.key("names", queue)])) as string[]) {
        row.pending += Number(await client.send("ZCARD", [this.key("pending", queue, name)]));
      }
      for (const state of ["active", "completed", "dead"] as const satisfies readonly JobState[]) {
        row[state] = Number(await client.send("ZCARD", [this.key(state, queue)]));
      }
      if (Object.values(row).some((count) => count > 0)) counts[queue] = row;
    }
    return counts;
  }

  async retry(ids: readonly string[], now: number): Promise<number> {
    if (ids.length === 0) return 0;
    return (await this.run(SCRIPTS.retry, [String(now), ...ids])) as number;
  }

  async purge({ state, finishedBefore }: PurgeFilter): Promise<number> {
    return (await this.run(SCRIPTS.purge, [state, String(finishedBefore)])) as number;
  }

  /** Wakes idle workers when a job is enqueued, through the Redis manager's subscriber. */
  onWake(listener: () => void): Promise<() => Promise<void>> {
    return this.redis.subscribe(this.notifyChannel(), () => listener());
  }

  /** The shared Redis belongs to the app; it is closed there. */
  async close(): Promise<void> {}

  private notifyChannel(): string {
    return this.key("notify");
  }

  private key(...parts: string[]): string {
    return this.prefix + parts.join(":");
  }

  private async run(script: Script, args: string[]): Promise<unknown> {
    const client = this.redis.client;
    try {
      return await client.send("EVALSHA", [script.sha, "0", this.prefix, ...args]);
    } catch (error) {
      if (!String(error).includes("NOSCRIPT")) throw error;
      return client.send("EVAL", [script.source, "0", this.prefix, ...args]);
    }
  }
}
