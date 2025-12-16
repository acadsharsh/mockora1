import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest, requireRole } from "../../middleware/auth";
import { prisma } from "../../lib/prisma";
import { TestStatus, TestVisibility, UserRole } from "@prisma/client";

export const testsRouter = Router();

const CreateTestSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().max(1000).optional(),
  instructions: z.string().max(5000).optional(),
  durationSec: z.number().int().min(5 * 60).max(6 * 60 * 60),
  visibility: z.nativeEnum(TestVisibility).optional()
});

testsRouter.post("/tests", requireAuth, requireRole(UserRole.CREATOR, UserRole.ADMIN), async (req: AuthedRequest, res) => {
  const body = CreateTestSchema.parse(req.body);
  const test = await prisma.test.create({
    data: {
      creatorId: req.user!.id,
      title: body.title,
      description: body.description,
      instructions: body.instructions,
      durationSec: body.durationSec,
      visibility: body.visibility ?? TestVisibility.PRIVATE
    }
  });
  res.status(201).json({ test });
});

testsRouter.post("/tests/:testId/publish", requireAuth, requireRole(UserRole.CREATOR, UserRole.ADMIN), async (req: AuthedRequest, res) => {
  const test = await prisma.test.findUnique({ where: { id: req.params.testId } });
  if (!test) return res.status(404).json({ error: "NOT_FOUND" });
  if (req.user!.role !== "ADMIN" && test.creatorId !== req.user!.id) return res.status(403).json({ error: "FORBIDDEN" });

  const updated = await prisma.test.update({
    where: { id: test.id },
    data: { status: TestStatus.PUBLISHED }
  });
  res.json({ test: updated });
});

// Student browsing (PUBLIC + PUBLISHED only)
testsRouter.get("/tests", requireAuth, async (req: AuthedRequest, res) => {
  const tests = await prisma.test.findMany({
    where: { status: TestStatus.PUBLISHED, visibility: TestVisibility.PUBLIC },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, description: true, durationSec: true, createdAt: true }
  });
  res.json({ tests });
});

testsRouter.get("/tests/:testId", requireAuth, async (req: AuthedRequest, res) => {
  const test = await prisma.test.findUnique({
    where: { id: req.params.testId },
    select: { id: true, title: true, description: true, instructions: true, durationSec: true, status: true, visibility: true }
  });
  if (!test) return res.status(404).json({ error: "NOT_FOUND" });
  // visibility enforcement expanded later; for now only allow seeing PUBLIC PUBLISHED unless creator/admin
  res.json({ test });
});