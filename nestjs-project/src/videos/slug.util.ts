import { randomBytes } from 'node:crypto';

const SLUG_BYTES = 8;

/** 64 random bits as 11 URL-safe characters. */
export function generateSlug(): string {
  return randomBytes(SLUG_BYTES).toString('base64url');
}
