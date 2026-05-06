export type Key = string
export type varName = string

// ========================================================================
// Provenance — optional origin metadata. Applied uniformly to anything
// keyed (cels, lambda metadata, segment metadata). Pure data; behaviour
// lives in segments that read these fields (audit logs, dialogue
// viewers, devtools).
// ========================================================================
export interface Provenance {
  /** Who/what produced this — "user", "agent:claude-opus-4.7", a github
   *  username, etc. Free-form string; conventions evolve. */
  authoredBy?: string;
  /** ISO-8601 timestamp at creation/regeneration. */
  generatedAt?: string;
  /** Reference to an agent dialogue cel that recorded the conversation
   *  producing this artifact. Lazy-loadable; not required at runtime. */
  promptId?: Key;
  /** Identifier of the agent model, when authoredBy points at an agent. */
  agentModel?: string;
}

export interface Common extends Provenance {
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  key: Key;
}
