import type { Key } from "./index.js";
import type { ComputeCel, ComputeCelMetadata } from "./cels.js";

export type SExp = number | string | SExp[];

export interface FormulaCelMetadata extends ComputeCelMetadata {
  parser?: Key;
}

export interface FormulaCel extends ComputeCel {
  celType: "FormulaCel";
  metadata: FormulaCelMetadata;
}
