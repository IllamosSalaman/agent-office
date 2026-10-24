import { spawnSync } from 'node:child_process';
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** The file in a project that lists, gitignore-style, the files every worktree of it gets a copy of. */
export const WORKTREE_INCLUDE = '.worktreeinclude';

/**
 * Copies the files the project's `.worktreeinclude` lists from its checkout (`dir`) into a worktree
 * just made of it (`into`), the way Claude Code does: only files that match a pattern there and that
 * git ignores, so a tracked file on the worktree's branch is never overwritten, and with their
 * permissions. A listed file that isn't there is simply not copied. Returns the paths it copied,
 * relative to the project; a project without the file gets nothing, and nothing is asked of git.
 */
export function copyWorktreeInclude(dir: string, into: string): string[] {
  const list = path.join(dir, WORKTREE_INCLUDE);
  if (!existsSync(list)) return [];
  // Untracked files matching its patterns, then only those git itself ignores.
  const listed = git(dir, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${list}`]);
  const files = listed.split('\0').filter((f) => f && !f.endsWith('/'));
  if (!files.length) return [];
  const ignored = git(dir, ['check-ignore', '-z', '--stdin'], files.join('\0'));
  const copied: string[] = [];
  for (const rel of ignored.split('\0').filter(Boolean)) {
    const from = path.join(dir, rel);
    const to = path.join(into, rel);
    if (existsSync(to)) continue;
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    chmodSync(to, statSync(from).mode & 0o7777);
    copied.push(rel);
  }
  return copied;
}

/** Git's output; check-ignore exits 1 when none of the paths are ignored, which is an empty answer. */
function git(cwd: string, args: string[], input?: string): string {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && r.status !== 1) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
  return r.status === 0 ? r.stdout : '';
}
