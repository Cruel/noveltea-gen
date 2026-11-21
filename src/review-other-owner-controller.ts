/** One controller-owned continuation after a rejected original specialist asks
 * for other-owner work. This is intentionally not a second writer scheduler:
 * each external phase has its own authenticated dependency-plan receipt.
 * Failed results and thrown errors are equally non-authorizing. */
export async function settleOtherOwnerPrerequisite(input: {
  admit: () => Promise<void>;
  support: () => Promise<{ status: string }>;
  independentlyCovered: () => Promise<boolean>;
}): Promise<void> {
  await input.admit();
  const result = await input.support();
  if (result.status !== "dependency-verified")
    throw Error("Other-owner prerequisite has not completed both independent specialist reviews.");
  if (!await input.independentlyCovered())
    throw Error("Original failed checkpoint has no authenticated positive successor coverage.");
}
