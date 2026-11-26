import type { TestFn } from "node:test";

/** These test files share process.env and sandbox hooks. Node's test timeout
 * cancels the test, not its asynchronous body. Never start another scenario
 * in that process after an unfinished body has been cancelled. */
export function serialScenarioGuard() {
  let active: string | undefined;
  let interrupted: string | undefined;
  return (name: string, run: TestFn): TestFn => async context => {
    if (interrupted) {
      context.skip("Previous scenario was interrupted before cleanup: " + interrupted);
      return;
    }
    if (active) throw Error("Stateful scenarios must execute serially: " + active + " / " + name);
    active = name;
    const onAbort = () => { interrupted = name; };
    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await run(context);
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      active = undefined;
    }
  };
}
