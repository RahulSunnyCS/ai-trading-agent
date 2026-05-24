# Redis Streams vs BullMQ

> Part of the [Tech Stack Reference](../tech-stack.md) deep-dive series.

Both sit on the **same Redis 7 instance**, but they solve opposite-shaped
problems. This project uses Redis **Streams** for the live tick firehose and
will use **BullMQ** for the once-a-day EOD retrospection job.

## Redis Streams — a continuous firehose

A Stream is an append-only log. A producer does `XADD`; consumers do `XREAD`
from the last ID they saw. In this codebase that's `streamPublish` /
`streamRead` in `src/redis/client.ts` — a tick is `XADD`'d to `market.ticks`,
and downstream readers (straddle calculator, VIX feed) pull from it.

```ts
// src/redis/client.ts — XADD with auto-generated timestamp ID
const id = await redis.xadd(stream, '*', ...flatFields);
```

Characteristics:
- **High-frequency and never-ending.** Ticks arrive every few hundred ms,
  forever. There is no "job done" — it's a flow.
- **Fan-out.** One tick, many independent readers, each tracking its own
  position in the log.
- **Order and time are intrinsic.** IDs are timestamp-based
  (`1700000000000-0`), so the log *is* the timeline.
- **You hand-roll the plumbing.** The publish/read/consumer-group helpers are
  written by hand in `src/redis/client.ts`.

Stream topics are declared as constants in the same file:
`market.ticks`, `straddle.values`, `signals.generated`.

## BullMQ — a task list with a manager

BullMQ is a *job queue* built on top of Redis. You `queue.add(job)`, a `Worker`
picks it up and runs it, and each job has a lifecycle: waiting → active →
completed / failed.

Characteristics:
- **Discrete, occasional, heavy.** The EOD retrospection runs **once after
  market close** and processes all 10 personalities. That's a "job," not a
  "stream."
- **It provides machinery you'd hate to build by hand:** automatic retries with
  backoff, scheduling ("run at 16:00 IST"), concurrency limits, dead-letter
  handling, and a durable record of which jobs failed and why.

## Why this project splits them this way

| | Redis Streams (ticks) | BullMQ (EOD job) |
|---|---|---|
| Shape | Endless flow | One-shot batch |
| Frequency | Many per second | Once per day |
| What you need | Fan-out + ordering | Retries, scheduling, failure tracking |
| Cost of a lost message | Low (next tick is ms away) | High (a whole day's retrospection) |

Using BullMQ for ticks would mean one "job" per tick — absurd overhead. Using
raw Streams for the EOD job would mean re-implementing retries, scheduling, and
failure tracking yourself. Right tool, right shape.

## Current state

`bullmq` is declared in `package.json` (`^5.13.0`) but is **not yet imported
anywhere in `src/`** — the EOD retrospection engine is still a Sprint 1
skeleton. The split described here is the intended design. See the
[BullMQ & EOD job deep dive](../tech-stack.md#deep-dive-bullmq--the-eod-retrospection-job)
in the stack reference for how it will be wired.

## Related code
- `src/redis/client.ts` — Stream helpers (`streamPublish`, `streamRead`,
  `XGROUP` consumer-group helpers) and the shared `ioredis` client.
- `package.json` — `bullmq` dependency (not yet wired).
