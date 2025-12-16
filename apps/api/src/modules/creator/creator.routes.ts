import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole, AuthedRequest } from "../../middleware/auth";
import { UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { presignPutObject, presignGetObject, publicUrlForKey } from "../../lib/storage";

export const creatorRouter = Router();

creatorRouter.use(requireAuth, requireRole(UserRole.CREATOR, UserRole.ADMIN));

/**
 * Step 1: init PDF upload (returns presigned PUT URL)
 */
const InitPdfSchema = z.object({
  originalName: z.string().min(1).max(200),
  contentType: z.string().min(1) // application/pdf
});

creatorRouter.post("/pdfs/init", async (req: AuthedRequest, res) => {
  const body = InitPdfSchema.parse(req.body);

  if (body.contentType !== "application/pdf") {
    return res.status(400).json({ error: "PDF_REQUIRED" });
  }

  const pdfId = (await prisma.pdfDocument.create({
    data: {
      creatorId: req.user!.id,
      originalName: body.originalName,
      fileKey: `pdfs/${req.user!.id}/${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`
    },
    select: { id: true, fileKey: true }
  }));

  const uploadUrl = await presignPutObject({
    key: pdfId.fileKey,
    contentType: "application/pdf",
    expiresSec: 300
  });

  res.status(201).json({ pdfId: pdfId.id, uploadUrl });
});

/**
 * Step 1b: complete PDF (frontend sends pageCount after reading via PDF.js)
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
 * Step 2: get PDF metadata + signed URL for viewing (private)
 */
creatorRouter.get("/pdfs/:pdfId", async (req: AuthedRequest, res) => {
  const pdf = await prisma.pdfDocument.findUnique({ where: { id: req.params.pdfId } });
  if (!pdf) return res.status(404).json({ error: "NOT_FOUND" });
  if (req.user!.role !== "ADMIN" && pdf.creatorId !== req.user!.id) return res.status(403).json({ error: "FORBIDDEN" });

  const signedUrl = await presignGetObject({ key: pdf.fileKey, expiresSec: 600 });

  res.json({
    pdf: {
      id: pdf.id,
      originalName: pdf.originalName,
      pageCount: pdf.pageCount,
      status: pdf.status
    },
    signedUrl
  });
});

/**
 * Presign upload for cropped images (public assets)
 */
const PresignImageSchema = z.object({
  contentType: z.enum(["image/png", "image/jpeg", "image/webp"])
});

creatorRouter.post("/assets/images/presign", async (req: AuthedRequest, res) => {
  const body = PresignImageSchema.parse(req.body);

  const key = `question-images/${req.user!.id}/${Date.now()}-${Math.random().toString(16).slice(2)}.${body.contentType.split("/")[1]}`;
  const uploadUrl = await presignPutObject({ key, contentType: body.contentType, expiresSec: 300 });

  res.json({
    key,
    uploadUrl,
    publicUrl: publicUrlForKey(key)
  });
});

/**
 * Step 3: create a crop record (question crop required, options crop optional)
 * Frontend will:
 *  - presign image upload(s)
 *  - PUT images to storage
 *  - call this endpoint with crop rects + image urls
 */
const CreateCropSchema = z.object({
  pdfId: z.string().min(1),
  pageNumber: z.number().int().min(1).max(2000),

  questionCropJson: z.any(),
  optionsCropJson: z.any().optional(),

  questionImageKey: z.string().min(1),
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
  const crop = await prisma.pdfCrop.findUnique({ where: { id: req.params.cropId }, include: { pdf: true } });
  if (!crop) return res.status(404).json({ error: "NOT_FOUND" });
  if (req.user!.role !== "ADMIN" && crop.pdf.creatorId !== req.user!.id) return res.status(403).json({ error: "FORBIDDEN" });
  res.json({ crop });
});

/**
 * Step 4: Question editor creates Question from crop
 */
const CreateQuestionSchema = z.object({
  cropId: z.string().min(1),
  type: z.enum(["MCQ", "MSQ", "NUMERICAL"]),
  answerKeyJson: z.any(), // validated more strictly per-type later if you want
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