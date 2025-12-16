import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { env } from "./lib/env";
import { authRouter } from "./modules/auth/auth.routes";
import { testsRouter } from "./modules/tests/tests.routes";
import { attemptsRouter } from "./modules/attempts/attempts.routes";
import { creatorRouter } from "./modules/creator/creator.routes";
import { analysisRouter } from "./modules/analysis/analysis.routes";
import { assetsRouter } from "./modules/assets/assets.routes";
import { groupsRouter } from "./modules/groups/groups.routes";
import { communityRouter } from "./modules/community/community.routes";
import { adminRouter } from "./modules/admin/admin.routes";

export function makeServer() {
  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());

  app.use(cors({
    origin: env.WEB_ORIGIN,
    credentials: true
  }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/v1/auth", authRouter);
  app.use("/v1", testsRouter);
  app.use("/v1", attemptsRouter);
  app.use("/v1/creator", creatorRouter);
  app.use("/v1", analysisRouter);
  app.use("/v1", assetsRouter);
  app.use("/v1", groupsRouter);
  app.use("/v1", communityRouter);
  app.use("/v1", adminRouter);

  // basic error boundary
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err?.status ?? 500;
    const message = err?.message ?? "INTERNAL_ERROR";
    res.status(status).json({ error: message });
  });

  return app;
}