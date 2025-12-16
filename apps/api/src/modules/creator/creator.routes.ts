import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole, AuthedRequest } from "../../middleware/auth";
import { UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { randomToken } from "../../lib/security";

export const creatorRouter = Router();

creatorRouter.use(requireAuth, requireRole(UserRole.CREATOR, UserRole.ADMIN));

/**
 * NOTE (Supabase Option A):
 * - We are NOT using S3/R2 presigned URLs anymore.
 * - PDF is NOT stored on backend storage. We only store metadata in DB for grouping/traceability.
 * - Images are uploaded via: POST /v1/assets/images/upload (multer -> Supabase Storage)
 */

/**
 * Step 1 (metadata only): register a PDF (no upload)
 * Frontend can render PDF locally using PDF.js from the user's file.
 */
const RegisterPdfSchema = z.object({
  originalName: z.string().min(1).max(200),
  pageCount: z.number().int().min(1).max(2000).optional()
});

creatorRouter.post("/pdfs/register", async (req: AuthedRequest, res) => {
  const body = RegisterPdfSchema.parse(req.body);

  // fileKey is required by your current schema; we store a unique placeholder
  const fileKey = `local-only/${req.user!.id}/${Date.now()}-${randomToken(10)}`;

  const pdf = await prisma.pdfDocument.create({
    data: {
      creatorId: req.user!.id,
      originalName: body.originalName,
      fileKey,
      pageCount: body.pageCount ?? null,
      status: "READY"
    }
  });

  res.status(201).json({ pdf });
});

/**
 * Step 1b: complete PDF metadata (optional)
 */
const CompletePdfSchema = z.object({
  pageCount: z.number().int().min(1).max(2000)
});

creatorRouter.post("/pdfs/:pdfId/complete", async (req: AuthedRequest, res) => {
  const body = CompletePdfSchema.parse(req.body);

  const pdf = await prisma.pdfDocument.findUnique({ where: { id: req.params.pdfId } });
  if (!pdf) return res.status(404).json({ error: "NOT_FOUND" });
  if (req.user!.role !== "ADMIN" && pdf.creatorId !== req.user!.id) return res.status(403).json({ error: "FORBIDDEN" });

  const updated = await prisma.pdfDocument.update({
    where: { id: pdf.id },
    data: { pageCount: body.pageCount, status: "READY" }
  });

  res.json({ pdf: updated });
});

/**
 * Step 2: fetch PDF metadata (NO signedUrl because we don't store PDF)
 */
creatorRouter.get("/pdfs/:pdfId", async (req: AuthedRequest, res) => {
  const pdf = await prisma.pdfDocument.findUnique({ where: { id: req.params.pdfId } });
  if (!pdf) return res.status(404).json({ error: "NOT_FOUND" });
  if (req.user!.role !== "ADMIN" && pdf.creatorId !== req.user!.id) return res.status(403).json({ error: "FORBIDDEN" });

  res.json({
    pdf: {
      id: pdf.id,
      originalName: pdf.originalName,
      pageCount: pdf.pageCount,
      status: pdf.status
    },
    storageMode: "LOCAL_ONLY"
  });
});

/**
 * Step 3: create a crop record
 * Frontend must upload cropped images first using:
 *   POST /v1/assets/images/upload
 * and then call this endpoint with returned { path, publicUrl } as keys/urls.
 */
const CreateCropSchema = z.object({
  pdfId: z.string().min(1),
  pageNumber: z.number().int().min(1).max(2000),

  questionCropJson: z.any(),
  optionsCropJson: z.any().optional(),

  questionImageKey: z.string().min(1), // Supabase path
  questionImageUrl: z.string().url(),

  optionsImageKey: z.string().min(1).optional(),
  optionsImageUrl: z.string().url().optional()
});

creatorRouter.post("/crops", async (req: AuthedRequest, res) => {
  const body = CreateCropSchema.parse(req.body);

  const pdf = await prisma.pdfDocument.findUnique({ where: { id: body.pdfId } });
  if (!pdf) return res.status(404).json({ error: "PDF_NOT_FOUND" });
  if (req.user!.role !== "ADMIN" && pdf.creatorId !== req.user!.id) return res.status(403).json({ error: "FORBIDDEN" });

  const crop = await prisma.pdfCrop.create({
    data: {
      pdfId: body.pdfId,
      pageNumber: body.pageNumber,
      questionCropJson: body.questionCropJson,
      optionsCropJson: body.optionsCropJson ?? null,
      questionImageKey: body.questionImageKey,
      questionImageUrl: body.questionImageUrl,
      optionsImageKey: body.optionsImageKey ?? null,
      optionsImageUrl: body.optionsImageUrl ?? null
    }
  });

  res.status(201).json({ crop });
});

creatorRouter.get("/crops/:cropId", async (req: AuthedRequest, res) => {
  const crop = await prisma.pdfCrop.findUnique({
    where: { id: req.params.cropId },
    include: { pdf: true }
  });
  if (!crop) return res.status(404).json({ error: "NOT_FOUND" });
  if (req.user!.role !== "ADMIN" && crop.pdf.creatorId !== req.user!.id) return res.status(403).json({ error: "FORBIDDEN" });
  res.json({ crop });
});

/**
 * Step 4: create Question from crop
 */
const CreateQuestionSchema = z.object({
  cropId: z.string().min(1),
  type: z.enum(["MCQ", "MSQ", "NUMERICAL"]),
  answerKeyJson: z.any(),
  solutionText: z.string().max(8000).optional(),

  subject: z.string().max(80).optional(),
  chapter: z.string().max(120).optional(),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).optional(),

  marks: z.number().min(0).max(100).optional(),
  negativeMarks: z.number().min(-100).max(0).optional()
});

creatorRouter.post("/questions", async (req: AuthedRequest, res) => {
  const body = CreateQuestionSchema.parse(req.body);

  const crop = await prisma.pdfCrop.findUnique({ where: { id: body.cropId }, include: { pdf: true } });
  if (!crop) return res.status(404).json({ error: "CROP_NOT_FOUND" });
  if (req.user!.role !== "ADMIN" && crop.pdf.creatorId !== req.user!.id) return res.status(403).json({ error: "FORBIDDEN" });

  const q = await prisma.question.create({
    data: {
      creatorId: req.user!.id,
      type: body.type as any,
      answerKeyJson: body.answerKeyJson,

      promptImageUrl: crop.questionImageUrl,
      optionsImageUrl: crop.optionsImageUrl,

      solutionText: body.solutionText,

      subject: body.subject,
      chapter: body.chapter,
      difficulty: (body.difficulty ?? "MEDIUM") as any,

      marks: body.marks ?? 4,
      negativeMarks: body.negativeMarks ?? -1,

      sourcePdfId: crop.pdfId,
      sourceCropId: crop.id
    }
  });

  res.status(201).json({ question: q });
});