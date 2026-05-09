import { query } from '../db/client';
import type { PersonalityConfig, Underlying } from '../db/schema';

let cache: PersonalityConfig[] = [];
let expiry = 0;

export async function loadActivePersonalities(underlying: Underlying): Promise<PersonalityConfig[]> {
  if (Date.now() < expiry) return cache;

  const rows = await query<PersonalityConfig>(
    `SELECT * FROM personality_configs WHERE is_active = TRUE`,
    [],
  );
  cache = rows;
  expiry = Date.now() + 5 * 60 * 1000;
  return rows;
}

export function invalidatePersonalityCache(): void {
  expiry = 0;
}
