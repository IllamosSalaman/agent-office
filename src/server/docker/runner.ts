import { spawn, type ChildProcess } from 'node:child_process';

// Every `docker` call `agent-office docker` makes goes through here: the `docker` program found on
// PATH, never an API client. It's the one seam the tests fake (tests/support/fake-docker.ts).

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** The `docker` command isn't on PATH. */
export class NoDocker extends Error {
  constructor() {
    super('no docker command');
  }
}

/** Runs `docker <args>` to the end and collects what it says. */
export function docker(args: string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err: NodeJS.ErrnoException) => reject(err.code === 'ENOENT' ? new NoDocker() : err));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Runs `docker <args>` with its output in this terminal (a build's progress, the office's logs). */
export function dockerAttached(args: string[]): { child: ChildProcess; exited: Promise<number> } {
  const child = spawn('docker', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', (err: NodeJS.ErrnoException) => reject(err.code === 'ENOENT' ? new NoDocker() : err));
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  return { child, exited };
}
