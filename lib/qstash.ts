import { Client } from "@upstash/qstash";

// With QSTASH_DEV=true the SDK starts and uses a local QStash dev server automatically.
// In deployments it reads the QSTASH_TOKEN (+ QSTASH_URL) env vars.
let client: Client | null = null;

// Local dev server only: on Vercel always use the real QStash, even if QSTASH_DEV was copied over by mistake.
// `undefined` lets the SDK read QSTASH_DEV as usual everywhere else.
export const QSTASH_DEV_MODE = process.env.VERCEL ? false : undefined;

export function qstash() {
  return (client ??= new Client({ devMode: QSTASH_DEV_MODE }));
}

// Messages with the same key are delivered to the worker at most `parallelism` at a time.
export const FLOW_CONTROL_KEY = "mq-demo";
