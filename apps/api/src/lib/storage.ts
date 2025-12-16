import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";

const StorageEnvSchema = z.object({
  STORAGE_ENDPOINT: z.string().min(1),
  STORAGE_REGION: z.string().min(1),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_PUBLIC_BASE_URL: z.string().url()
});

const senv = StorageEnvSchema.parse(process.env);

export const s3 = new S3Client({
  region: senv.STORAGE_REGION,
  endpoint: senv.STORAGE_ENDPOINT,
  credentials: {
    accessKeyId: senv.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: senv.STORAGE_SECRET_ACCESS_KEY
  }
});

export function publicUrlForKey(key: string) {
  return `${senv.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
}

export async function presignPutObject(params: { key: string; contentType: string; expiresSec?: number }) {
  const cmd = new PutObjectCommand({
    Bucket: senv.STORAGE_BUCKET,
    Key: params.key,
    ContentType: params.contentType
  });
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: params.expiresSec ?? 300 });
  return uploadUrl;
}

export async function presignGetObject(params: { key: string; expiresSec?: number }) {
  const cmd = new GetObjectCommand({
    Bucket: senv.STORAGE_BUCKET,
    Key: params.key
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: params.expiresSec ?? 600 });
  return url;
}