import { FLOW_CONTROL_KEY, qstash } from "./qstash";
import { nextSeq, saveJob } from "./redis";
import type { FailMode, Job } from "./types";

const RETRY_DELAY_MS = 3000; // Demo: 3s between retries (the default is tens of seconds to minutes)

/** Publishing to QStash failed, so the job never reached the queue. */
export class PublishError extends Error {}

export function workerUrl(request: Request) {
  // Without APP_URL, use the request origin (localhost locally, the Vercel domain when deployed)
  const origin = process.env.APP_URL ?? new URL(request.url).origin;
  return `${origin}/api/worker`;
}

export async function enqueueJob(
  request: Request,
  params: { input: string; failMode: FailMode; parallelism: number; retries: number; replayOf?: number },
) {
  const job: Job = {
    id: crypto.randomUUID(),
    seq: await nextSeq(),
    input: params.input,
    failMode: params.failMode,
    status: "queued",
    progress: 0,
    attempt: 0,
    maxAttempts: params.retries + 1,
    parallelism: params.parallelism,
    createdAt: Date.now(),
    statusAt: Date.now(),
    replayOf: params.replayOf,
  };

  // 1) Record the job as "queued" in the state store (Redis) first
  await saveJob(job, {
    type: "enqueued",
    seq: job.seq,
    msg: params.replayOf
      ? `#${params.replayOf} replay requested → re-enqueued as #${job.seq}`
      : `#${job.seq} enqueued (input: ${job.input || "(empty)"})`,
  });

  // 2) Publish to the message queue (QStash) → QStash calls /api/worker in order
  try {
    await qstash().publishJSON({
      url: workerUrl(request),
      body: { id: job.id },
      retries: params.retries,
      retryDelay: String(RETRY_DELAY_MS),
      flowControl: { key: FLOW_CONTROL_KEY, parallelism: params.parallelism },
    });
  } catch (err) {
    // Don't leave the job stuck in "queued": record why it never made it into the queue
    const message = `Publish to QStash failed: ${err instanceof Error ? err.message : String(err)}`;
    const failedAt = Date.now();
    await saveJob(
      { ...job, status: "failed", error: message, errorKind: "publish", finishedAt: failedAt, statusAt: failedAt },
      { type: "failed", seq: job.seq, msg: `#${job.seq} ${message}` },
    );
    throw new PublishError(message);
  }

  return job;
}
