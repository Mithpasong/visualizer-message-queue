import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { countPrimes, InvalidInputError, parseInput } from "@/lib/cpu-task";
import { QSTASH_DEV_MODE } from "@/lib/qstash";
import { getJob, logEvent, saveJob } from "@/lib/redis";
import type { AttemptLog, Job } from "@/lib/types";

export const maxDuration = 60;

// ID that shows whether the same serverless instance is reused
const INSTANCE_ID = crypto.randomUUID().slice(0, 6);

/** Append this attempt's outcome to the job's history. */
function withAttempt(job: Job, log: Omit<AttemptLog, "attempt" | "startedAt" | "endedAt" | "worker" | "progress">): Job {
  const entry: AttemptLog = {
    attempt: job.attempt,
    startedAt: job.startedAt ?? Date.now(),
    endedAt: Date.now(),
    worker: job.worker,
    progress: job.progress,
    ...log,
  };
  return { ...job, history: [...(job.history ?? []), entry] };
}

async function work(request: Request) {
  const { id } = await request.json();
  const stored = await getJob(id);

  // If the job was cleared or already finished, return 200 so QStash stops delivering it
  if (!stored || stored.status === "done" || stored.status === "failed") {
    return Response.json({ skipped: true });
  }

  // On retries QStash sets the Upstash-Retried header to the retry count
  const attempt = Number(request.headers.get("upstash-retried") ?? 0) + 1;
  let job: Job = {
    ...stored,
    status: "processing",
    progress: 0,
    attempt,
    startedAt: Date.now(),
    statusAt: Date.now(),
    worker: `${process.env.VERCEL_REGION ?? "local"}-${INSTANCE_ID}`,
    error: undefined,
  };
  await saveJob(job, {
    type: "started",
    seq: job.seq,
    msg: `#${job.seq} started (attempt ${attempt}/${job.maxAttempts}, worker ${job.worker})`,
  });

  try {
    const limit = parseInput(job.input);
    const shouldFail =
      job.failMode === "permanent" || (job.failMode === "transient" && attempt === 1);

    const result = await countPrimes(
      limit,
      async (progress) => {
        job = { ...job, progress };
        await saveJob(job);
      },
      { failAt: shouldFail ? 50 : undefined },
    );

    const finishedAt = Date.now();
    job = { ...job, status: "done", progress: 100, result, finishedAt, statusAt: finishedAt };
    job = withAttempt(job, { outcome: "done", httpStatus: 200 });
    await saveJob(job, {
      type: "done",
      seq: job.seq,
      msg: `#${job.seq} done: ${result.toLocaleString("en-US")} primes ≤ ${limit.toLocaleString("en-US")} (${job.finishedAt! - job.startedAt!}ms)`,
    });
    return Response.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const invalid = err instanceof InvalidInputError;
    const lastAttempt = attempt >= job.maxAttempts;

    if (invalid || lastAttempt) {
      // Final failure: retrying invalid input is pointless, so fail immediately
      job = {
        ...job,
        status: "failed",
        error: message,
        errorKind: invalid ? "invalid-input" : "processing",
        finishedAt: Date.now(),
        statusAt: Date.now(),
      };
      job = withAttempt(job, { outcome: "failed", error: message, httpStatus: invalid ? 489 : 500 });
      await saveJob(job, {
        type: "failed",
        seq: job.seq,
        msg: invalid
          ? `#${job.seq} invalid input → failed without retry: ${message}`
          : `#${job.seq} all ${job.maxAttempts} attempts failed → moved to DLQ: ${message}`,
      });

      if (invalid) {
        // 489 + this header tells QStash to skip retries and send it straight to the DLQ
        return new Response(message, {
          status: 489,
          headers: { "Upstash-NonRetryable-Error": "true" },
        });
      }
      return new Response(message, { status: 500 });
    }

    // Transient failure: returning 500 makes QStash redeliver shortly
    job = { ...job, status: "retrying", error: message, statusAt: Date.now() };
    job = withAttempt(job, { outcome: "retry", error: message, httpStatus: 500 });
    await saveJob(job, {
      type: "retry",
      seq: job.seq,
      msg: `#${job.seq} attempt ${attempt} failed → QStash will retry: ${message}`,
    });
    return new Response(message, { status: 500 });
  }
}

// Signature check: only handle requests sent by QStash (created on first call so the build works without keys)
let handler: ((request: Request) => Promise<Response>) | null = null;

export async function POST(request: Request) {
  // Only QStash deliveries carry this header; anything else is just rejected quietly
  const fromQStash = request.headers.has("upstash-signature");
  try {
    handler ??= verifySignatureAppRouter(work, { devMode: QSTASH_DEV_MODE });
    const response = await handler(request);
    if (fromQStash && response.status === 403) {
      // Signature check failed before the job could start: make it visible instead of a silent stall
      await reportRejected("invalid signature — check QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY");
    }
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (fromQStash) await reportRejected(message);
    return new Response(message, { status: 500 });
  }
}

async function reportRejected(reason: string) {
  console.error("[api/worker] rejected QStash delivery:", reason);
  await logEvent({ type: "failed", msg: `Worker rejected a QStash delivery: ${reason}` }).catch(() => {});
}
