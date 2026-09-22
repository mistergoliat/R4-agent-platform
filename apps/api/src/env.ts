import { existsSync } from 'node:fs';

/** Loads `.env` from the working directory when present (local development only). */
export function loadLocalEnvFile(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
