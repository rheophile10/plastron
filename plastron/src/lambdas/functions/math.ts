export const mathMin   = ({ a, b }: { a: any; b: any }): number => Math.min(Number(a), Number(b));
export const mathMax   = ({ a, b }: { a: any; b: any }): number => Math.max(Number(a), Number(b));
export const mathRound = ({ a }: { a: any }): number => Math.round(Number(a));
export const mathFloor = ({ a }: { a: any }): number => Math.floor(Number(a));
export const mathCeil  = ({ a }: { a: any }): number => Math.ceil(Number(a));
export const mathAbs   = ({ a }: { a: any }): number => Math.abs(Number(a));
