import type { Key } from "./index.js";
import type { BaseCel, BaseCelMetadata } from "./cels.js";
import type { Compiler } from "./lambdas.js";

export interface CompilerCelMetadata extends BaseCelMetadata {
  kind?: string;
}

export interface CompilerCel extends BaseCel {
  celType: "CompilerCel";
  metadata: CompilerCelMetadata;
  v: Compiler;
  /** Compilers are locked by design — the type enforces it so setCel
   *  is rejected by the universal locked check in applyTripleAtomic. */
  locked: true;
  f?: string;
  _key?: Key;
}
