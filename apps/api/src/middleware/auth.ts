import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { sha256 } from "../lib/security";
import { UserRole } from "@prisma/client";

export type AuthedRequest = Request & { user?: { id: string; role: UserRole; email: string } };

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "UNAUTHENTICATED" });

  const tokenHash = sha256(token);

  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true }
  });

  if (!session) return res.status(401).json({ error: "UNAUTHENTICATED" });
  if (session.expiresAt.getTime() < Date.now()) return res.status(401).json({ error: "SESSION_EXPIRED" });

  req.user = { id: session.user.id, role: session.user.role, email: session.user.email };
  return next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "UNAUTHENTICATED" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "FORBIDDEN" });
    next();
  };
}