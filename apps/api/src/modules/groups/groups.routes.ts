import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, AuthedRequest, requireRole } from "../../middleware/auth";
import { GroupMemberRole, UserRole } from "@prisma/client";
import { randomToken } from "../../lib/security";

export const groupsRouter = Router();

groupsRouter.use(requireAuth);

const CreateGroupSchema = z.object({
  name: z.string().min(3).max(80),
  description: z.string().max(500).optional()
});

groupsRouter.post("/groups", async (req: AuthedRequest, res) => {
  const body = CreateGroupSchema.parse(req.body);

  const group = await prisma.group.create({
    data: {
      ownerId: req.user!.id,
      name: body.name,
      description: body.description,
      members: {
        create: { userId: req.user!.id, role: GroupMemberRole.OWNER }
      }
    }
  });

  res.status(201).json({ group });
});

groupsRouter.get("/groups", async (req: AuthedRequest, res) => {
  const groups = await prisma.group.findMany({
    where: {
      members: { some: { userId: req.user!.id } }
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      description: true,
      ownerId: true,
      updatedAt: true,
      _count: { select: { members: true } }
    }
  });

  res.json({ groups });
});

groupsRouter.get("/groups/:groupId", async (req: AuthedRequest, res) => {
  const groupId = req.params.groupId;

  const membership = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: req.user!.id } }
  });
  if (!membership) return res.status(403).json({ error: "FORBIDDEN" });

  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: {
      members: { include: { user: { select: { id: true, email: true, name: true, role: true } } } },
      assignments: { include: { test: { select: { id: true, title: true, durationSec: true, status: true, visibility: true } } } }
    }
  });

  if (!group) return res.status(404).json({ error: "NOT_FOUND" });

  res.json({ group, myRole: membership.role });
});

const CreateInviteSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365).optional(),
  maxUses: z.number().int().min(1).max(500).optional()
});

groupsRouter.post("/groups/:groupId/invites", async (req: AuthedRequest, res) => {
  const groupId = req.params.groupId;
  const body = CreateInviteSchema.parse(req.body);

  const membership = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: req.user!.id } }
  });
  if (!membership) return res.status(403).json({ error: "FORBIDDEN" });
  if (![GroupMemberRole.OWNER, GroupMemberRole.MOD].includes(membership.role)) {
    return res.status(403).json({ error: "FORBIDDEN" });
  }

  const code = randomToken(18);
  const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000) : null;

  const invite = await prisma.groupInvite.create({
    data: {
      groupId,
      createdById: req.user!.id,
      code,
      expiresAt,
      maxUses: body.maxUses ?? null
    }
  });

  res.status(201).json({ invite });
});

groupsRouter.post("/invites/:code/join", async (req: AuthedRequest, res) => {
  const code = req.params.code;

  const invite = await prisma.groupInvite.findUnique({
    where: { code },
    include: { group: true }
  });
  if (!invite) return res.status(404).json({ error: "INVALID_INVITE" });
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return res.status(410).json({ error: "INVITE_EXPIRED" });
  if (invite.maxUses !== null && invite.usesCount >= invite.maxUses) return res.status(410).json({ error: "INVITE_EXHAUSTED" });

  await prisma.$transaction(async (tx) => {
    await tx.groupMember.upsert({
      where: { groupId_userId: { groupId: invite.groupId, userId: req.user!.id } },
      create: { groupId: invite.groupId, userId: req.user!.id, role: GroupMemberRole.MEMBER },
      update: {} // already a member
    });

    await tx.groupInvite.update({
      where: { id: invite.id },
      data: { usesCount: { increment: 1 } }
    });
  });

  res.json({ ok: true, groupId: invite.groupId });
});

// Assign test to group (Creator/Admin)
groupsRouter.post(
  "/groups/:groupId/tests/:testId/assign",
  requireRole(UserRole.CREATOR, UserRole.ADMIN),
  async (req: AuthedRequest, res) => {
    const { groupId, testId } = req.params;

    // group membership required (owner/mod) OR admin
    if (req.user!.role !== UserRole.ADMIN) {
      const m = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: req.user!.id } } });
      if (!m || ![GroupMemberRole.OWNER, GroupMemberRole.MOD].includes(m.role)) {
        return res.status(403).json({ error: "FORBIDDEN" });
      }
    }

    // must own the test unless admin
    const test = await prisma.test.findUnique({ where: { id: testId } });
    if (!test) return res.status(404).json({ error: "TEST_NOT_FOUND" });
    if (req.user!.role !== UserRole.ADMIN && test.creatorId !== req.user!.id) {
      return res.status(403).json({ error: "FORBIDDEN" });
    }

    const assignment = await prisma.groupTestAssignment.upsert({
      where: { groupId_testId: { groupId, testId } },
      create: { groupId, testId, assignedById: req.user!.id },
      update: {}
    });

    res.status(201).json({ assignment });
  }
);

// Group leaderboard for a test
groupsRouter.get("/groups/:groupId/leaderboard", async (req: AuthedRequest, res) => {
  const groupId = req.params.groupId;
  const testId = String(req.query.testId || "");

  if (!testId) return res.status(400).json({ error: "testId_required" });

  const membership = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: req.user!.id } }
  });
  if (!membership) return res.status(403).json({ error: "FORBIDDEN" });

  // Ensure test assigned to group
  const assigned = await prisma.groupTestAssignment.findUnique({
    where: { groupId_testId: { groupId, testId } }
  });
  if (!assigned) return res.status(404).json({ error: "TEST_NOT_ASSIGNED" });

  // Leaderboard: only group members, submitted attempts, ordered by score desc then submittedAt asc
  const rows = await prisma.attempt.findMany({
    where: {
      testId,
      status: "SUBMITTED",
      student: { groupMemberships: { some: { groupId } } }
    },
    include: {
      student: { select: { id: true, name: true, email: true } },
      result: true
    },
    orderBy: [
      { result: { score: "desc" } },
      { submittedAt: "asc" }
    ],
    take: 200
  });

  const leaderboard = rows
    .filter(r => r.result)
    .map((r, i) => ({
      rank: i + 1,
      student: r.student,
      score: r.result.score,
      maxScore: r.result.maxScore,
      accuracy: r.result.accuracy,
      submittedAt: r.submittedAt
    }));

  res.json({ leaderboard });
});