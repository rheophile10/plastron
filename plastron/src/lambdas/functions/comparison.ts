export const eq        = ({ a, b }: { a: any; b: any }): boolean => a == b;
export const strictEq  = ({ a, b }: { a: any; b: any }): boolean => a === b;
export const neq       = ({ a, b }: { a: any; b: any }): boolean => a != b;
export const strictNeq = ({ a, b }: { a: any; b: any }): boolean => a !== b;
export const lt        = ({ a, b }: { a: any; b: any }): boolean => a < b;
export const gt        = ({ a, b }: { a: any; b: any }): boolean => a > b;
export const lte       = ({ a, b }: { a: any; b: any }): boolean => a <= b;
export const gte       = ({ a, b }: { a: any; b: any }): boolean => a >= b;
