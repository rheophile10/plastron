import type { BaseCel, BaseCelMetadata } from "./cels.js";

export interface ValueCel extends BaseCel {
  celType: "ValueCel";
  metadata: BaseCelMetadata;
  wave?: number;
}
