import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertArtifactSafe, type ArtifactFiles } from '@r4/evaluation';

/**
 * Writes one artifact directory. Artifacts are immutable: an existing,
 * non-empty directory is never overwritten. Every file passes the privacy
 * gate again here (the framework already checked it when producing it).
 */
export function writeArtifacts(dir: string, files: ArtifactFiles, options: { secrets?: readonly string[] } = {}): string {
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`artifact directory ${target} already exists; evaluation artifacts are immutable`);
  for (const text of Object.values(files)) assertArtifactSafe(text, options.secrets ?? []);
  mkdirSync(target, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(target, name), text, 'utf8');
  return target;
}

/** The commit the evaluated code comes from, and whether the working tree had uncommitted changes. */
export function gitState(cwd = process.cwd()): { sha: string; dirty: boolean } {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { sha: /^[0-9a-f]{40}$/.test(sha) ? sha : 'unknown', dirty: status.length > 0 };
  } catch {
    return { sha: 'unknown', dirty: false };
  }
}

/** Secret values from the environment that must never appear in an artifact. */
export function secretsFromEnv(env: NodeJS.ProcessEnv, names: readonly string[] = ['R4_MODEL_API_KEY', 'R4_EVAL_MODEL_API_KEY']): string[] {
  return names.map((n) => env[n]).filter((v): v is string => typeof v === 'string' && v.length >= 4);
}
