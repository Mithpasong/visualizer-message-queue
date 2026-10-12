import { connection } from "next/server";
import { getState, getVersion } from "@/lib/redis";

export const maxDuration = 60;

const STREAM_MS = 50_000; // Close before the function time limit (EventSource reconnects automatically)
const ACTIVE_TICK_MS = 500; // while jobs are in flight
const IDLE_TICK_MS = 2000; // while the queue is idle (saves Redis commands)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Server-Sent Events: poll only the version (mq:ver) and send the full state when it changes.
export async function GET(request: Request) {
  await connection(); // run only at request time, not during the build
  const encoder = new TextEncoder();
  const { signal } = request;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const deadline = Date.now() + STREAM_MS;
      let lastVer = -1;
      let active = true;

      send("retry: 1000\n\n");
      try {
        while (!signal.aborted && Date.now() < deadline) {
          const ver = await getVersion();
          if (ver !== lastVer) {
            const state = await getState();
            lastVer = state.ver;
            active = state.jobs.some((j) => j.status !== "done" && j.status !== "failed");
            send(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
          } else {
            send(": ping\n\n");
          }
          await sleep(active ? ACTIVE_TICK_MS : IDLE_TICK_MS);
        }
      } catch (err) {
        if (!signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          send(`event: server-error\ndata: ${JSON.stringify({ message })}\n\n`);
        }
      }
      try {
        controller.close();
      } catch {
        // the client already disconnected
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
