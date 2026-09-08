/** Compile-time exhaustiveness guard: fails to typecheck if `value` is not narrowed to `never`, i.e. if a switch/dispatch left a case unhandled. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
