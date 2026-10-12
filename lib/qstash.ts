import { Client } from "@upstash/qstash";

// With QSTASH_DEV=true the SDK starts and uses a local QStash dev server automatically.
// In deployments it reads the QSTASH_TOKEN (+ QSTASH_URL) env vars.
let client: Client | null = null;

export function qstash() {
  return (client ??= new Client());
}

// Messages with the same key are delivered to the worker at most `parallelism` at a time.
export const FLOW_CONTROL_KEY = "mq-demo";
