import { QuestionType } from "@prisma/client";

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function isAttempted(type: QuestionType, responseJson: any): boolean {
  if (!responseJson) return false;
  if (type === "MCQ") return typeof responseJson.option === "number";
  if (type === "MSQ") return Array.isArray(responseJson.options) && responseJson.options.length > 0;
  if (type === "NUMERICAL") return typeof responseJson.value === "string" || typeof responseJson.value === "number";
  return false;
}

export function isCorrect(type: QuestionType, answerKeyJson: any, responseJson: any): boolean {
  if (!isAttempted(type, responseJson)) return false;

  if (type === "MCQ") {
    return responseJson.option === answerKeyJson.correctOption;
  }

  if (type === "MSQ") {
    const a = [...(answerKeyJson.correctOptions ?? [])].sort((x: number, y: number) => x - y);
    const b = [...(responseJson.options ?? [])].sort((x: number, y: number) => x - y);
    if (a.length !== b.length) return false;
    return a.every((v: number, i: number) => v === b[i]);
  }

  if (type === "NUMERICAL") {
    const resp = toNumberOrNull(responseJson.value);
    if (resp === null) return false;

    // Range-based key
    if (answerKeyJson.min !== undefined || answerKeyJson.max !== undefined) {
      const min = toNumberOrNull(answerKeyJson.min) ?? -Infinity;
      const max = toNumberOrNull(answerKeyJson.max) ?? Infinity;
      return resp >= min && resp <= max;
    }

    // Tolerance-based key
    const val = toNumberOrNull(answerKeyJson.value);
    const tol = toNumberOrNull(answerKeyJson.tolerance) ?? 0;
    if (val === null) return false;
    return Math.abs(resp - val) <= tol;
  }

  return false;
}