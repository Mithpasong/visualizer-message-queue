import { Redis } from "@upstash/redis";
import type { Job, QueueEvent, QueueState } from "./types";

// All jobs are stored as JSON in a single hash (mq:jobs).
// One HGETALL reads the whole state on refresh, which saves Upstash commands.
export const KEYS = {
  jobs: "mq:jobs",
  events: "mq:events",
  ver: "mq:ver", // +1 on every change → SSE checks only this value to detect changes
  seq: "mq:seq",
};

const MAX_EVENTS = 40;
export const MAX_JOBS = 60;
const TTL_SECONDS = 60 * 60 * 24;

let client: Redis | null = null;

export function redis() {
  return (client ??= Redis.fromEnv());
}

export async function getVersion() {
  return Number((await redis().get<number>(KEYS.ver)) ?? 0);
}

export async function getState(): Promise<QueueState> {
  const [jobs, events, ver] = await redis()
    .pipeline()
    .hgetall<Record<string, Job>>(KEYS.jobs)
    .lrange<QueueEvent>(KEYS.events, 0, MAX_EVENTS - 1)
    .get<number>(KEYS.ver)
    .exec<[Record<string, Job> | null, QueueEvent[], number | null]>();

  return {
    ver: Number(ver ?? 0),
    jobs: Object.values(jobs ?? {}).sort((a, b) => a.seq - b.seq),
    events: events ?? [],
  };
}

export async function getJob(id: string) {
  return redis().hget<Job>(KEYS.jobs, id);
}

/** Save job + (optional) event log + version bump in one round trip. */
export async function saveJob(job: Job, event?: Omit<QueueEvent, "t">) {
  const p = redis().pipeline();
  p.hset(KEYS.jobs, { [job.id]: job });
  p.expire(KEYS.jobs, TTL_SECONDS);
  if (event) {
    p.lpush(KEYS.events, { ...event, t: Date.now() });
    p.ltrim(KEYS.events, 0, MAX_EVENTS - 1);
    p.expire(KEYS.events, TTL_SECONDS);
  }
  p.incr(KEYS.ver);
  await p.exec();
}

/** Record an event that isn't tied to a job update (e.g. a rejected QStash delivery). */
export async function logEvent(event: Omit<QueueEvent, "t">) {
  await redis()
    .pipeline()
    .lpush(KEYS.events, { ...event, t: Date.now() })
    .ltrim(KEYS.events, 0, MAX_EVENTS - 1)
    .incr(KEYS.ver)
    .exec();
}

export async function nextSeq() {
  return redis().incr(KEYS.seq);
}

/** Delete old jobs so at most MAX_JOBS remain. */
export async function trimJobs() {
  const jobs = await redis().hgetall<Record<string, Job>>(KEYS.jobs);
  if (!jobs) return;
  const list = Object.values(jobs);
  if (list.length <= MAX_JOBS) return;
  const removable = list
    .filter((j) => j.status === "done" || j.status === "failed")
    .sort((a, b) => a.seq - b.seq)
    .slice(0, list.length - MAX_JOBS)
    .map((j) => j.id);
  if (removable.length) await redis().hdel(KEYS.jobs, ...removable);
}

export async function resetAll() {
  await redis()
    .pipeline()
    .del(KEYS.jobs, KEYS.events, KEYS.seq)
    .lpush(KEYS.events, { t: Date.now(), type: "reset", msg: "All jobs cleared" })
    .incr(KEYS.ver)
    .exec();
}
