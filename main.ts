// Entrypoint for the entry<->env lifecycle.
//
//   1. Read MAKEFUN_ENV_URL (abort if unset).
//   2. Build the app server from ./app.ts and listen on port 0 (ephemeral).
//   3. POST {port} to $MAKEFUN_ENV_URL/register until accepted.
//   4. Poll GET $MAKEFUN_ENV_URL/done until {"done": true}.
//   5. Close the server and exit 0.
//
// Register/done failures are retried with short exponential backoff. Only a
// hard contract error (400/405 from register) terminates with exit 1.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!ENV_URL) {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set; refusing to start\n');
  process.exit(1);
}

// HTTP timing knobs for talking to the env.
const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_INITIAL_MS = 250;
const BACKOFF_CAP_MS = 2_000;

// Pause briefly before the next retry attempt.
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Short exponential backoff: 250ms * 2^attempt, capped at BACKOFF_CAP_MS
// (the exponent is clamped at 8 so the delay never grows beyond the cap).
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

// Timed fetch against the env. Callers handle retries themselves.
async function envFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ENV_URL}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

// POST {port} to /register until the env accepts it.
//   200 -> recorded.
//   409 -> another entry registered first; not ours to fix, keep waiting.
//   400/405 -> contract error; terminate.
//   anything else (network blip, slow env start) -> retry with backoff.
async function registerWithEnv(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await envFetch('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register rejected: HTTP ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected:')) throw err;
    }
    await sleep(backoffMs(attempt));
  }
}

// GET /done until the body is {done: true}; never returns before that.
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await envFetch('/done');
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet or timed out: not done, poll again.
    }
    await sleep(backoffMs(attempt));
  }
}

// Full process life: serve, register, wait for done, close, exit 0.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await registerWithEnv(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  await new Promise<void>((resolve) => server.close(resolve));
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
