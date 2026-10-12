import { enqueueJob } from "@/lib/enqueue";
import { getJob } from "@/lib/redis";

// Re-enqueue a job that finally failed (DLQ). The input can be fixed before replaying.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const original = await getJob(String(body.id ?? ""));
  if (!original) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }
  if (original.status !== "failed") {
    return Response.json({ error: "Only failed jobs can be replayed" }, { status: 400 });
  }

  const input = typeof body.input === "string" ? body.input.slice(0, 40) : original.input;
  const job = await enqueueJob(request, {
    input,
    failMode: "none", // assume the cause was fixed and process again
    parallelism: original.parallelism,
    retries: original.maxAttempts - 1,
    replayOf: original.seq,
  });

  return Response.json({ job });
}
