export const concat     = ({ a, b }: { a: any; b: any }): string => String(a) + String(b);
export const includes   = ({ a, b }: { a: any; b: any }): boolean => String(a).includes(String(b));
export const startsWith = ({ a, b }: { a: any; b: any }): boolean => String(a).startsWith(String(b));
export const endsWith   = ({ a, b }: { a: any; b: any }): boolean => String(a).endsWith(String(b));
