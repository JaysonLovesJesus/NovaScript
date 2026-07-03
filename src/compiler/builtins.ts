// Built-in free functions (README §10.5). These compile directly to JS host
// calls — no runtime library is emitted. Each maps a NovaScript name to its
// arity (all numeric params, numeric result) and the JS expression it emits.

export interface MathBuiltin {
  arity: number;
  js: string;
}

export const MATH_BUILTINS: Record<string, MathBuiltin> = {
  sqrt: { arity: 1, js: 'Math.sqrt' },
  abs: { arity: 1, js: 'Math.abs' },
  floor: { arity: 1, js: 'Math.floor' },
  ceil: { arity: 1, js: 'Math.ceil' },
  round: { arity: 1, js: 'Math.round' },
  sin: { arity: 1, js: 'Math.sin' },
  cos: { arity: 1, js: 'Math.cos' },
  min: { arity: 2, js: 'Math.min' },
  max: { arity: 2, js: 'Math.max' },
  pow: { arity: 2, js: 'Math.pow' },
  random: { arity: 0, js: 'Math.random' },
};
