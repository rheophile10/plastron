import type { Cel } from "./cels.js";
import type { Fn } from "./lambdas.js";
import type { Key } from "./index.js";
import type { 甲骨, 冊 } from "./甲骨.js";

export interface State {
  cels: Map<Key, Cel>;
  precomputeGeneration: number;
  segments: Map<Key, 冊>;
}

export type Hydrate = (
  state: State,
  segments: 甲骨[],
  manifests: 冊[],
) => Promise<State>;

export type Dehydrate = (state: State) => { segments: 甲骨[]; manifests: 冊[] };

// Readable/writable body of a fireable cel: its value and (optionally)
// its formula source. Compiler selection lives on cel.metadata
// (FormulaCel.compiler / LambdaCel.kind) and is not part of the body;
// swap it by constructing a new cel.
export interface CelBody {
  v?: unknown;
  f?: string | null;
}

export interface RegisterLambdaArgs {
  key: Key;
  // Cel segment for the registered lambda. Defaults to "default", so
  // user-registered lambdas dehydrate alongside other user cels.
  segment?: Key;
  fn?: Fn;
  source?: string;
  kind?: string;
  inputSchema?: Key;
  outputSchema?: Key;
  extractDeps?: (source: string) => Key[];
  dispose?: () => void;
  locked?: boolean;
}
