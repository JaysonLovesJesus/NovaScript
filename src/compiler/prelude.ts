// Built-in prelude: Option<T> and Result<T, E> exist in every compilation
// unless --no-prelude is passed. They are injected into the checker's
// environment only — codegen emits just the constructors a program uses.

import type { EnumDecl } from './ast.js';

export const PRELUDE_ENUMS: EnumDecl[] = [
  {
    kind: 'enum',
    name: 'Option',
    typeParams: ['T'],
    isPub: true,
    variants: [
      { name: 'Some', fields: [{ kind: 'nominal', name: 'T' }] },
      { name: 'None' },
    ],
  },
  {
    kind: 'enum',
    name: 'Result',
    typeParams: ['T', 'E'],
    isPub: true,
    variants: [
      { name: 'Ok', fields: [{ kind: 'nominal', name: 'T' }] },
      { name: 'Err', fields: [{ kind: 'nominal', name: 'E' }] },
    ],
  },
];
