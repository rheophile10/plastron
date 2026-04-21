export type Key = string
export type varName = string

export interface Common {
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  key: Key;
}
