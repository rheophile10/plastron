import { z } from "zod";

// ============================================================================
// 紋 (crack) — { pattern, intensity }. Two cracks compare equal when
// their pattern matches; the intensity is decoration. The schema's
// isChanged callback enforces this so that downstream cels (omen,
// tree) skip re-firing when only the intensity moves.
// ============================================================================

export const crackSchema = z.object({
  pattern:   z.enum(["X", "Y"]),
  intensity: z.number(),
});

export type Crack = z.infer<typeof crackSchema>;

export const CRACK_SCHEMA_KEY      = "crack" as const;
export const CRACK_IS_CHANGED_KEY  = "crackIsChanged" as const;
