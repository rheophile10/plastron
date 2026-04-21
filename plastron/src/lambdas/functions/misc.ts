export const join  = ({ a, b }: { a: any; b: any }): string =>
  Array.isArray(a) ? a.join(b ?? ",") : String(a);

export const split = ({ a, b }: { a: any; b: any }): string[] =>
  String(a).split(b ?? ",");

export const cond  = ({ a, b, c }: { a: any; b: any; c: any }): unknown => a ? b : c;

export const regex = ({ a, b }: { a: any; b: any }): string | null => {
  try {
    const m = String(a).match(new RegExp(String(b)));
    return m ? (m[1] ?? m[0]) : null;
  } catch {
    return null;
  }
};
