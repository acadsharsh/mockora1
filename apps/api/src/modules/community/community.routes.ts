import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { ContentStatus, ReportTargetType } from "@prisma/client";

export const communityRouter = Router();
communityRouter.use(requireAuth);

communityRouter.get("/questions/:questionId/solutions", async (req: AuthedRequest, res) => {
  const questionId = req.params.questionId;

  const posts = await prisma.solutionPost.findMany({
    where: { questionId, status: ContentStatus.VISIBLE },
    include: {
      author: { select: { id: true, name: true } },
      _count: { select: { upvotes: true, comments: true } }
    },
    orderBy: { createdAt: "desc" }
  });

  res.json({ posts });
});

const CreateSolutionSchema = z.object({
  bodyText: z.string().min(1).max(8000),
  imageUrl: z.string().url().optional()
});

communityRouter.post("/questions/:questionId/solutions", async (req: AuthedRequest, res) => {
  const questionId = req.params.questionId;
  const body = CreateSolutionSchema.parse(req.body);

  // Ensure question exists
  const q = await prisma.question.findUnique({ where: { id: questionId }, select: { id: true } });
  if (!q) return res.status(404).json({ error: "QUESTION_NOT_FOUND" });

  const post = await prisma.solutionPost.create({
    data: {
      questionId,
      authorId: req.user!.id,
      bodyText: body.bodyText,
      imageUrl: body.imageUrl ?? null
    }
  });

  res.status(201).json({ post });
});

// Toggle upvote
communityRouter.post("/solutions/:postId/upvote", async (req: AuthedRequest, res) => {
  const postId = req.params.postId;

  const post = await prisma.solutionPost.findUnique({ where: { id: postId } });
  if (!post || post.status !== ContentStatus.VISIBLE) return res.status(404).json({ error: "NOT_FOUND" });

  const existing = await prisma.solutionUpvote.findUnique({
    where: { postId_userId: { postId, userId: req.user!.id } }
  });

  if (existing) {
    await prisma.solutionUpvote.delete({ where: { postId_userId: { postId, userId: req.user!.id } } });
    return res.json({ upvoted: false });
  } else {
    await prisma.solutionUpvote.create({ data: { postId, userId: req.user!.id } });
    return res.json({ upvoted: true });
  }
});

communityRouter.get("/solutions/:postId/comments", async (req: AuthedRequest, res) => {
  const postId = req.params.postId;

  const post = await prisma.solutionPost.findUnique({ where: { id: postId } });
  if (!post || post.status !== ContentStatus.VISIBLE) return res.status(404).json({ error: "NOT_FOUND" });

  const comments = await prisma.solutionComment.findMany({
    where: { postId, status: ContentStatus.VISIBLE },
    include: { author: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" }
  });

  res.json({ comments });
});

const CreateCommentSchema = z.object({
  bodyText: z.string().min(1).max(2000)
});

communityRouter.post("/solutions/:postId/comments", async (req: AuthedRequest, res) => {
  const postId = req.params.postId;
  const body = CreateCommentSchema.parse(req.body);

  const post = await prisma.solutionPost.findUnique({ where: { id: postId } });
  if (!post || post.status !== ContentStatus.VISIBLE) return res.status(404).json({ error: "NOT_FOUND" });

  const comment = await prisma.solutionComment.create({
    data: {
      postId,
      authorId: req.user!.id,
      bodyText: body.bodyText
    }
  });

  res.status(201).json({ comment });
});

const ReportSchema = z.object({
  targetType: z.nativeEnum(ReportTargetType),
  targetId: z.string().min(1),
  reason: z.string().min(3).max(200),
  details: z.string().max(2000).optional()
});

communityRouter.post("/reports", async (req: AuthedRequest, res) => {
  const body = ReportSchema.parse(req.body);

  const report = await prisma.contentReport.create({
    data: {
      reporterId: req.user!.id,
      targetType: body.targetType,
      targetId: body.targetId,
      reason: body.reason,
      details: body.details ?? null
    }
  });

  res.status(201).json({ report });
});