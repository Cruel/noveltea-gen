/** A narrow, author-expressed stopping rule. Never turn a request for a game
 * or complete Story into a foundation-only Turn by guessing from shortness. */
export function foundationOnlyObjective(objective: string): boolean {
  const task = objective.trim().toLowerCase();
  if (!task || /\b(?:full|complete|entire)\s+(?:story|game|visual novel)\b/.test(task))
    return false;
  const deliverable = /\b(?:creative direction|story foundation|foundation document|premise|story concept|concept pitch)\b/;
  const bounded = /\b(?:only|just|nothing (?:else|more)|stop (?:there|after)|no (?:story|game|scenes|chapters))\b/;
  const directGame = /^(?:please\s+)?(?:make|create|write|generate|build)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:[a-z-]+\s+){0,3}(?:game|visual novel|full story)\b/;
  return deliverable.test(task) && bounded.test(task) && !directGame.test(task) &&
    !/\b(?:then|also)\s+(?:make|create|write|generate|build)\b/.test(task);
}
