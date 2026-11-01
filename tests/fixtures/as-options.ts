// A factory's options as a test writes them: fakes that carry the members the code reads, not every member of the
// interface they stand in for. `loose(createX)` is `createX` taking its options as an object, so a test passes the fakes
// as they are.

/** `factory` taking any object as its options. */
export function loose<F extends (first: never) => unknown>(factory: F): (options: object) => ReturnType<F> {
  // The one cast: the fakes in `options` stand in for the members of the real options.
  return (options) => (factory as unknown as (first: unknown) => ReturnType<F>)(options);
}
