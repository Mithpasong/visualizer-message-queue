"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import type { AttemptLog, Job } from "@/lib/types";

const SCENARIO_LABEL: Record<Job["failMode"], string> = {
  none: "Normal",
  transient: "Transient",
  permanent: "Permanent",
};

const OUTCOME_STYLE: Record<AttemptLog["outcome"], { label: string; dot: string; text: string }> = {
  done: { label: "succeeded", dot: "bg-emerald-500", text: "text-emerald-400" },
  retry: { label: "failed → QStash retried", dot: "bg-amber-500", text: "text-amber-400" },
  failed: { label: "failed → moved to DLQ", dot: "bg-red-500", text: "text-red-400" },
};

function fmtMs(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(t?: number) {
  return t ? new Date(t).toLocaleTimeString("en-US", { hour12: false }) : "-";
}

/** Plain-language explanation of why the job ended up in the DLQ. */
function explain(job: Job) {
  const retries = job.maxAttempts - 1;
  if (job.errorKind === "invalid-input") {
    return {
      title: "Invalid input (non-retryable)",
      body: `The worker validates N before doing any work. "${job.input || "(empty)"}" can never become a valid number, so retrying would only waste time. The worker answered 489 with Upstash-NonRetryable-Error, telling QStash to skip retries and move the message straight to the DLQ.`,
    };
  }
  if (job.failMode === "permanent") {
    return {
      title: "Retries exhausted (simulated permanent failure)",
      body: `This job was enqueued with the Permanent scenario, which throws an error at 50% on every attempt. Each attempt returned HTTP 500, so QStash redelivered it ${retries} more time${retries === 1 ? "" : "s"}. When all ${job.maxAttempts} attempts failed, QStash stopped retrying and moved the message to the DLQ.`,
    };
  }
  if (retries === 0) {
    return {
      title: "Failed with retries disabled",
      body: "This job was enqueued with Retries = 0, so the first failure was final. A transient error that a retry would have fixed still ends up in the DLQ.",
    };
  }
  return {
    title: "Retries exhausted",
    body: `Each attempt returned HTTP 500, so QStash redelivered it. When all ${job.maxAttempts} attempts failed, QStash stopped retrying and moved the message to the DLQ.`,
  };
}

export default function FailureDetails({
  job,
  busy,
  onClose,
  onReplay,
}: {
  job: Job;
  busy: boolean;
  onClose: () => void;
  onReplay: (id: string, input?: string) => void;
}) {
  const [fixInput, setFixInput] = useState(job.input);
  const reason = explain(job);
  const invalid = job.errorKind === "invalid-input";
  const history = job.history ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="failure-title"
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[#3d444d] bg-[#262c36] shadow-2xl"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 420, damping: 34 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[#3d444d] px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-red-500" />
            <h2 id="failure-title" className="text-base font-semibold">
              Job #{job.seq} failed
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-zinc-400 hover:bg-[#2f3742] hover:text-zinc-100"
          >
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4 text-sm">
          {/* Why it failed */}
          <section className="rounded-lg border border-red-900/70 bg-red-950/40 p-4">
            <h3 className="font-semibold text-red-300">{reason.title}</h3>
            <p className="mt-1.5 leading-relaxed text-zinc-300">{reason.body}</p>
            {job.error && (
              <div className="mt-3 rounded bg-black/30 px-3 py-2 font-mono text-xs text-red-300">
                Error: {job.error}
              </div>
            )}
          </section>

          {/* Job settings */}
          <section>
            <h3 className="mb-2 text-xs font-semibold text-zinc-500">Job</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
              <Item label="Input N" value={job.input || "(empty)"} mono />
              <Item label="Scenario" value={SCENARIO_LABEL[job.failMode]} />
              <Item label="Retries" value={`${job.maxAttempts - 1} (max ${job.maxAttempts} attempts)`} />
              <Item label="Attempts used" value={`${history.length || job.attempt}`} />
              <Item label="Concurrency" value={`×${job.parallelism}`} />
              {job.replayOf && <Item label="Replay of" value={`#${job.replayOf}`} />}
              <Item label="Enqueued" value={fmtTime(job.createdAt)} mono />
              <Item label="Failed" value={fmtTime(job.finishedAt)} mono />
              {job.finishedAt && <Item label="Total time" value={fmtMs(job.finishedAt - job.createdAt)} mono />}
            </dl>
          </section>

          {/* Attempt timeline */}
          <section>
            <h3 className="mb-2 text-xs font-semibold text-zinc-500">Attempts</h3>
            {history.length === 0 ? (
              <p className="text-xs text-zinc-500">No attempt history recorded for this job.</p>
            ) : (
              <ol className="relative flex flex-col gap-3 border-l border-[#3d444d] pl-4">
                {history.map((a) => {
                  const style = OUTCOME_STYLE[a.outcome];
                  return (
                    <li key={a.attempt} className="relative text-xs">
                      <span className={`absolute top-1 -left-[21px] h-2.5 w-2.5 rounded-full ring-4 ring-[#262c36] ${style.dot}`} />
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-semibold">
                          Attempt {a.attempt}/{job.maxAttempts}
                        </span>
                        <span className={style.text}>{style.label}</span>
                      </div>
                      <div className="mt-0.5 font-mono text-zinc-500">
                        {fmtTime(a.startedAt)} → {fmtTime(a.endedAt)} ({fmtMs(a.endedAt - a.startedAt)}) · reached {a.progress}% ·
                        HTTP {a.httpStatus}
                        {a.worker && ` · ${a.worker}`}
                      </div>
                      {a.error && <div className="mt-1 text-zinc-300">{a.error}</div>}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>

        {/* Actions */}
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[#3d444d] px-5 py-3">
          {invalid && (
            <input
              value={fixInput}
              onChange={(e) => setFixInput(e.target.value)}
              aria-label="Corrected input"
              className="min-w-0 flex-1 rounded-md border border-[#3d444d] bg-transparent px-3 py-1.5 font-mono text-sm outline-none focus:border-emerald-500"
            />
          )}
          <button
            onClick={onClose}
            className="rounded-md border border-[#3d444d] px-4 py-1.5 text-sm hover:bg-[#2f3742]"
          >
            Close
          </button>
          <button
            onClick={() => {
              onReplay(job.id, invalid ? fixInput : undefined);
              onClose();
            }}
            disabled={busy}
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {invalid ? "Fix & replay" : "Replay"}
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}

function Item({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-zinc-500">{label}</dt>
      <dd className={`truncate ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
