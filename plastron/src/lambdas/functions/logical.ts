export const and     = ({ a, b }: { a: any; b: any }): boolean => a && b;
export const or      = ({ a, b }: { a: any; b: any }): boolean => a || b;
export const not     = ({ a }: { a: any }): boolean => !a;
export const nullish = ({ a, b }: { a: any; b: any }): unknown => a ?? b;
