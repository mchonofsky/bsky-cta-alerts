import { env } from "node:process";
import { z } from "zod";
import type { AtpAgentLoginOpts } from "@atproto/api";

const envSchema = z.object({
  BSKY_HANDLE: z.string().nonempty(),
  BSKY_PASSWORD: z.string().nonempty(),
  BSKY_SERVICE: z.string().nonempty().default("https://bsky.social"),
  METRA_API_TOKEN: z.string().nonempty()
});

const parsed = envSchema.parse(env);
export const bskyAccount: AtpAgentLoginOpts = {
  identifier: parsed.BSKY_HANDLE,
  password: parsed.BSKY_PASSWORD,
};

export const metraApiToken = parsed.METRA_API_TOKEN;

export const firebaseServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT as string);

export const bskyService = parsed.BSKY_SERVICE;
