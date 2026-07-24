import { z } from "zod";

export const VOICE_OUTCOMES = ["a", "b", "tie", "both_bad"] as const;

export const VOICE_JUDGMENT_REASONS = [
  "better_answer",
  "more_natural_voice",
  "better_tone",
  "better_pacing",
  "better_pronunciation",
  "more_concise",
  "other",
  "not_sure",
] as const;

export const VoiceModelSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type VoiceModel = z.infer<typeof VoiceModelSchema>;

export const VoicePromptSchema = z.object({
  id: z.string(),
  text: z.string().optional(),
  audio_url: z.string(),
  category: z.string().optional(),
});
export type VoicePrompt = z.infer<typeof VoicePromptSchema>;

export const VoiceResponseSchema = z.object({
  id: z.string(),
  prompt_id: z.string(),
  model_id: z.string(),
  audio_url: z.string(),
});
export type VoiceResponse = z.infer<typeof VoiceResponseSchema>;

export const VoiceManifestSchema = z.object({
  // "1" pins the manifest shape the seed script writes; bump on a breaking format change.
  version: z.literal("1"),
  created_at: z.iso.datetime(),
  models: z.array(VoiceModelSchema),
  prompts: z.array(VoicePromptSchema),
  responses: z.array(VoiceResponseSchema),
});
export type VoiceManifest = z.infer<typeof VoiceManifestSchema>;

export const VoicePlayCountsSchema = z.object({
  prompt: z.number().int().nonnegative(),
  a: z.number().int().nonnegative(),
  b: z.number().int().nonnegative(),
});
export type VoicePlayCounts = z.infer<typeof VoicePlayCountsSchema>;

export const VoiceJudgmentSchema = z.object({
  comparison_id: z.string(),
  evaluator_id: z.string(),
  prompt_id: z.string(),
  response_a_id: z.string(),
  response_b_id: z.string(),
  outcome: z.enum(VOICE_OUTCOMES),
  reason: z.enum(VOICE_JUDGMENT_REASONS).optional(),
  free_text: z.string().max(2000).optional(),
  play_counts: VoicePlayCountsSchema,
  time_to_judgment_ms: z.number(),
  created_at: z.iso.datetime(),
});
export type VoiceJudgment = z.infer<typeof VoiceJudgmentSchema>;
