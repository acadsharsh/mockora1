import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { supabase, sbEnv, publicUrlForPath } from "../../lib/supabase";
import crypto from "crypto";

export const assetsRouter = Router();
assetsRouter.use(requireAuth);

// Memory storage: file stays in RAM during upload then is sent to Supabase
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 } // 6 MB
});

const UploadMetaSchema = z.object({
  // optional logical grouping
  folder: z.enum(["question-images", "community-images"]).default("community-images")
});

/**
 * POST /v1/assets/images/upload
 * multipart/form-data:
 *   - file: image file (png/jpeg/webp)
 *   - folder: "question-images" | "community-images" (optional)
 */
assetsRouter.post("/assets/images/upload", upload.single("file"), async (req: AuthedRequest, res) => {
  const meta = UploadMetaSchema.parse(req.body || {});
  const f = req.file;

  if (!f) return res.status(400).json({ error: "file_required" });

  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(f.mimetype)) return res.status(400).json({ error: "invalid_mime_type" });

  const ext = f.mimetype === "image/png" ? "png" : (f.mimetype === "image/webp" ? "webp" : "jpg");
  const rand = crypto.randomBytes(12).toString("hex");

  const path = `${meta.folder}/${req.user!.id}/${Date.now()}-${rand}.${ext}`;

  const { error } = await supabase.storage
    .from(sbEnv.SUPABASE_STORAGE_BUCKET)
    .upload(path, f.buffer, {
      contentType: f.mimetype,
      upsert: false
    });

  if (error) {
    return res.status(500).json({ error: "upload_failed", details: error.message });
  }

  return res.json({
    path,
    publicUrl: publicUrlForPath(path)
  });
});