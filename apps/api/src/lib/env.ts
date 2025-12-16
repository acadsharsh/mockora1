import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8080),

  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),

  WEB_ORIGIN: z.string().min(1), // e.g. https://mockera-web.vercel.app
  SESSION_COOKIE_NAME: z.string().default("mockera_session"),
  SESSION_TTL_DAYS: z.coerce.number().default(30)
});

export const env = EnvSchema.parse(process.env);