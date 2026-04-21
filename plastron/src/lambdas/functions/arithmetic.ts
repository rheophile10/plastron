// Arithmetic operators — binary and unary.
// All keyed; source strings captured in ../metadata.ts alongside schema/arity info.

export const add      = ({ a, b }: { a: any; b: any }): number => a + b;
export const subtract = ({ a, b }: { a: any; b: any }): number => a - b;
export const multiply = ({ a, b }: { a: any; b: any }): number => a * b;
export const divide   = ({ a, b }: { a: any; b: any }): number | null => b !== 0 ? a / b : null;
export const modulo   = ({ a, b }: { a: any; b: any }): number | null => b !== 0 ? a % b : null;
export const power    = ({ a, b }: { a: any; b: any }): number => a ** b;
