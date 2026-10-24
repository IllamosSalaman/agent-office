import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, dockerAttached } from './runner.js';

// The office's image: deploy/container/Dockerfile, the same one the cloud deploys build, tagged
// with the office's version and built only when no image has that tag.

/** The agent-office package this runs from: a checkout, or (#5) an installed release. */
function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'agent-office') return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new Error("can't find agent-office's package.json");
    dir = up;
  }
}

export interface Image {
  tag: string;
  /** The folder the image is built from, and its Dockerfile. */
  context: string;
  dockerfile: string;
}

export function officeImage(): Image {
  const root = packageRoot();
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
  return { tag: `agent-office:${version}`, context: root, dockerfile: path.join(root, 'deploy', 'container', 'Dockerfile') };
}

/** Builds the image unless one with its tag is there already. Resolves to what went wrong, if anything. */
export async function ensureImage(image: Image): Promise<string | undefined> {
  if ((await docker(['image', 'inspect', '--format', '{{.Id}}', image.tag])).code === 0) return undefined;
  if (!existsSync(image.dockerfile)) return `there's no ${path.relative(image.context, image.dockerfile)} to build the image from: run it from a checkout of agent-office`;
  console.log(`  building the office's image, ${image.tag} (only this once for this version)…\n`);
  const code = await dockerAttached(['build', '-t', image.tag, '-f', image.dockerfile, image.context]).exited;
  return code === 0 ? undefined : `building ${image.tag} failed (docker build exited with ${code})`;
}
