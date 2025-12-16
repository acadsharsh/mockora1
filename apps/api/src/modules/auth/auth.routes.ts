import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/env";
import { hashPassword, randomToken, sha256, verifyPassword } from "../../lib/security";
import { requireAuth, AuthedRequest } from "../../middleware/auth";

export const authRouter = Router();

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(72),
  name: z.string().min(1).max(80).optional()
});

authRouter.post("/register", async (req, res) => {
  const body = RegisterSchema.parse(req.body);

  const passwordHash = await hashPassword(body.password);

  const user = await prisma.user.create({
    data: {
      email: body.email.toLowerCase(),
      name: body.name,
      passwordHash
    },
    select: { id: true, email: true, role: true, name: true }
  });

  // Create session
  const raw = randomToken();
  const tokenHash = sha256(raw);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: { userId: user.id, tokenHash, expiresAt }
  });

  res.cookie(env.SESSION_COOKIE_NAME, raw, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    expires: expiresAt
  });

  return res.status(201).json({ user });
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(72)
});

authRouter.post("/login", async (req, res) => {
  const body = LoginSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
  if (!user) return res.status(401).json({ error: "INVALID_CREDENTIALS" });

  const ok = await verifyPassword(body.password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "INVALID_CREDENTIALS" });

  const raw = randomToken();
  const tokenHash = sha256(raw);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: { userId: user.id, tokenHash, expiresAt }
  });

  res.cookie(env.SESSION_COOKIE_NAME, raw, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    expires: expiresAt
  });

  return res.json({ user: { id: user.id, email: user.email, role: user.role, name: user.name } });
});

authRouter.post("/logout", requireAuth, async (req: AuthedRequest, res) => {
  const raw = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (raw) {
    await prisma.session.deleteMany({ where: { tokenHash: sha256(raw) } });
  }

  res.clearCookie(env.SESSION_COOKIE_NAME, { httpOnly: true, secure: true, sameSite: "none" });
  return res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  return res.json({ user: req.user });
});