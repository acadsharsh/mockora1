import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "../../middleware/auth";
import { UserRole } from "@prisma/client";
import { isAttempted, isCorrect } from "../attempts/grading";

export const analysisRouter = Router();

/**
 * Student analysis for a submitted attempt
 * GET /v1/attempts/:attemptId/analysis
 */
analysisRouter.get(
  "/attempts/:attemptId/analysis",
  requireAuth,
  requireRole(UserRole.STUDENT),
  async (req: AuthedRequest, res) => {
    const attemptId = req.params.attemptId;

    const attempt = await prisma.attempt.findUnique({
      where: { id: attemptId },
      include: {
        test: {
          include: {
            sections: { orderBy: { sortOrder: "asc" } },
            testQuestions: {
              orderBy: { sortOrder: "asc" },
              include: { question: true, section: true }
            }
          }
        },
        answers: true,
        result: true
      }
    });

    if (!attempt) return res.status(404).json({ error: "NOT_FOUND" });
    if (attempt.studentId !== req.user!.id) return res.status(403).json({ error: "FORBIDDEN" });
    if (attempt.status !== "SUBMITTED") return res.status(409).json({ error: "ATTEMPT_NOT_SUBMITTED" });

    const answersByQ = new Map(attempt.answers.map(a => [a.questionId, a]));

    // Compute per-question + totals (authoritative, can be used even if AttemptResult missing)
    let score = 0;
    let maxScore = 0;
    let correctCount = 0;
    let wrongCount = 0;
    let unattemptedCount = 0;
    let totalTimeMs = 0;

    const perQuestion = attempt.test.testQuestions.map((tq, idx) => {
      const q = tq.question;
      const a = answersByQ.get(q.id);

      const marks = tq.marksOverride ?? q.marks;
      const negative = tq.negativeMarksOverride ?? q.negativeMarks;

      maxScore += marks;

      const responseJson = a?.responseJson ?? null;
      const attempted = isAttempted(q.type, responseJson);
      const correct = attempted ? isCorrect(q.type, q.answerKeyJson as any, responseJson) : false;

      let marksAwarded = 0;
      if (!attempted) {
        unattemptedCount += 1;
      } else if (correct) {
        correctCount += 1;
        marksAwarded = marks;
      } else {
        wrongCount += 1;
        marksAwarded = negative; // negative is usually -1
      }

      score += marksAwarded;

      const timeSpentMs = a?.timeSpentMs ?? 0;
      totalTimeMs += timeSpentMs;

      return {
        index: idx + 1,
        testQuestionId: tq.id,
        questionId: q.id,
        sectionId: tq.sectionId,
        sectionName: tq.section?.name ?? null,
        sortOrder: tq.sortOrder,

        type: q.type,
        subject: q.subject ?? "Unknown",
        chapter: q.chapter ?? null,
        difficulty: q.difficulty,

        promptImageUrl: q.promptImageUrl,

        visited: a?.visited ?? false,
        isMarked: a?.isMarked ?? false,
        responseJson,

        attempted,
        correct,
        marks,
        negative,
        marksAwarded,

        timeSpentMs,

        // After submission it’s fine to show these:
        correctAnswerKey: q.answerKeyJson,
        solutionText: q.solutionText ?? null,
        solutionImageUrl: q.solutionImageUrl ?? null
      };
    });

    const attemptedCount = correctCount + wrongCount;
    const accuracy = attemptedCount === 0 ? 0 : correctCount / attemptedCount;

    // Subject-wise breakup
    const subjectMap = new Map<
      string,
      { subject: string; correct: number; wrong: number; unattempted: number; score: number; maxScore: number; timeMs: number }
    >();

    for (const row of perQuestion) {
      const key = row.subject || "Unknown";
      if (!subjectMap.has(key)) {
        subjectMap.set(key, { subject: key, correct: 0, wrong: 0, unattempted: 0, score: 0, maxScore: 0, timeMs: 0 });
      }
      const s = subjectMap.get(key)!;
      s.maxScore += row.marks;
      s.timeMs += row.timeSpentMs;
      s.score += row.marksAwarded;
      if (!row.attempted) s.unattempted += 1;
      else if (row.correct) s.correct += 1;
      else s.wrong += 1;
    }

    const subjectBreakup = Array.from(subjectMap.values());

    // Optional: if AttemptResult is missing (older data), upsert it now (idempotent)
    if (!attempt.result) {
      await prisma.attemptResult.upsert({
        where: { attemptId: attempt.id },
        create: {
          attemptId: attempt.id,
          score,
          maxScore,
          correctCount,
          wrongCount,
          unattemptedCount,
          accuracy,
          totalTimeMs,
          subjectBreakupJson: subjectBreakup as any
        },
        update: {
          score,
          maxScore,
          correctCount,
          wrongCount,
          unattemptedCount,
          accuracy,
          totalTimeMs,
          subjectBreakupJson: subjectBreakup as any
        }
      });
    }

    return res.json({
      attempt: {
        id: attempt.id,
        testId: attempt.testId,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt,
        endsAt: attempt.endsAt,
        testTitle: attempt.test.title
      },
      summary: {
        score,
        maxScore,
        correctCount,
        wrongCount,
        unattemptedCount,
        attemptedCount,
        accuracy,
        totalTimeMs
      },
      subjectBreakup,
      perQuestion
    });
  }
);