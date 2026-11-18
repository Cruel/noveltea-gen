import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProposedQuestionSet, parseQuestionDrafts, parseQuestionResponses,
  initialQuestionDraft, questionDraftAnswer } from '../src/author-question-set.js';

const source = { questions: [
  { id: 'tone', kind: 'alternatives', question: 'What tone should shape the mystery?',
    options: [{ id: 'uneasy', title: 'Uneasy' }, { id: 'hopeful', title: 'Hopeful' }],
    recommendedId: 'uneasy', recommendationReason: 'Supports the premise',
    allowStudioDecision: true },
  { id: 'mechanics', kind: 'multiple-choice', question: 'Which mechanics sound interesting?',
    options: [{ id: 'investigate', title: 'Investigation' }, { id: 'explore', title: 'Exploration' }] },
  { id: 'length', kind: 'free-text', question: 'How long should one route take?',
    placeholder: 'E.g. about two hours' },
  { id: 'branch', kind: 'yes-no', question: 'Should the story have multiple endings?',
    recommendedId: 'yes' },
] };
const parsed = () => parseProposedQuestionSet(source, 'a'.repeat(64), 2);

test('question sets keep a trusted controller identity and do not accept model-created authority', () => {
  const set = parsed();
  assert.deepEqual(set.questions.map(q => q.id), ['tone', 'mechanics', 'length', 'branch']);
  assert.equal(initialQuestionDraft(set.questions[0]!).selection, '',
    'an agent request is not permission to delegate');
  assert.throws(() => parseProposedQuestionSet({ questions: [
    { ...source.questions[0], delegationAllowed: true },
  ] }, 'a'.repeat(64), 2), /Invalid bounded author question/);
  for (const patch of [
    { questions: [source.questions[0], source.questions[0]] },
    { questions: [{ ...source.questions[0], recommendedId: 'unknown' }] },
    { questions: [{ ...source.questions[0], kind: 'unsupported' }] },
    { questions: [{ ...source.questions[0], options: [{ id: 'foo', title: 'One' }] }] },
    { questions: [{ ...source.questions[0], dependsOn: 'another-id' }] },
  ]) assert.throws(() => parseProposedQuestionSet(patch, 'a'.repeat(64), 2));
});

test('typed drafts remain incomplete or provisional and only complete answers commit atomically', () => {
  const original = parsed();
  const set = { ...original, questions: original.questions.map(q =>
    q.id === 'tone' ? { ...q, delegationAllowed: true as const } : q) };
  assert.equal(initialQuestionDraft(set.questions[0]!).selection, '__delegate__');
  const drafts = {
    tone: initialQuestionDraft(set.questions[0]!),
    mechanics: { ...initialQuestionDraft(set.questions[1]!),
      selectedIds: ['investigate', 'explore'], multiCustom: true,
      customAnswer: 'Include peaceful observation' },
    length: { ...initialQuestionDraft(set.questions[2]!),
      customAnswer: 'Somewhat short, but not too short' },
    branch: { ...initialQuestionDraft(set.questions[3]!), selection: 'no' },
  };
  assert.deepEqual(parseQuestionDrafts(set, drafts), drafts);
  assert.equal(questionDraftAnswer(set.questions[0]!, drafts.tone)?.kind, 'delegate');
  assert.equal(questionDraftAnswer(set.questions[1]!, drafts.mechanics)?.kind, 'multiple');
  assert.equal(questionDraftAnswer(set.questions[2]!, drafts.length)?.kind, 'custom');
  assert.equal(questionDraftAnswer(set.questions[3]!, drafts.branch)?.kind, 'option');
  const answers = set.questions.map(q => ({ questionId: q.id,
    answer: questionDraftAnswer(q, drafts[q.id as keyof typeof drafts])! }));
  assert.deepEqual(parseQuestionResponses(set, [...answers].reverse()), answers);
  assert.throws(() => parseQuestionResponses(set, answers.slice(1)), /Every Question Set/);
  assert.throws(() => parseQuestionResponses(set, [answers[0], answers[0], ...answers.slice(2)]));
  assert.throws(() => parseQuestionResponses(set, [
    { questionId: 'tone', answer: { kind: 'option', optionId: 'fabricated', note: '' } },
    ...answers.slice(1),
  ]));
  assert.throws(() => parseQuestionResponses(set, [
    answers[0], answers[1], { questionId: 'length', answer: { kind: 'delegate', note: '' } },
    answers[3],
  ]), /Invalid author answer/);
  assert.throws(() => parseQuestionDrafts(set, { branch: {
    ...drafts.branch, selection: '__delegate__',
  } }), /Invalid or unauthorized/);
  assert.throws(() => parseQuestionDrafts(set, { mechanics: {
    ...drafts.mechanics, selectedIds: ['investigate', 'investigate'],
  } }), /Invalid or unauthorized/);
});
