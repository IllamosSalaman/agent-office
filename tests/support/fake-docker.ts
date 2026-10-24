import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// `agent-office docker` run for real, against a stand-in for the `docker` program first on PATH,
// the way tests/clone.test.ts stands in for `gh`. The fake writes every call it gets to calls.jsonl
// and answers from a scripted state:
//   down      the daemon doesn't answer (`docker version` fails)
//   images    the image tags that exist (`docker build` adds its tag)
//   running   the agent-office container is running
//   published what `docker port` says the office is published on
//   link      what the sign-in-link command run inside prints
// `docker run` stays up, like a container in the foreground, until it gets SIGINT or SIGTERM
// (Ctrl-C reaches it as well as the command: they're one process group).
// Browsers are stand-ins too: `open` and `xdg-open` write the address they're given to opened.txt.

export interface FakeDockerState {
  down?: boolean;
  images?: string[];
  running?: boolean;
  published?: string;
  link?: string;
}

const FAKE_DOCKER = (node: string) => `#!${node}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DOCKER_DIR;
const statePath = path.join(dir, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
// A container being started stops gracefully on Ctrl-C from the moment the call is seen.
const stop = () => {
  const now = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  now.running = false;
  fs.writeFileSync(statePath, JSON.stringify(now));
  console.log('closing the office…');
  process.exit(0);
};
if (args[0] === 'run') {
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const fail = (msg, code = 1) => { process.stderr.write(msg + '\\n'); process.exit(code); };
const daemon = () => { if (state.down) fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'); };
const [cmd, sub] = args;
if (cmd === 'version') { daemon(); console.log('29.0.0'); process.exit(0); }
daemon();
if (cmd === 'image' && sub === 'inspect') {
  const tag = args[args.length - 1];
  if ((state.images || []).includes(tag)) { console.log('[{}]'); process.exit(0); }
  fail('Error response from daemon: No such image: ' + tag);
}
if (cmd === 'build') {
  const tag = args[args.indexOf('-t') + 1] || args[args.indexOf('--tag') + 1];
  state.images = [...(state.images || []), tag];
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log('#1 building ' + tag);
  process.exit(0);
}
if (cmd === 'container' && sub === 'inspect') {
  if (state.running) { console.log('true'); process.exit(0); }
  fail('Error: No such container: agent-office');
}
if (cmd === 'port') {
  if (state.running && state.published) { console.log(state.published); process.exit(0); }
  fail('Error: No such container: agent-office');
}
if (cmd === 'exec') {
  if (!state.running) fail('Error response from daemon: container agent-office is not running');
  if (args.includes('sign-in-link')) { console.log(state.link || '/login#key=fake-key'); process.exit(0); }
  process.exit(0);
}
if (cmd === 'run') {
  state.running = true;
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log('agent-office is open');
  setTimeout(() => process.exit(3), 20000);
} else {
  fail('fake docker: no answer for ' + args.join(' '));
}
`;

const FAKE_BROWSER = `#!/bin/sh
printf '%s\\n' "$1" >> "$FAKE_DOCKER_DIR/opened.txt"
`;

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface FakeDocker {
  dir: string;
  /** Every `docker` call made, as its arguments. */
  calls(): string[][];
  /** The calls of one kind (`run`, `build`, `exec`…). */
  callsOf(cmd: string): string[][];
  /** The addresses the command opened in a browser. */
  opened(): string[];
  /** Runs `agent-office <args>` to the end. */
  run(args: string[], opts?: { docker?: boolean }): Promise<Run>;
  /** Starts `agent-office <args>`; `interrupt()` is Ctrl-C at its terminal. */
  start(args: string[]): { done: Promise<Run>; interrupt(): void; output(): string };
}

const root = path.resolve(import.meta.dirname, '..', '..');
const cli = path.join(root, 'src', 'server', 'cli.ts');

export function fakeDocker(t: { after(fn: () => void): void }, state: FakeDockerState = {}): FakeDocker {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-docker-'));
  const bin = path.join(dir, 'bin');
  const nodocker = path.join(dir, 'nodocker');
  mkdirSync(bin);
  mkdirSync(nodocker);
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER(process.execPath));
  for (const browser of ['open', 'xdg-open']) {
    for (const where of [bin, nodocker]) {
      writeFileSync(path.join(where, browser), FAKE_BROWSER);
      chmodSync(path.join(where, browser), 0o755);
    }
  }
  chmodSync(path.join(bin, 'docker'), 0o755);
  const children: number[] = [];
  t.after(() => {
    for (const pid of children) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const env = (docker: boolean) => {
    const e: NodeJS.ProcessEnv = { ...process.env, FAKE_DOCKER_DIR: dir, PATH: docker ? bin : nodocker, DISPLAY: ':0' };
    // Where nobody would see a browser, the command doesn't try one (src/server/browser.ts).
    for (const k of ['CI', 'SSH_CONNECTION', 'SSH_TTY', 'AGENT_OFFICE_NO_OPEN']) delete e[k];
    return e;
  };
  const start = (args: string[], docker = true) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: root, env: env(docker), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child.pid!);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const done = new Promise<Run>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
    return { done, interrupt: () => process.kill(-child.pid!, 'SIGINT'), output: () => stdout + stderr };
  };
  const calls = () =>
    existsSync(path.join(dir, 'calls.jsonl'))
      ? readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[])
      : [];
  return {
    dir,
    calls,
    callsOf: (cmd) => calls().filter((c) => c[0] === cmd),
    opened: () => (existsSync(path.join(dir, 'opened.txt')) ? readFileSync(path.join(dir, 'opened.txt'), 'utf8').split('\n').filter(Boolean) : []),
    run: (args, opts) => start(args, opts?.docker ?? true).done,
    start: (args) => start(args),
  };
}

/** Waits for fn to be true, for up to 10 seconds. */
export async function until(fn: () => boolean): Promise<boolean> {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 25));
  return fn();
}
