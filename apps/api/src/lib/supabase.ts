import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const SupabaseEnv = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().min(1)
});

export const sbEnv = SupabaseEnv.parse(process.env);

export const supabase = createClient(sbEnv.SUPABASE_URL, sbEnv.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

export function publicUrlForPath(path: string) {
  // Public bucket URL pattern
  // https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
  return `${sbEnv.SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${sbEnv.SUPABASE_STORAGE_BUCKET}/${path}`;
}