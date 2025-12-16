import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { presignPutObject, publicUrlForKey } from "../../lib/storage";

export const assetsRouter = Router();

assetsRouter.use(requireAuth);

const PresignSchema = z.object({
  contentType: z.enum(["image/png", "image/jpeg", "image/webp"])
});

assetsRouter.post("/assets/images/presign", async (req: AuthedRequest, res) => {
  const body = PresignSchema.parse(req.body);

  const ext = body.contentType.split("/")[1];
  const key = `community-images/${req.user!.id}/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

  const uploadUrl = await presignPutObject({
    key,
    contentType: body.contentType,
    expiresSec: 300
  });

  res.json({
    key,
    uploadUrl,
    publicUrl: publicUrlForKey(key)
  });
});