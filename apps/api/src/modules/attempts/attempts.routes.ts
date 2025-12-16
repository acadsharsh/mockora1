import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest, requireRole } from "../../middleware/auth";
import { startAttempt, submitAttempt, upsertAnswer } from "./attempts.service";
import { prisma } from "../../lib/prisma";
import { UserRole } from "@prisma/client";

export const attemptsRouter = Router();

attemptsRouter.post("/tests/:testId/attempts/start", requireAuth, requireRole(UserRole.STUDENT), async (req: AuthedRequest, res) => {
  const attempt = await startAttempt(req.params.testId, req.user!.id);
  res.json({ attempt });
});

const UpsertAnswerSchema = z.object({
  responseJson: z.any().optional(),
  visited: z.boolean().optional(),
  isMarked: z.boolean().optional(),
  timeSpentMs: z.number().int().min(0).max(60 * 60 * 1000).optional()
});

attemptsRouter.put("/attempts/:attemptId/answers/:questionId", requireAuth, requireRole(UserRole.STUDENT), async (req: AuthedRequest, res) => {
  const body = UpsertAnswerSchema.parse(req.body);
  const ans = await upsertAnswer(req.params.attemptId, req.user!.id, req.params.questionId, body);
  res.json({ answer: ans });
});

attemptsRouter.post("/attempts/:attemptId/submit", requireAuth, requireRole(UserRole.STUDENT), async (req: AuthedRequest, res) => {
  const out = await submitAttempt(req.params.attemptId, req.user!.id);
  res.json({ attempt: out });
});

// Student-safe attempt payload for the exam engine
attemptsRouter.get("/attempts/:attemptId/overview", requireAuth, requireRole(UserRole.STUDENT), async (req: AuthedRequest, res) => {
  const attempt = await prisma.attempt.findUnique({
    where: { id: req.params.attemptId },
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
      answers: true
    }
  });
  if (!attempt) return res.status(404).json({ error: "NOT_FOUND" });
  if (attempt.studentId !== req.user!.id) return res.status(403).json({ error: "FORBIDDEN" });

  const answersByQ = new Map(attempt.answers.map(a => [a.questionId, a]));

  res.json({
    attempt: {
      id: attempt.id,
      status: attempt.status,
      startedAt: attempt.startedAt,
      endsAt: attempt.endsAt,
      test: {
        id: attempt.test.id,
        title: attempt.test.title,
        durationSec: attempt.test.durationSec,
        sections: attempt.test.sections.map(s => ({ id: s.id, name: s.name, sortOrder: s.sortOrder })),
        questions: attempt.test.testQuestions.map(tq => {
          const a = answersByQ.get(tq.questionId);
          return {
            testQuestionId: tq.id,
            questionId: tq.questionId,
            sectionId: tq.sectionId,
            sortOrder: tq.sortOrder,
            type: tq.question.type,
            promptImageUrl: tq.question.promptImageUrl,
            // palette state
            visited: a?.visited ?? false,
            isMarked: a?.isMarked ?? false,
            hasResponse: a?.responseJson != null,
			responseJson: a?.responseJson ?? null,
            timeSpentMs: a?.timeSpentMs ?? 0
          };
        })
      }
    }
  });
});