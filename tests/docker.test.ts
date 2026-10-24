import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fakeDocker, until, type FakeDocker } from './support/fake-docker.js';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
const tag = `agent-office:${version}`;

/** Starts the office in "Docker", waits for the container to be up, then Ctrl-C. */
async function startAndStop(docker: FakeDocker, args: string[] = []) {
  const office = docker.start(['docker', ...args]);
  assert.ok(await until(() => docker.callsOf('run').length > 0), `docker run was called:\n${office.output()}`);
  office.interrupt();
  return office.done;
}

test('without a docker command, it says to install Docker Desktop and starts nothing', async (t) => {
  const docker = fakeDocker(t);
  const r = await docker.run(['docker'], { docker: false });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Docker Desktop/);
  assert.match(r.stderr, /install/i);
});

test("when Docker isn't running, it says to start Docker Desktop and starts nothing", async (t) => {
  const docker = fakeDocker(t, { down: true });
  const r = await docker.run(['docker']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /start Docker Desktop/i);
  assert.deepEqual(
    docker.calls().map((c) => c[0]),
    ['version'],
  );
});

test("the first start builds the image, tagged with the office's version, from the container Dockerfile", async (t) => {
  const docker = fakeDocker(t);
  const r = await startAndStop(docker);
  assert.equal(r.code, 0, r.stderr);
  const builds = docker.callsOf('build');
  assert.equal(builds.length, 1);
  const build = builds[0];
  assert.equal(build[build.indexOf('-t') + 1], tag);
  assert.equal(build[build.indexOf('-f') + 1], path.join(root, 'deploy', 'container', 'Dockerfile'));
  assert.equal(build.at(-1), root, 'built from the repository root');
  assert.ok(docker.calls().findIndex((c) => c[0] === 'build') < docker.calls().findIndex((c) => c[0] === 'run'));
});

test("once the version's image exists, it isn't built again", async (t) => {
  const docker = fakeDocker(t, { images: [tag] });
  const r = await startAndStop(docker);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(docker.callsOf('build'), []);
  assert.equal(docker.callsOf('run')[0].at(-1), tag);
});

/** The values given with a flag (`--publish 1 -p 2` → ['1', '2']), in either spelling. */
function values(args: string[], ...flags: string[]): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    for (const f of flags) {
      if (a === f) out.push(args[i + 1]);
      else if (a.startsWith(`${f}=`)) out.push(a.slice(f.length + 1));
    }
  });
  return out;
}

test('the container is the named one, on the named volume, in local mode, published on 127.0.0.1:4610 only', async (t) => {
  const docker = fakeDocker(t, { images: [tag] });
  const r = await startAndStop(docker);
  assert.equal(r.code, 0, r.stderr);
  const [run] = docker.callsOf('run');
  assert.deepEqual(values(run, '--name'), ['agent-office']);
  assert.ok(run.includes('--rm'), 'removed when it stops');
  assert.deepEqual(values(run, '-p', '--publish'), ['127.0.0.1:4610:4610']);
  assert.deepEqual(values(run, '-v', '--volume'), ['agent-office-data:/data']);
  assert.deepEqual(values(run, '--mount'), []);
  assert.ok(values(run, '-e', '--env').includes('AGENT_OFFICE_LOCAL_MODE=1'), 'local mode is on');
  assert.ok(values(run, '-e', '--env').includes('PORT=4610'), 'the office listens on the same port inside');
});

test('--port publishes the office on another port of 127.0.0.1', async (t) => {
  const docker = fakeDocker(t, { images: [tag] });
  const r = await startAndStop(docker, ['--port', '4620']);
  assert.equal(r.code, 0, r.stderr);
  const [run] = docker.callsOf('run');
  assert.deepEqual(values(run, '-p', '--publish'), ['127.0.0.1:4620:4620']);
  assert.ok(values(run, '-e', '--env').includes('PORT=4620'));
});

test('the container gets no folder, no Docker socket and no extra privileges', async (t) => {
  const docker = fakeDocker(t, { images: [tag] });
  await startAndStop(docker);
  const [run] = docker.callsOf('run');
  const mounts = [...values(run, '-v', '--volume'), ...values(run, '--mount')];
  for (const m of mounts) assert.ok(!/^[./~]/.test(m) && !m.includes('type=bind'), `${m} is a named volume, not a folder`);
  assert.ok(!run.some((a) => a.includes('docker.sock')), 'no Docker socket');
  for (const flag of ['--privileged', '--cap-add', '--device', '--pid', '--ipc', '--userns', '-u', '--user']) {
    assert.ok(!run.some((a) => a === flag || a.startsWith(`${flag}=`)), `no ${flag}`);
  }
  assert.deepEqual(values(run, '--network', '--net').filter((n) => n === 'host'), [], 'not on the host network');
  assert.ok(values(run, '--security-opt').includes('no-new-privileges'), "and nothing in it can gain privileges (sudo, setuid)");
});

/** Something answering on a port of this computer, like the office in the container would. */
async function answering(t: { after(fn: () => void): void }): Promise<number> {
  const server = createServer((_req, res) => res.end('the office'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return (server.address() as AddressInfo).port;
}

test('once the office in the container answers, the browser opens signed in, and Ctrl-C stops the container', async (t) => {
  const port = await answering(t);
  const docker = fakeDocker(t, { images: [tag], link: '/login#key=first' });
  const office = docker.start(['docker', '--port', String(port)]);
  assert.ok(await until(() => docker.opened().length > 0), `a browser was opened:\n${office.output()}`);
  assert.deepEqual(docker.opened(), [`http://localhost:${port}/login#key=first`]);
  assert.match(office.output(), /agent-office is open/, "the office's logs are in the terminal");
  office.interrupt();
  const r = await office.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /closing the office/, 'the container was stopped gracefully, not killed');
  assert.equal(docker.callsOf('run').length, 1);
});

test("when it's already running, it starts no second office and opens the browser signed in to that one", async (t) => {
  const port = await answering(t);
  const docker = fakeDocker(t, { running: true, published: `127.0.0.1:${port}`, link: '/login#key=one-time' });
  const r = await docker.run(['docker']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(docker.callsOf('run'), [], 'no second container');
  assert.deepEqual(docker.callsOf('build'), [], 'and nothing built');
  assert.ok(await until(() => docker.opened().length > 0), 'a browser was opened');
  assert.deepEqual(docker.opened(), [`http://localhost:${port}/login#key=one-time`]);
  const [exec] = docker.callsOf('exec');
  assert.ok(exec.includes('agent-office') && exec.includes('sign-in-link'), 'the link came from the office in the container');
});
