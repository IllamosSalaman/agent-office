import { openBrowser } from '../browser.js';
import { docker } from './runner.js';

// Opening the Docker office in this computer's browser, signed in. The office in the container
// makes a one-time sign-in link when asked by `agent-office sign-in-link` run inside it
// (inside.ts), which only someone who can `docker exec` can do. The link's path is put on
// http://localhost:<port> here. The password is never printed or read from the logs.

/** The office's user in the image (deploy/container/install.sh). */
const OFFICE_USER = 'agentoffice';
/** How the office is started in the image, for a command run next to it. */
const OFFICE_CLI = ['node', '/opt/agent-office/bin/agent-office.js'];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether anything answers HTTP on this port of this computer. */
async function answers(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    return true;
  } catch {
    return false;
  }
}

/** Waits until the office answers; false if it gave up first (gone() says the container stopped). */
async function waitForOffice(port: number, gone: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (!gone() && Date.now() < until) {
    if (await answers(port)) return true;
    await sleep(250);
  }
  return false;
}

/** A sign-in link's path from the office in the container. Tried a few times while it's starting. */
async function signInPath(container: string): Promise<string | undefined> {
  for (let i = 0; i < 20; i++) {
    const r = await docker(['exec', '--user', OFFICE_USER, container, ...OFFICE_CLI, 'sign-in-link']);
    const link = r.stdout.trim();
    if (r.code === 0 && link.startsWith('/')) return link;
    await sleep(500);
  }
  return undefined;
}

/**
 * Once the office answers on localhost:<port>, opens the browser with a link that signs it in once
 * (or says where the office is, when it can't). False when the office never answered.
 */
export async function openSignedIn(container: string, port: number, gone: () => boolean = () => false, timeoutMs = 10 * 60_000): Promise<boolean> {
  const here = `http://localhost:${port}`;
  if (!(await waitForOffice(port, gone, timeoutMs))) return false;
  const link = await signInPath(container);
  if (!link) {
    console.log(`\n  🐳  the office is open at ${here} (couldn't make a sign-in link: run agent-office docker again for one)\n`);
    return true;
  }
  const url = here + link;
  const opened = openBrowser(url);
  console.log(`\n  🐳  the office is open at ${here}\n\n  sign in: ${url}\n           ${opened ? 'opened in your browser; ' : ''}the link works once\n`);
  return true;
}
