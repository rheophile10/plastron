export const bitAnd  = ({ a, b }: { a: any; b: any }): number => a & b;
export const bitOr   = ({ a, b }: { a: any; b: any }): number => a | b;
export const bitXor  = ({ a, b }: { a: any; b: any }): number => a ^ b;
export const bitNot  = ({ a }: { a: any }): number => ~a;
export const lshift  = ({ a, b }: { a: any; b: any }): number => a << b;
export const rshift  = ({ a, b }: { a: any; b: any }): number => a >> b;
export const urshift = ({ a, b }: { a: any; b: any }): number => a >>> b;
