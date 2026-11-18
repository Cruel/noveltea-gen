/** Render trusted internal execution diagnostics without exposing the SDK name.
 * This only transforms controller-owned status/recovery text, never an author's
 * chat, questions, Story prose, or the underlying durable evidence. */
export function publicRuntimeText(value: string): string {
  return value.replace(/\bPi\b/g, 'model')
}
