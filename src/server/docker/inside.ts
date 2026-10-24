import { chmodSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { officeHome } from '../config.js';

// The office's half of signing in to the Docker office (sign-in.ts is the other): in the container's
// local mode the office makes one-time sign-in links on request, over a socket in its data folder
// that only its own user can open. `agent-office sign-in-link`, run inside through `docker exec`,
// asks for one and prints its path (/login#key=…). Nothing else listens, and no password is shown.

const socketPath = (dataDir: string) => path.join(dataDir, 'sign-in.sock');

/** Makes a sign-in link for whoever asks on the socket, for as long as the office runs. */
export function serveSignInLinks(dataDir: string, link: () => string): void {
  const where = socketPath(dataDir);
  rmSync(where, { force: true }); // left by the office before this one
  const server = net.createServer((conn) => conn.end(`${link()}\n`));
  server.on('error', (err) => console.error(`agent-office: no sign-in links for agent-office docker (${err.message})`));
  server.listen(where, () => chmodSync(where, 0o600));
  server.unref();
}

/** `agent-office sign-in-link`: prints a link's path from the office running here. */
export function signInLinkCommand(): Promise<number> {
  return new Promise((resolve) => {
    let out = '';
    const conn = net.connect(socketPath(path.join(officeHome(), '.agent-office')));
    conn.on('data', (d) => (out += d));
    conn.on('end', () => {
      process.stdout.write(out);
      resolve(out.startsWith('/') ? 0 : 1);
    });
    conn.on('error', () => {
      console.error("agent-office: no office here is making sign-in links (it's started by agent-office docker)");
      resolve(1);
    });
  });
}
