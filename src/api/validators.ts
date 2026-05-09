import { z } from 'zod';

export const TradeQuerySchema = z.object({
  status:         z.enum(['open', 'closed', 'stopped']).optional(),
  underlying:     z.enum(['NIFTY', 'BANKNIFTY', 'SENSEX']).optional(),
  personality_id: z.string().uuid().optional(),
  date:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const SignalQuerySchema = z.object({
  underlying: z.enum(['NIFTY', 'BANKNIFTY', 'SENSEX']).optional(),
  date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const RetrospectionQuerySchema = z.object({
  personality_id: z.string().uuid().optional(),
  date:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const FreezeBodySchema = z.object({
  frozen: z.boolean(),
});

export const ActivateBodySchema = z.object({
  active: z.boolean(),
});

export type TradeQuery           = z.infer<typeof TradeQuerySchema>;
export type SignalQuery          = z.infer<typeof SignalQuerySchema>;
export type RetrospectionQuery   = z.infer<typeof RetrospectionQuerySchema>;
export type FreezeBody           = z.infer<typeof FreezeBodySchema>;
export type ActivateBody         = z.infer<typeof ActivateBodySchema>;
