import { ensureImage, officeImage } from './image.js';
import { docker, dockerAttached, NoDocker } from './runner.js';
import { openSignedIn } from './sign-in.js';

// `agent-office docker`, run on your own computer: the same office in a local Docker container.
// It builds the image when this version has none (image.ts), then runs one named container in the
// foreground, its data on one named volume and the office published on this computer's 127.0.0.1
// only. Every docker call goes through runner.ts.

/** One Docker office at a time: this container, and everything it keeps on this volume. */
export const CONTAINER = 'agent-office';
export const VOLUME = 'agent-office-data';
/** Where the image keeps everything that has to outlive the container (deploy/container/start.sh). */
const DATA = '/data';
/** Next to a local office on 4600, so both run at once and their sign-ins don't collide. */
const DEFAULT_PORT = 4610;

const HELP = `agent-office docker — run the office in a local Docker container

Usage:
  agent-office docker [--port <n>]

Starts the same office inside Docker (Docker Desktop, or anything that gives you
a working docker command), so its workers can't touch anything on this computer
outside it. It runs in the foreground with the office's logs here, and Ctrl-C
stops it. Once it answers, your browser opens already signed in.

The first start builds the image (once per agent-office version). Everything the
office keeps is on the Docker volume ${VOLUME}, so the next start brings
floors and workers back. No folder of this computer and no Docker socket is given
to the container: projects are cloned inside it, through the elevator.

If it's already running, it opens your browser signed in to it instead.

Options:
  -p, --port <n>   The port on this computer's 127.0.0.1 (default ${DEFAULT_PORT})
  -h, --help       Show this help

More: docs/docker.md
`;

interface Options {
  port: number;
}

/** Reads the command line; throws what's wrong with it. Undefined for --help. */
function parseArgs(argv: string[]): Options | undefined {
  const o: Options = { port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return undefined;
    if (a === '-p' || a === '--port') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${a} needs a port number`);
      o.port = n;
    } else throw new Error(`unknown ${a.startsWith('-') ? 'option' : 'command'} ${a} (see agent-office docker --help)`);
  }
  return o;
}

const fail = (line: string) => {
  console.error(`agent-office docker: ${line}`);
  return 1;
};

/** Whether Docker answers; what to tell the person when it doesn't. */
async function dockerProblem(): Promise<string | undefined> {
  try {
    const r = await docker(['version', '--format', '{{.Server.Version}}']);
    if (r.code !== 0) return "Docker isn't running. Start Docker Desktop (or your Docker daemon) and try again.";
  } catch (err) {
    if (err instanceof NoDocker) return "there's no docker command. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), or another Docker, and try again.";
    throw err;
  }
  return undefined;
}

async function running(): Promise<boolean> {
  const r = await docker(['container', 'inspect', '--format', '{{.State.Running}}', CONTAINER]);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/** The port the running container's office is published on here, which may not be --port's. */
async function publishedPort(): Promise<number | undefined> {
  const r = await docker(['port', CONTAINER]);
  const m = r.code === 0 ? /127\.0\.0\.1:(\d+)/.exec(r.stdout) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * The container: removed when it stops (the volume keeps everything), published on 127.0.0.1
 * only, and with nothing of this computer's: no folder, no Docker socket, no added privileges.
 * Local mode (start.sh) skips sshd and has the office listen on the container's network, on the
 * same port as outside so what it prints is where it is.
 */
function runArgs(tag: string, port: number): string[] {
  return [
    'run',
    '--rm',
    '--name', CONTAINER,
    '--volume', `${VOLUME}:${DATA}`,
    '--publish', `127.0.0.1:${port}:${port}`,
    '--env', 'AGENT_OFFICE_LOCAL_MODE=1',
    '--env', `PORT=${port}`,
    '--security-opt', 'no-new-privileges',
    tag,
  ];
}

export async function dockerCommand(argv: string[]): Promise<number> {
  let o: Options | undefined;
  try {
    o = parseArgs(argv);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!o) {
    process.stdout.write(HELP);
    return 0;
  }
  const problem = await dockerProblem();
  if (problem) return fail(problem);
  if (await running()) {
    const port = (await publishedPort()) ?? o.port;
    console.log(`  the Docker office is already running: opening it (Ctrl-C in its own terminal stops it)`);
    return (await openSignedIn(CONTAINER, port, () => false, 60_000)) ? 0 : fail(`the office in the container doesn't answer on http://localhost:${port}`);
  }
  const image = officeImage();
  const unbuilt = await ensureImage(image);
  if (unbuilt) return fail(unbuilt);
  // Ctrl-C reaches docker too (one process group), which stops the container gracefully: wait for it.
  process.on('SIGINT', () => {});
  const { exited } = dockerAttached(runArgs(image.tag, o.port));
  let gone = false;
  const code = exited.finally(() => (gone = true));
  void openSignedIn(CONTAINER, o.port, () => gone).catch(() => {});
  return code;
}
