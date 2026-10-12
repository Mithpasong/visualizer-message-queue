"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { clampRetries, DEFAULT_RETRIES, MAX_RETRIES } from "@/lib/limits";
import type { FailMode, Job, JobStatus, QueueEvent, QueueState } from "@/lib/types";
import FailureDetails from "./FailureDetails";

type Conn = "connecting" | "live" | "paused" | "error";

const INPUT_PRESETS = [
  { label: "3M", value: "3000000" },
  { label: "10M", value: "10000000" },
  { label: "20M", value: "20000000" },
  { label: "50M", value: "50000000" },
  { label: "abc", value: "abc", bad: true },
  { label: "-5", value: "-5", bad: true },
  { label: "99.9B", value: "99900000000", bad: true },
];

const FAIL_MODES: { value: FailMode; title: string; desc: string }[] = [
  { value: "none", title: "Normal", desc: "Processes as usual" },
  { value: "transient", title: "Transient", desc: "1st attempt fails → recovers on retry" },
  { value: "permanent", title: "Permanent", desc: "Every attempt fails → DLQ" },
];

const COLUMNS: { status: JobStatus; title: string; hint: string; dot: string }[] = [
  { status: "queued", title: "Queued", hint: "Waiting for its turn in the QStash queue", dot: "bg-zinc-400" },
  { status: "processing", title: "Processing", hint: "Worker is crunching on the CPU", dot: "bg-sky-500" },
  { status: "retrying", title: "Retrying", hint: "Failed; QStash will redeliver", dot: "bg-amber-500" },
  { status: "done", title: "Done", hint: "Processed successfully", dot: "bg-emerald-500" },
  { status: "failed", title: "Failed (DLQ)", hint: "No more retries", dot: "bg-red-500" },
];

const EVENT_STYLE: Record<QueueEvent["type"], string> = {
  enqueued: "text-zinc-500",
  started: "text-sky-600 dark:text-sky-400",
  done: "text-emerald-600 dark:text-emerald-400",
  retry: "text-amber-600 dark:text-amber-400",
  failed: "text-red-600 dark:text-red-400",
  reset: "text-zinc-500",
};

function fmtMs(ms?: number) {
  if (ms === undefined || ms < 0) return "-";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(t: number) {
  return new Date(t).toLocaleTimeString("en-US", { hour12: false });
}

export default function Dashboard() {
  const [state, setState] = useState<QueueState>({ ver: 0, jobs: [], events: [] });
  const [conn, setConn] = useState<Conn>("connecting");
  const [now, setNow] = useState(0); // filled on the client only, so the prerender time isn't baked in

  const [input, setInput] = useState("20000000");
  const [count, setCount] = useState(3);
  const [failMode, setFailMode] = useState<FailMode>("none");
  const [parallelism, setParallelism] = useState(1);
  const [retries, setRetries] = useState(String(DEFAULT_RETRIES)); // raw text so the field can be cleared while typing
  const retryCount = clampRetries(retries);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Off for the very first snapshot so existing cards don't all drop in on page load
  const [animateIn, setAnimateIn] = useState(false);
  const [detailsId, setDetailsId] = useState<string | null>(null);

  // SSE connection: disconnect while the tab is hidden to save Redis commands
  useEffect(() => {
    let es: EventSource | null = null;
    let enableTimer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      es?.close();
      setConn("connecting");
      es = new EventSource("/api/stream");
      es.onopen = () => setConn("live");
      es.addEventListener("state", (e) => {
        setState(JSON.parse((e as MessageEvent).data));
        setNow(Date.now());
        setConn("live");
        enableTimer ??= setTimeout(() => setAnimateIn(true), 100);
      });
      es.addEventListener("server-error", (e) => {
        setNotice(`Server error: ${JSON.parse((e as MessageEvent).data).message}`);
        setConn("error");
      });
      es.onerror = () => setConn((c) => (c === "live" ? "connecting" : c));
    };
    const onVisibility = () => {
      if (document.hidden) {
        es?.close();
        es = null;
        setConn("paused");
      } else {
        open();
      }
    };

    open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(enableTimer);
      es?.close();
    };
  }, []);

  const active = state.jobs.some((j) => j.status === "processing" || j.status === "queued" || j.status === "retrying");

  // Clock that drives the live elapsed time of in-flight jobs
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [active]);

  const byStatus = useMemo(() => {
    const map: Record<JobStatus, Job[]> = { queued: [], processing: [], retrying: [], done: [], failed: [] };
    for (const job of state.jobs) map[job.status]?.push(job);
    // Every column is a stack: the job that most recently entered it sits on top
    const enteredAt = (j: Job) => j.statusAt ?? j.createdAt;
    for (const list of Object.values(map)) {
      list.sort((a, b) => enteredAt(b) - enteredAt(a) || b.seq - a.seq);
    }
    return map;
  }, [state.jobs]);

  // Look the job up from live state so the dialog stays current (and closes if the job is cleared)
  const detailsJob = state.jobs.find((j) => j.id === detailsId && j.status === "failed");

  const stats = useMemo(() => {
    const finished = state.jobs.filter((j) => j.status === "done" && j.startedAt && j.finishedAt);
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : undefined);
    return {
      avgWait: avg(finished.map((j) => j.startedAt! - j.createdAt)),
      avgWork: avg(finished.map((j) => j.finishedAt! - j.startedAt!)),
    };
  }, [state.jobs]);

  async function call(url: string, init: RequestInit) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setNotice(data.error ?? `Request failed (${res.status})`);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const enqueue = () =>
    call("/api/jobs", { method: "POST", body: JSON.stringify({ input, count, failMode, parallelism, retries: retryCount }) });
  const reset = () => call("/api/jobs", { method: "DELETE" });
  const replay = (id: string, newInput?: string) =>
    call("/api/replay", { method: "POST", body: JSON.stringify({ id, input: newInput }) });

  return (
    <div className="flex min-h-screen w-full flex-col lg:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-6 px-4 py-8 sm:px-6 lg:h-screen lg:overflow-y-auto">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Message Queue Visualizer</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Browser → <b>/api/jobs</b> → <b>QStash queue</b> → <b>/api/worker</b> (CPU work) → <b>Redis</b> → live updates via SSE
          </p>
        </div>
        <ConnBadge conn={conn} />
      </header>

      {/* Input panel */}
      <section className="grid gap-5 rounded-xl border border-zinc-200 bg-white p-5 md:grid-cols-2 2xl:grid-cols-[1.3fr_1.4fr_auto_auto_auto] dark:border-[#3d444d] dark:bg-[#262c36]">
        <Field label="Input N" hint="Counts primes from 2 to N (max 50M; 20M ≈ 3s). Invalid values are enqueued as-is.">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-sky-500 dark:border-[#3d444d]"
            placeholder="e.g. 20000000"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {INPUT_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setInput(p.value)}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${
                  p.bad
                    ? "border-red-300 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                    : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-[#3d444d] dark:text-zinc-300 dark:hover:bg-[#2f3742]"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Failure scenario">
          <div className="grid grid-cols-3 gap-2">
            {FAIL_MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => setFailMode(m.value)}
                className={`flex h-full flex-col rounded-md border px-2.5 py-2 text-left ${
                  failMode === m.value
                    ? "border-sky-500 bg-sky-50 dark:bg-sky-950/40"
                    : "border-zinc-300 hover:bg-zinc-50 dark:border-[#3d444d] dark:hover:bg-[#2f3742]"
                }`}
              >
                <div className="text-sm font-medium">{m.title}</div>
                {/* Title stays pinned to the top; the description centers vertically in the remaining space */}
                <div className="flex flex-1 items-center pt-1 text-[11px] leading-tight text-zinc-500">{m.desc}</div>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Jobs / Concurrency">
          <div className="flex flex-col gap-2">
            <Segmented options={[1, 3, 5, 10]} value={count} onChange={setCount} suffix=" jobs" />
            <Segmented options={[1, 2, 3, 5]} value={parallelism} onChange={setParallelism} prefix="×" />
          </div>
        </Field>

        <Field label="Retries" hint={`0–${MAX_RETRIES} · up to ${retryCount + 1} attempts`}>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_RETRIES}
            value={retries}
            onChange={(e) => setRetries(e.target.value)}
            onBlur={() => setRetries(String(retryCount))}
            className="w-24 rounded-md border border-zinc-300 bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-sky-500 dark:border-[#3d444d]"
          />
        </Field>

        {/* Enqueue grows to fill the panel's full height; Reset stays at the bottom */}
        <div className="flex flex-col gap-2">
          <button
            onClick={enqueue}
            disabled={busy}
            className="min-h-11 flex-1 rounded-md bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50"
          >
            Enqueue
          </button>
          <button
            onClick={reset}
            disabled={busy}
            className="rounded-md border border-zinc-300 px-5 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-[#3d444d] dark:hover:bg-[#2f3742]"
          >
            Reset
          </button>
        </div>
      </section>

      {notice && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {notice}
        </div>
      )}

      {/* Summary */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 2xl:grid-cols-7">
        {COLUMNS.map((c) => (
          <Stat key={c.status} label={c.title} value={byStatus[c.status].length} dot={c.dot} />
        ))}
        <Stat label="Avg wait" value={fmtMs(stats.avgWait)} />
        <Stat label="Avg processing" value={fmtMs(stats.avgWork)} />
      </section>

      {/* Kanban board */}
      <section className="grid gap-3 md:grid-cols-3 lg:min-h-[480px] lg:flex-1 2xl:grid-cols-5">
        {COLUMNS.map((c) => (
          <div key={c.status} className="flex min-h-48 flex-col rounded-xl lg:min-h-0 bg-zinc-100 p-3 dark:bg-[#1c2128]">
            <div className="mb-3 flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${c.dot}`} />
              <span className="text-sm font-semibold">{c.title}</span>
              <span className="text-xs text-zinc-500">{byStatus[c.status].length}</span>
            </div>
            <p className="-mt-2 mb-3 text-[11px] text-zinc-500">{c.hint}</p>
            <div className="relative flex max-h-[520px] flex-col gap-2 overflow-x-hidden overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1">
              {/* popLayout: leaving cards stop taking space at once, so the rest slide into place */}
              <AnimatePresence mode="popLayout" initial={false}>
                {byStatus[c.status].map((job) => (
                  <motion.div
                    key={job.id}
                    layout
                    initial={animateIn ? { opacity: 0, y: -40, scale: 0.97 } : false}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
                    transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.8 }}
                  >
                    <JobCard job={job} now={now} onReplay={replay} busy={busy} onOpen={setDetailsId} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
        ))}
      </section>

      </div>

      {/* Event log: always-visible sidebar on the right (stacks below on small screens) */}
      <aside className="flex w-full shrink-0 flex-col border-t border-zinc-200 bg-white lg:sticky lg:top-0 lg:h-screen lg:w-[380px] lg:border-t-0 lg:border-l dark:border-[#3d444d] dark:bg-[#262c36]">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-[#3d444d]">
          <h2 className="text-sm font-semibold">Event log</h2>
          <span className="text-xs text-zinc-500">{state.events.length} latest</span>
        </div>
        {state.events.length === 0 ? (
          <p className="px-4 py-3 text-sm text-zinc-500">No events yet. Enqueue some jobs.</p>
        ) : (
          <ol className="flex max-h-96 flex-1 flex-col overflow-y-auto px-4 py-2 text-xs lg:max-h-none">
            {state.events.map((e, i) => (
              <li
                key={`${e.t}-${i}`}
                className="flex flex-col gap-0.5 border-b border-zinc-100 py-2 last:border-b-0 dark:border-[#2f3742]"
              >
                <span className="font-mono text-[11px] text-zinc-500">{fmtTime(e.t)}</span>
                <span className={`leading-snug ${EVENT_STYLE[e.type]}`}>{e.msg}</span>
              </li>
            ))}
          </ol>
        )}
      </aside>

      <AnimatePresence>
        {detailsJob && (
          <FailureDetails
            key={detailsJob.id}
            job={detailsJob}
            busy={busy}
            onClose={() => setDetailsId(null)}
            onReplay={replay}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function JobCard({
  job,
  now,
  onReplay,
  busy,
  onOpen,
}: {
  job: Job;
  now: number;
  onReplay: (id: string, input?: string) => void;
  busy: boolean;
  onOpen: (id: string) => void;
}) {
  const failed = job.status === "failed";
  const [fixInput, setFixInput] = useState(job.input);
  const waited = (job.startedAt ?? now) - job.createdAt;
  const worked = job.startedAt ? (job.finishedAt ?? now) - job.startedAt : undefined;

  const bar =
    job.status === "failed"
      ? "bg-red-500"
      : job.status === "retrying"
        ? "bg-amber-500"
        : job.status === "done"
          ? "bg-emerald-500"
          : "bg-sky-500";

  return (
    <article
      // Failed cards open the failure details dialog
      onClick={failed ? () => onOpen(job.id) : undefined}
      onKeyDown={failed ? (e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && onOpen(job.id) : undefined}
      role={failed ? "button" : undefined}
      tabIndex={failed ? 0 : undefined}
      title={failed ? "Click to see why it failed" : undefined}
      className={`rounded-lg border border-zinc-200 bg-white p-3 text-xs shadow-sm dark:border-[#3d444d] dark:bg-[#2a313c] ${
        failed ? "cursor-pointer transition-colors hover:border-red-400 focus-visible:border-red-400 focus-visible:outline-none dark:hover:border-red-800" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">#{job.seq}</span>
        <div className="flex gap-1">
          {job.replayOf && <Badge tone="zinc">replay of #{job.replayOf}</Badge>}
          {job.failMode === "transient" && <Badge tone="amber">Transient</Badge>}
          {job.failMode === "permanent" && <Badge tone="red">Permanent</Badge>}
          {job.parallelism > 1 && <Badge tone="sky">×{job.parallelism}</Badge>}
        </div>
      </div>

      <div className="mt-1 truncate font-mono text-zinc-600 dark:text-zinc-400">N = {job.input || "(empty)"}</div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-[#3d444d]">
        <div className={`h-full transition-all duration-300 ${bar}`} style={{ width: `${job.progress}%` }} />
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-zinc-500">
        <dt>Wait</dt>
        <dd className="text-right font-mono">{fmtMs(waited)}</dd>
        <dt>Processing</dt>
        <dd className="text-right font-mono">{fmtMs(worked)}</dd>
        {job.attempt > 0 && (
          <>
            <dt>Attempt</dt>
            <dd className="text-right font-mono">
              {job.attempt}/{job.maxAttempts}
            </dd>
          </>
        )}
        {job.worker && (
          <>
            <dt>Worker</dt>
            <dd className="truncate text-right font-mono">{job.worker}</dd>
          </>
        )}
        {job.result !== undefined && (
          <>
            <dt>Result</dt>
            <dd className="text-right font-mono text-emerald-600 dark:text-emerald-400">
              {job.result.toLocaleString("en-US")} primes
            </dd>
          </>
        )}
      </dl>

      {job.error && (
        <p className={`mt-2 rounded px-2 py-1 ${job.status === "failed" ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300" : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"}`}>
          {job.errorKind === "invalid-input" && <b>Invalid input · </b>}
          {job.error}
        </p>
      )}

      {failed && (
        // Keep clicks on the replay controls from also opening the dialog
        <div className="mt-2 flex gap-1.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {job.errorKind === "invalid-input" && (
            <input
              value={fixInput}
              onChange={(e) => setFixInput(e.target.value)}
              className="w-full min-w-0 rounded border border-zinc-300 bg-transparent px-2 py-1 font-mono dark:border-[#3d444d]"
            />
          )}
          <button
            onClick={() => onReplay(job.id, job.errorKind === "invalid-input" ? fixInput : undefined)}
            disabled={busy}
            className="shrink-0 rounded border border-red-300 px-2 py-1 font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
          >
            {job.errorKind === "invalid-input" ? "Fix & replay" : "Replay"}
          </button>
        </div>
      )}
      {failed && <p className="mt-1.5 text-[10px] text-zinc-500">Click card for failure details</p>}
    </article>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold text-zinc-500">{label}</div>
      {children}
      {hint && <p className="mt-1.5 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
  prefix = "",
  suffix = "",
}: {
  options: number[];
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-zinc-300 dark:border-[#3d444d]">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`flex-1 px-3 py-1.5 text-sm ${
            value === o ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-[#2f3742]"
          }`}
        >
          {prefix}
          {o}
          {suffix}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value, dot }: { label: string; value: number | string; dot?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-[#3d444d] dark:bg-[#262c36]">
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
        {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />}
        {label}
      </div>
      <div className="mt-0.5 font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

function Badge({ tone, children }: { tone: "zinc" | "amber" | "red" | "sky"; children: React.ReactNode }) {
  const tones = {
    zinc: "bg-zinc-100 text-zinc-600 dark:bg-[#3d444d] dark:text-zinc-300",
    amber: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    sky: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  };
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tones[tone]}`}>{children}</span>;
}

function ConnBadge({ conn }: { conn: Conn }) {
  const map: Record<Conn, { text: string; dot: string }> = {
    connecting: { text: "Connecting", dot: "bg-zinc-400 animate-pulse" },
    live: { text: "Live (SSE)", dot: "bg-emerald-500" },
    paused: { text: "Paused (tab hidden)", dot: "bg-zinc-400" },
    error: { text: "Connection error", dot: "bg-red-500" },
  };
  return (
    <div className="flex items-center gap-2 rounded-full border border-zinc-200 px-3 py-1 text-xs dark:border-[#3d444d]">
      <span className={`h-2 w-2 rounded-full ${map[conn].dot}`} />
      {map[conn].text}
    </div>
  );
}
