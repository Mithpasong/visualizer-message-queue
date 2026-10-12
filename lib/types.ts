export type JobStatus = "queued" | "processing" | "retrying" | "done" | "failed";

/**
 * none      : processes normally
 * transient : only the first attempt fails at 50% → recovered by QStash retry
 * permanent : every attempt fails → retries exhausted → final failure (DLQ)
 */
export type FailMode = "none" | "transient" | "permanent";

export type Job = {
  id: string;
  seq: number;
  input: string; // raw user input (validated in the worker)
  failMode: FailMode;
  status: JobStatus;
  progress: number; // 0 ~ 100
  attempt: number; // current attempt number (including QStash retries)
  maxAttempts: number; // 1 + number of retries
  parallelism: number; // concurrency setting when this job was enqueued
  createdAt: number;
  statusAt?: number; // when the job entered its current status (column order: newest on top)
  startedAt?: number;
  finishedAt?: number;
  worker?: string; // serverless instance ID that processed it
  result?: number; // number of primes found
  error?: string;
  errorKind?: "invalid-input" | "processing" | "publish";
  replayOf?: number; // original job number when a failed job is replayed
  history?: AttemptLog[]; // one entry per delivery attempt, oldest first
};

/** What happened on a single delivery attempt (shown in the failure details dialog). */
export type AttemptLog = {
  attempt: number;
  startedAt: number;
  endedAt: number;
  worker?: string;
  progress: number; // how far it got before it ended
  outcome: "done" | "retry" | "failed";
  error?: string;
  httpStatus: number; // what the worker answered QStash
};

export type QueueEvent = {
  t: number;
  type: "enqueued" | "started" | "done" | "retry" | "failed" | "reset";
  seq?: number;
  msg: string;
};

export type QueueState = {
  ver: number;
  jobs: Job[];
  events: QueueEvent[];
};
