import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "../../middleware/auth";
import { ContentStatus, ReportStatus, UserRole } from "@prisma/client";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole(UserRole.ADMIN));

adminRouter.get("/admin/reports", async (_req, res) => {
  const reports = await prisma.contentReport.findMany({
    where: { status: ReportStatus.OPEN },
    orderBy: { createdAt: "desc" },
    include: {
      reporter: { select: { id: true, name: true, email: true } }
    },
    take: 200
  });
  res.json({ reports });
});

const ResolveSchema = z.object({
  status: z.enum(["RESOLVED", "DISMISSED"]),
  resolutionNote: z.string().max(2000).optional()
});

adminRouter.post("/admin/reports/:reportId/resolve", async (req: AuthedRequest, res) => {
  const body = ResolveSchema.parse(req.body);

  const updated = await prisma.contentReport.update({
    where: { id: req.params.reportId },
    data: {
      status: body.status as any,
      resolvedAt: new Date(),
      resolvedById: req.user!.id,
      resolutionNote: body.resolutionNote ?? null
    }
  });

  res.json({ report: updated });
});

// Hide/unhide/delete solution posts
adminRouter.post("/admin/solutions/:postId/status", async (req, res) => {
  const Body = z.object({ status: z.nativeEnum(ContentStatus) }).parse(req.body);

  const post = await prisma.solutionPost.update({
    where: { id: req.params.postId },
    data: { status: Body.status }
  });

  res.json({ post });
});

// Hide/unhide/delete comments
adminRouter.post("/admin/comments/:commentId/status", async (req, res) => {
  const Body = z.object({ status: z.nativeEnum(ContentStatus) }).parse(req.body);

  const comment = await prisma.solutionComment.update({
    where: { id: req.params.commentId },
    data: { status: Body.status }
  });

  res.json({ comment });
});