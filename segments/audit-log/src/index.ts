import type {
  State, HookSubscription, DehydratedCel,
} from "../../../plastron/src/state/index.js";

// ========================================================================
// segment: audit-log
//
// A reusable segment that captures cycle activity into an append-only
// log cel. Subscribes to afterLambdaInvoke, afterCycle, and afterHydrate
// — every meaningful event the runtime emits.
//
// Records are plain JSON-shaped values. The capture set and max-entries
// retention are configurable via the auditLogConfig cel.
//
// Why a segment, not in core: this is observability tooling. Different
// applications want different logs (compliance audit, perf trace,
// agent dialogue, etc.) and they should compose in userland.
// ========================================================================

export const AUDIT_LOG_SEGMENT = "auditLog" as const;

export type AuditEventKind = "lambda" | "cycle" | "hydrate";

export interface AuditEvent {
  /** ISO-8601 timestamp at capture. */
  at: string;
  kind: AuditEventKind;
  data: unknown;
}

export interface AuditLogConfig {
  /** Cap on retained entries; oldest are evicted. */
  maxEntries: number;
  /** Which event kinds to capture. */
  capture: AuditEventKind[];
}

const DEFAULT_CONFIG: AuditLogConfig = {
  maxEntries: 1000,
  capture: ["lambda", "cycle", "hydrate"],
};

export const auditLogCels: Record<string, DehydratedCel> = {
  auditEvents: {
    key: "auditEvents",
    name: "Audit Events",
    description: "Append-only log of cycle activity for this runtime.",
    segment: AUDIT_LOG_SEGMENT,
    v: [] as AuditEvent[],
    dynamic: true,
  },
  auditLogConfig: {
    key: "auditLogConfig",
    name: "Audit Log Config",
    description: "Capture set + retention cap for the audit log.",
    segment: AUDIT_LOG_SEGMENT,
    v: DEFAULT_CONFIG,
  },
};

const append = (state: State, event: AuditEvent): void => {
  const cel = state.Cels.get("auditEvents");
  const cfg = state.Cels.get("auditLogConfig");
  if (!cel || !cfg) return;
  const config = (cfg.v ?? DEFAULT_CONFIG) as AuditLogConfig;
  if (!config.capture.includes(event.kind)) return;
  const events = ((cel.v ?? []) as AuditEvent[]).slice();
  events.push(event);
  if (events.length > config.maxEntries) {
    events.splice(0, events.length - config.maxEntries);
  }
  cel.v = events;
};

/** Hook subscription that appends cycle activity to the audit log. */
export const auditLogHook = (state: State): HookSubscription => ({
  id: "audit-log",
  afterLambdaInvoke: (e) => {
    append(state, {
      at: new Date().toISOString(),
      kind: "lambda",
      data: {
        key: e.key,
        durationMs: e.durationMs,
        ...(e.error !== undefined && { error: String(e.error) }),
      },
    });
  },
  afterCycle: (e) => {
    if (e.allChanges.length === 0) return;
    append(state, {
      at: new Date().toISOString(),
      kind: "cycle",
      data: { changedKeys: e.allChanges },
    });
  },
  afterHydrate: (e) => {
    append(state, {
      at: new Date().toISOString(),
      kind: "hydrate",
      data: { fingerprint: e.fingerprint },
    });
  },
});

/** Install the audit-log segment on an existing State. Hydrates the
 *  log cels and registers the hook subscription. Idempotent. */
export const installAuditLog = async (state: State): Promise<void> => {
  if (state.Cels.has("auditEvents")) return;
  await state.hydrate!(
    [auditLogCels],
    [],
    {},
    {
      segments: {
        [AUDIT_LOG_SEGMENT]: {
          key: AUDIT_LOG_SEGMENT,
          role: "metadata",
          loadByDefault: false,
          description: "Append-only audit log of cycle activity.",
        },
      },
      hooks: auditLogHook(state),
      installDefaults: false,
    },
  );
};
