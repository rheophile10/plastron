export const get     = ({ a, b }: { a: any; b: any }): unknown => a?.[b] ?? null;
export const set     = ({ a, b, c }: { a: any; b: any; c: any }): unknown => ({ ...a, [b]: c });
export const keys    = ({ a }: { a: any }): string[] => Object.keys(a ?? {});
export const values  = ({ a }: { a: any }): unknown[] => Object.values(a ?? {});
export const entries = ({ a }: { a: any }): [string, unknown][] => Object.entries(a ?? {});
export const merge   = ({ a, b }: { a: any; b: any }): unknown => ({ ...a, ...b });
export const has     = ({ a, b }: { a: any; b: any }): boolean => a != null && b in a;
