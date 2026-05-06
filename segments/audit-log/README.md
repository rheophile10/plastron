# `audit-log` segment

A reusable plastron segment that captures cycle activity into an append-only log cel. Useful for compliance audit trails, debugging, and the substrate beneath agent-dialogue or perf-tracking segments.

## What it does

Subscribes to plastron's hook surface and writes structured events into the `auditEvents` cel. Captures three kinds of events:

- **`lambda`** — every lambda invocation, with key, duration, and any error
- **`cycle`** — every cycle that produced changes, with the changed keys
- **`hydrate`** — every hydrate completion, with the runtime fingerprint

## Cels

- `auditEvents` — the append-only log (array of `AuditEvent`)
- `auditLogConfig` — `{ maxEntries: number; capture: AuditEventKind[] }`. Tune retention and capture set.

## Usage

```ts
import { runtime } from "plastron";
import { installAuditLog } from "audit-log";

const rt = await runtime(myCels, myLambdas, myFns);
await installAuditLog(rt);

// Later: read the log
const events = rt.Cels.get("auditEvents")!.v;
```

## Why it's a segment, not in core

Different applications want different logs — compliance, perf, agent dialogue, change history. Each is a hook subscriber that writes to its own cel. Audit-log is just one of these, kept generic and composable.
