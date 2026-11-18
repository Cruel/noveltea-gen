/** Reusable, bounded author-question contract. No Job, execution or approval authority lives here. */
export type AuthorQuestionKind = "alternatives" | "yes-no" | "free-text";
export interface AuthorQuestionOption {
  id: string;
  title: string;
  /** Optional detail, exposed only when useful. */
  approach?: string;
  description?: string;
  benefits?: string;
  tradeoffs?: string;
}
export interface AuthorQuestion {
  /** Omitted for the existing specialist alternatives wire format. */
  kind?: AuthorQuestionKind;
  question: string;
  options?: AuthorQuestionOption[];
  recommendedId?: string;
  recommendationReason?: string;
  placeholder?: string;
  context?: Array<{ path: string; line: number; description: string }>;
}
export type AuthorQuestionAnswer =
  | { kind: "option"; optionId: string; note: string }
  | { kind: "custom"; text: string; note: string };

const ID = /^[a-z][a-z0-9]*(?:[a-z0-9-]*[a-z0-9])?$/;
const fixedOptions: AuthorQuestionOption[] = [
  { id: "yes", title: "Yes", approach: "", benefits: "", tradeoffs: "" },
  { id: "no", title: "No", approach: "", benefits: "", tradeoffs: "" },
];
const own = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown, max: number, min = 1): value is string =>
  typeof value === "string" && value.trim().length >= min && value.length <= max;
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key));

export function authorQuestionKind(question: AuthorQuestion): AuthorQuestionKind {
  return question.kind ?? "alternatives";
}
export function authorQuestionOptions(question: AuthorQuestion): AuthorQuestionOption[] {
  return authorQuestionKind(question) === "yes-no" ? fixedOptions : question.options ?? [];
}

/** Parse proposed question data, not an authorization. Reject unknown data rather than
 * accepting a model's invented permissions, references, or UI instructions. */
export function parseAuthorQuestion(value: unknown): AuthorQuestion {
  if (!own(value)) throw Error("Invalid author-question request.");
  const q = value;
  const kind = q.kind ?? "alternatives";
  if (typeof kind !== "string" ||
      !["free-text", "yes-no", "alternatives"].includes(kind) ||
      !bounded(q.question, 1500, 10) ||
      !hasOnly(q, ["kind", "question", "options", "recommendedId",
        "recommendationReason", "placeholder", "context"]))
    throw Error("Invalid bounded author question.");
  if (q.context !== undefined && (!Array.isArray(q.context) || q.context.length > 8 ||
      q.context.some(ref => !own(ref) ||
        Object.keys(ref).sort().join(",") !== "description,line,path" ||
        typeof ref.path !== "string" ||
        !/^[a-z][a-z0-9-]*\/[a-z0-9._-]+\.md$/.test(ref.path) ||
        !Number.isSafeInteger(ref.line) || (ref.line as number) < 1 || (ref.line as number) > 100000 ||
        !bounded(ref.description, 400))))
    throw Error("Author question context references must be bounded canonical Story locations.");
  if (q.placeholder !== undefined &&
      (kind !== "free-text" || !bounded(q.placeholder, 300)))
    throw Error("Invalid author-question placeholder.");
  if (q.recommendationReason !== undefined &&
      (!bounded(q.recommendationReason, 1200) || q.recommendedId === undefined))
    throw Error("Invalid author-question recommendation.");
  if (kind === "free-text" && (q.options !== undefined ||
      q.recommendedId !== undefined || q.recommendationReason !== undefined))
    throw Error("A free-text question cannot force suggested alternatives.");
  if (kind === "yes-no" && (q.options !== undefined ||
      q.recommendedId !== undefined && (typeof q.recommendedId !== "string" ||
        !["yes", "no"].includes(q.recommendedId))))
    throw Error("A Yes/No question has fixed Yes/No/Other choices.");
  let options: AuthorQuestionOption[] | undefined;
  if (kind === "alternatives") {
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8)
      throw Error("An author question requires 2–8 valid alternatives.");
    const ids = new Set<string>();
    options = q.options.map(raw => {
      if (!own(raw) || !hasOnly(raw, ["id", "title", "approach", "description", "benefits", "tradeoffs"]) ||
          typeof raw.id !== "string" || !ID.test(raw.id) || raw.id.length > 40 ||
          ids.has(raw.id) || !bounded(raw.title, 160) ||
          ["approach", "description", "benefits", "tradeoffs"].some(key =>
            raw[key] !== undefined && !bounded(raw[key], 700)))
        throw Error("Author alternatives need unique IDs, concise titles and bounded optional detail.");
      ids.add(raw.id);
      return { id: raw.id, title: raw.title as string,
        ...(raw.approach !== undefined ? { approach: raw.approach as string } : {}),
        ...(raw.description !== undefined ? { description: raw.description as string } : {}),
        ...(raw.benefits !== undefined ? { benefits: raw.benefits as string } : {}),
        ...(raw.tradeoffs !== undefined ? { tradeoffs: raw.tradeoffs as string } : {}) };
    });
    if (q.recommendedId !== undefined && (
      typeof q.recommendedId !== "string" || !ids.has(q.recommendedId)))
      throw Error("Recommended solution must be one of the offered alternatives.");
  }
  return {
    ...(q.kind !== undefined ? { kind: kind as AuthorQuestionKind } : {}),
    question: q.question as string,
    ...(options ? { options } : {}),
    ...(q.recommendedId !== undefined ? { recommendedId: q.recommendedId as string } : {}),
    ...(q.recommendationReason !== undefined ? { recommendationReason: q.recommendationReason as string } : {}),
    ...(q.placeholder !== undefined ? { placeholder: q.placeholder as string } : {}),
    ...(q.context !== undefined ? { context: q.context as AuthorQuestion["context"] } : {}),
  };
}

export function parseAuthorAnswer(question: AuthorQuestion, value: unknown): AuthorQuestionAnswer {
  if (!own(value) || !bounded(value.note, 1000, 0)) throw Error("Invalid author answer.");
  if (value.kind === "option" && hasOnly(value, ["kind", "optionId", "note"]) &&
      Object.keys(value).length === 3 && authorQuestionKind(question) !== "free-text" &&
      typeof value.optionId === "string" &&
      authorQuestionOptions(question).some(option => option.id === value.optionId))
    return { kind: "option", optionId: value.optionId, note: value.note as string };
  if (value.kind === "custom" && hasOnly(value, ["kind", "text", "note"]) &&
      Object.keys(value).length === 3 && bounded(value.text, 4000))
    return { kind: "custom", text: value.text as string, note: value.note as string };
  throw Error("Invalid author answer.");
}

/** Stable, readable projection for the original specialist. Structured answers remain authoritative. */
export function authorQuestionDirection(question: AuthorQuestion, answer: AuthorQuestionAnswer): string {
  const valid = parseAuthorAnswer(question, answer);
  if (valid.kind === "custom")
    return valid.text + (valid.note ? "\nAdditional guidance: " + valid.note : "");
  const option = authorQuestionOptions(question).find(o => o.id === valid.optionId)!;
  return JSON.stringify({ id: option.id, title: option.title,
    approach: option.approach ?? option.description ?? "" }) +
    (valid.note ? "\nAdditional guidance: " + valid.note : "");
}
