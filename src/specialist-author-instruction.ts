/** The controller-owned generation request, not a Pi suggestion, supplies this
 * instruction. It is advisory *within* the existing stage's narrowly permitted
 * file set; it never changes the completion contract, protected decisions or
 * the specialist's independent Git and canonical validation gates. */
export function specialistAuthorInstruction(task?: string): string {
  if (task === undefined) return ''
  if (typeof task !== 'string' || !task.trim() || task.length > 4000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(task))
    throw new Error('Specialist requires a printable, bounded controller-pinned author instruction.')
  return '\nCURRENT AUTHOR INSTRUCTION (scope-bound, not additional write authority):\n' +
    task.trim() +
    '\nImplement the portions relevant to THIS assigned specialist only. ' +
    'If the instruction requires a protected retcon, unapproved record, or wider path scope, ' +
    'report the conflict and stop; do not silently ignore the correction or expand authority.\n'
}
