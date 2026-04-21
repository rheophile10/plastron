export const length  = ({ a }: { a: any }): number =>
  Array.isArray(a) ? a.length : typeof a === "string" ? a.length : Object.keys(a ?? {}).length;

export const range   = ({ a, b }: { a: any; b: any }): number[] => {
  const r: number[] = [];
  for (let i = a; i < b; i++) r.push(i);
  return r;
};

export const flatten = ({ a }: { a: any }): unknown[] =>
  Array.isArray(a) ? a.flat() : [a];

export const slice   = ({ a, b, c }: { a: any; b: any; c: any }): unknown =>
  Array.isArray(a) || typeof a === "string" ? a.slice(b, c) : null;

export const where   = ({ a, b, c }: { a: any; b: any; c: any }): unknown =>
  Array.isArray(a) ? a.find((item: any) => item?.[b] === c) ?? null : null;

export const pluck   = ({ a, b }: { a: any; b: any }): unknown[] | null =>
  Array.isArray(a) ? a.map((item: any) => item?.[b]) : null;
