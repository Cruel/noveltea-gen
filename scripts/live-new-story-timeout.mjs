/** Explicit wall-clock budget for opt-in complete-Story certification only.
 * Keep the test deadline ahead of the completion poll to allow evidence/cleanup.
 */
export const DEFAULT_FULL_STORY_TIMEOUT_MINUTES = 40;
export const MAX_FULL_STORY_TIMEOUT_MINUTES = 24 * 60;
const TEST_FINISH_GRACE_MINUTES = 5;
const MINUTE_MS = 60_000;

export function fullStoryTimeouts(raw) {
  if (
    raw !== undefined &&
    (!/^[1-9][0-9]*$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) > MAX_FULL_STORY_TIMEOUT_MINUTES)
  ) {
    throw Error("NT_TEST_WEB_PI_TIMEOUT_MINUTES must be an integer from 1 to 1440.");
  }
  const minutes = raw === undefined ? DEFAULT_FULL_STORY_TIMEOUT_MINUTES : Number(raw);
  return {
    minutes,
    monitorMs: minutes * MINUTE_MS,
    testMs: (minutes + TEST_FINISH_GRACE_MINUTES) * MINUTE_MS,
  };
}
