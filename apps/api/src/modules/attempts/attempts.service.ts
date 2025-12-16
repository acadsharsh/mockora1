import { prisma } from "../../lib/prisma";
import { AttemptStatus, TestStatus, TestVisibility } from "@prisma/client";
import { isAttempted, isCorrect } from "./grading";

export async function startAttempt(testId: string, studentId: string) {
  const test = await prisma.test.findUnique({
    where: { id: testId },
    include: {
      testQuestions: {
        orderBy: { sortOrder: "asc" },
        include: { question: true, section: true }
      }
    }
  });
  if (!test) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });

  if (test.status !== TestStatus.PUBLISHED) {
    throw Object.assign(new Error("TEST_NOT_AVAILABLE"), { status: 403 });
  }
  if (test.visibility === TestVisibility.PUBLIC) {
  // ok
} else if (test.visibility === TestVisibility.PRIVATE) {
  // only creator/admin (students cannot)
  throw Object.assign(new Error("TEST_NOT_AVAILABLE"), { status: 403 });
} else if (test.visibility === TestVisibility.GROUP_ONLY) {
  const membership = await prisma.groupMember.findFirst({
    where: {
      userId: studentId,
      group: {
        assignments: {
          some: { testId: test.id }
        }
      }
    }
  });

  if (!membership) {
    throw Object.assign(new Error("TEST_NOT_AVAILABLE"), { status: 403 });
  }
}

  const endsAt = new Date(Date.now() + test.durationSec * 1000);

  // One active attempt per (test, student) is a sane default
  const existing = await prisma.attempt.findFirst({
    where: { testId, studentId, status: AttemptStatus.IN_PROGRESS }
  });
  if (existing) return existing;

  return prisma.attempt.create({
    data: { testId, studentId, endsAt }
  });
}

export async function upsertAnswer(attemptId: string, studentId: string, questionId: string, patch: {
  responseJson?: any;
  visited?: boolean;
  isMarked?: boolean;
  timeSpentMs?: number;
}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
  if (attempt.studentId !== studentId) throw Object.assign(new Error("FORBIDDEN"), { status: 403 });
  if (attempt.status !== "IN_PROGRESS") throw Object.assign(new Error("ATTEMPT_LOCKED"), { status: 409 });
  if (attempt.endsAt.getTime() < Date.now()) throw Object.assign(new Error("ATTEMPT_EXPIRED"), { status: 409 });

  await prisma.attempt.update({
    where: { id: attemptId },
    data: { lastSeenAt: new Date() }
  });

  return prisma.attemptAnswer.upsert({
    where: { attemptId_questionId: { attemptId, questionId } },
    create: {
      attemptId,
      questionId,
      responseJson: patch.responseJson ?? null,
      visited: patch.visited ?? true,
      isMarked: patch.isMarked ?? false,
      timeSpentMs: patch.timeSpentMs ?? 0
    },
    update: {
      responseJson: patch.responseJson ?? undefined,
      visited: patch.visited ?? undefined,
      isMarked: patch.isMarked ?? undefined,
      timeSpentMs: patch.timeSpentMs ?? undefined
    }
  });
}

export async function submitAttempt(attemptId: string, studentId: string) {
  // Load attempt + all questions + answers
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      test: {
        include: {
          testQuestions: {
            orderBy: { sortOrder: "asc" },
            include: { question: true }
          }
        }
      },
      answers: true,
      result: true
    }
  });
  if (!attempt) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
  if (attempt.studentId !== studentId) throw Object.assign(new Error("FORBIDDEN"), { status: 403 });
  if (attempt.status !== "IN_PROGRESS") return attempt; // idempotent

  // Compute grading
  const answersByQ = new Map(attempt.answers.map(a => [a.questionId, a]));
  let score = 0;
  let maxScore = 0;
  let correctCount = 0;
  let wrongCount = 0;
  let unattemptedCount = 0;

  for (const tq of attempt.test.testQuestions) {
    const q = tq.question;
    const a = answersByQ.get(q.id);

    const marks = tq.marksOverride ?? q.marks;
    const negative = tq.negativeMarksOverride ?? q.negativeMarks;
    maxScore += marks;

    const resp = a?.responseJson ?? null;

    if (!isAttempted(q.type, resp)) {
      unattemptedCount += 1;
      continue;
    }

    if (isCorrect(q.type, q.answerKeyJson as any, resp)) {
      score += marks;
      correctCount += 1;
    } else {
      score += negative;
      wrongCount += 1;
    }
  }

  const attempted = correctCount + wrongCount;
  const accuracy = attempted === 0 ? 0 : correctCount / attempted;

  const totalTimeMs = attempt.answers.reduce((sum, x) => sum + (x.timeSpentMs ?? 0), 0);

  return prisma.$transaction(async (tx) => {
    await tx.attempt.update({
      where: { id: attemptId },
      data: {
        status: "SUBMITTED",
        submittedAt: new Date()
      }
    });

    await tx.attemptResult.upsert({
      where: { attemptId },
      create: {
        attemptId,
        score,
        maxScore,
        correctCount,
        wrongCount,
        unattemptedCount,
        accuracy,
        totalTimeMs
      },
      update: {
        score,
        maxScore,
        correctCount,
        wrongCount,
        unattemptedCount,
        accuracy,
        totalTimeMs
      }
    });

    return tx.attempt.findUnique({
      where: { id: attemptId },
      include: { result: true }
    });
  });
}