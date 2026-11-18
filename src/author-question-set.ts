import { authorQuestionKind, authorQuestionOptions, parseAuthorAnswer, parseAuthorQuestion,
  type AuthorQuestion, type AuthorQuestionAnswer } from './author-question.js';

/** A model may propose questions, but not set identity, session revision or authority. */
export type QuestionItem = AuthorQuestion & { id: string;
  /** Trusted workflow permission; never accepted from a model proposal. */
  delegationAllowed?: true };
export type QuestionSet = { id: string; revision: number; questions: QuestionItem[] };
export type QuestionResponse = { questionId: string; answer: AuthorQuestionAnswer };
export type QuestionDraft = {
  selection: string; selectedIds: string[]; multiCustom: boolean;
  customAnswer: string; note: string;
};
const ID = /^[a-z][a-z0-9]*(?:[a-z0-9-]*[a-z0-9])?$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every(key => allowed.includes(key));

export function parseProposedQuestionSet(value: unknown, id: string, revision: number): QuestionSet {
  if (!object(value) || !keys(value, ['questions']) || !Array.isArray(value.questions) ||
      value.questions.length < 1 || value.questions.length > 16 ||
      !/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(revision) || revision < 1)
    throw Error('Invalid bounded discovery Question Set.');
  const seen = new Set<string>();
  const questions = value.questions.map(raw => {
    if (!object(raw) || typeof raw.id !== 'string' || !ID.test(raw.id) ||
        raw.id.length > 40 || seen.has(raw.id))
      throw Error('Question IDs must be stable, unique and bounded.');
    seen.add(raw.id);
    const { id: questionId, ...content } = raw;
    return { id: questionId, ...parseAuthorQuestion(content) };
  });
  return { id, revision, questions };
}

export function initialQuestionDraft(question: QuestionItem): QuestionDraft {
  return { selection: question.delegationAllowed === true ? '__delegate__' : '',
    selectedIds: [], multiCustom: false, customAnswer: '', note: '' };
}

/** Drafts may be incomplete; parsing them never grants consent or delegation. */
export function parseQuestionDrafts(set: QuestionSet, value: unknown): Record<string, QuestionDraft> {
  if (!object(value) || Object.keys(value).length > set.questions.length)
    throw Error('Invalid bounded discovery draft.');
  const output: Record<string, QuestionDraft> = {};
  for (const [id, draft] of Object.entries(value)) {
    const question = set.questions.find(q => q.id === id);
    if (!question || !object(draft) ||
        !keys(draft, ['selection', 'selectedIds', 'multiCustom', 'customAnswer', 'note']) ||
        typeof draft.selection !== 'string' || !Array.isArray(draft.selectedIds) ||
        typeof draft.multiCustom !== 'boolean' || typeof draft.customAnswer !== 'string' ||
        draft.customAnswer.length > 4000 || typeof draft.note !== 'string' ||
        draft.note.length > 1000 ||
        !draft.selectedIds.every((option: unknown) => typeof option === 'string' &&
          authorQuestionOptions(question).some(o => o.id === option)) ||
        new Set(draft.selectedIds).size !== draft.selectedIds.length ||
        !['', '__delegate__', '__custom__', '__answer__',
          ...authorQuestionOptions(question).map(o => o.id)].includes(draft.selection) ||
        (draft.selection === '__delegate__' && question.delegationAllowed !== true))
      throw Error('Invalid or unauthorized Question Set draft.');
    output[id] = draft as QuestionDraft;
  }
  return output;
}

/** The same shared answer parser is used by specialist and discovery adapters. */
export function questionDraftAnswer(question: QuestionItem, draft: QuestionDraft): AuthorQuestionAnswer | null {
  const kind = authorQuestionKind(question);
  const proposed: AuthorQuestionAnswer = draft.selection === '__delegate__'
    ? { kind: 'delegate', note: draft.note }
    : kind === 'multiple-choice'
      ? { kind: 'multiple', optionIds: draft.selectedIds,
        ...(draft.multiCustom ? { text: draft.customAnswer } : {}), note: draft.note }
      : kind === 'free-text' || draft.selection === '__custom__'
        ? { kind: 'custom', text: draft.customAnswer, note: draft.note }
        : { kind: 'option', optionId: draft.selection, note: draft.note };
  try { return parseAuthorAnswer(question, proposed, question.delegationAllowed === true); }
  catch { return null; }
}

/** Entire batch is checked before a single session CAS; no partial decision writes. */
export function parseQuestionResponses(set: QuestionSet, value: unknown): QuestionResponse[] {
  if (!Array.isArray(value) || value.length !== set.questions.length)
    throw Error('Every Question Set item needs an answer or authorized delegation.');
  const byId = new Map<string, AuthorQuestionAnswer>();
  for (const item of value) {
    if (!object(item) || !keys(item, ['questionId', 'answer']) ||
        typeof item.questionId !== 'string' || byId.has(item.questionId))
      throw Error('Duplicate or malformed Question Set response.');
    const question = set.questions.find(q => q.id === item.questionId);
    if (!question) throw Error('Response does not belong to this Question Set.');
    byId.set(item.questionId, parseAuthorAnswer(question, item.answer,
      question.delegationAllowed === true));
  }
  return set.questions.map(q => ({ questionId: q.id, answer: byId.get(q.id)! }));
}
