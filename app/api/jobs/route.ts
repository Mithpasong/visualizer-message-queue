import { enqueueJob, PublishError } from "@/lib/enqueue";
import { clampRetries } from "@/lib/limits";
import { resetAll, trimJobs } from "@/lib/redis";
import type { FailMode } from "@/lib/types";

const FAIL_MODES: FailMode[] = ["none", "transient", "permanent"];

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

// Create jobs: input is NOT validated here and goes into the queue as-is
// (to show how the worker handles a bad message that made it into the queue)
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const input = String(body.input ?? "").slice(0, 40);
  const count = clamp(body.count, 1, 10, 1);
  const parallelism = clamp(body.parallelism, 1, 5, 1);
  const retries = clampRetries(body.retries);
  const failMode: FailMode = FAIL_MODES.includes(body.failMode) ? body.failMode : "none";

  const jobs = [];
  try {
    for (let i = 0; i < count; i++) {
      jobs.push(await enqueueJob(request, { input, failMode, parallelism, retries }));
    }
  } catch (err) {
    // Surface the real reason (e.g. a wrong QSTASH_TOKEN / QSTASH_URL) instead of an empty 500
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/jobs]", message);
    return Response.json({ error: message, jobs }, { status: err instanceof PublishError ? 502 : 500 });
  }
  await trimJobs();

  return Response.json({ jobs });
}

export async function DELETE() {
  await resetAll();
  return Response.json({ ok: true });
}
