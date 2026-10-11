import { z } from 'zod';
const crop = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
  rotation: z.number().min(-180).max(360).optional()
}).refine(c => c.x + c.width <= 1.00001 && c.y + c.height <= 1.00001, '裁剪范围超出图片');
export const createMatchScanSchema = z.object({
  collectibleId: z.string().min(1), requestId: z.string().min(8).max(100),
  source: z.enum(['camera', 'album']), crop: crop.optional()
});
export type CreateMatchScanInput = z.infer<typeof createMatchScanSchema>;
export const scanSettingsSchema = z.object({
  engine: z.enum(['color', 'dino']), candidateThreshold: z.number().min(0).max(1),
  candidateLimit: z.number().int().min(1).max(10), visualWeight: z.number().min(0).max(1),
  enhancementEnabled: z.boolean(), enhancementSkipThreshold: z.number().min(0).max(1),
  enhancementMinGap: z.number().min(0).max(1), dailyUserEnhancements: z.number().int().min(0).max(10000),
  dailyGlobalEnhancements: z.number().int().min(0).max(1000000)
});
export type ScanSettingsInput = z.infer<typeof scanSettingsSchema>;
export const scanFeedbackSchema = z.object({ bagId: z.string().min(1).optional(), feedback: z.enum(['SELECTED', 'CORRECTED', 'NONE']) })
  .refine(value => value.feedback === 'NONE' || !!value.bagId, '确认选择时需要款式 ID');
export const learningSettingsSchema = z.object({ enabled: z.boolean(), budgetBytes: z.number().int().min(0).max(1024 ** 4) });
export const learningReviewSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'CORRECT', 'WITHDRAW', 'RESTORE', 'RECOMPUTE']),
  bagId: z.string().min(1).optional(), replaceReferenceId: z.string().min(1).optional()
}).refine(v => v.action !== 'CORRECT' || !!v.bagId, '纠正时需要款式 ID');
