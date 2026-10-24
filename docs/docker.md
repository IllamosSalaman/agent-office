# Docker mode

Back to the [README](../README.md).

When the office runs on your own computer, every worker runs with your rights: an agent can read or change anything in your home folder, your SSH keys, your other repositories and your sign-ins. `agent-office docker` starts the same office inside a local Docker container instead, so the workers can only touch what's in that box.

```bash
agent-office docker          # an installed office
npm run docker               # from a checkout
```

Plain `agent-office` keeps starting the office on your computer, exactly as before. You choose each time.

## What it protects

- **No folder of your computer is in the container.** Nothing is bind-mounted: projects are cloned inside it, through the elevator, the way a cloud office clones them.
- **No Docker socket.** Agents can't start containers or take over Docker on your computer.
- **No extra privileges.** The office and its workers run as the image's non-root user (`agentoffice`), with no `--privileged`, no added capabilities and `no-new-privileges`, so nothing inside can become root.
- **Only your computer can open it.** The office is published on `127.0.0.1` only, never on your network.

The container does have normal internet access, so agents can reach GitHub, npm, Anthropic, OpenAI and your project's hosted services.

## Starting and stopping

You need Docker Desktop (Settings → Resources sets how much of your computer it may use), or anything else that gives you a working `docker` command. Docker mode is built and tested with Docker Desktop on macOS; on Linux and Windows it's expected to work wherever `docker` does, but it isn't tested there.

`agent-office docker`:

1. Checks that Docker answers. If there's no `docker` command, or Docker isn't running, it says so and stops.
2. Builds the office's image the first time, from [`deploy/container/Dockerfile`](../deploy/container/Dockerfile), the same image the cloud deploys use. It's tagged with the office's version (`agent-office:0.1.0`), and built again only when that version has no image. The build shows its progress in the terminal and takes a few minutes.
3. Starts the container, named `agent-office`, in the foreground, with the office's logs in your terminal.
4. Waits until the office answers on `http://localhost:4610`, then opens your browser **already signed in**, with a link that works once. The office makes that link when the command asks it to; the office password is never shown.

**Ctrl-C** stops the office the way it stops a local one: workers save their scrollback, the container stops and is removed, and the volume keeps everything. The next `agent-office docker` brings your floors and workers back, resumed, with their terminal history. A worker that was in the middle of something is cut off, as it would be locally.

Run `agent-office docker` again while it's running, from another terminal, and it doesn't start a second office: it opens your browser signed in to the one that's running, and exits. That's also how to sign in another browser.

## Ports

The office is on `http://localhost:4610`, so it can run next to a local office on 4600 at the same time; the two are separate offices with separate sign-ins, and nothing is shared or synced between them. `--port` picks another port:

```bash
agent-office docker --port 4700
```

## What it keeps, and losing it

Everything the Docker office keeps is on one Docker volume, `agent-office-data`, mounted at `/data` in the container: floors, workers and their worktrees, sessions, scrollback, sign-ins (Claude Code, the GitHub CLI) and settings. It outlives the container and new images.

**Deleting the volume deletes the Docker office**, with any work that was only in it: Docker Desktop's *Clean / Purge data*, *Volumes → Delete*, or `docker volume rm agent-office-data` all do that. Push your workers' branches before you do.

From a checkout, the image is only rebuilt for a new version. To pick up changes to the office's code at the same version, remove the image (`docker image rm agent-office:<version>`, with the office stopped) and start it again; the volume isn't touched.

## Keeping your computer responsive

A pile of agents installing packages and running tests at once can make any computer crawl. Two knobs:

- **Docker Desktop → Settings → Resources** caps the CPUs and memory the whole office may use.
- **Workers at once**, in the office's queue window, and **Most workers at once** in ⚙️ Settings, cap how many workers run together.

## How it works

The container runs the image's start script, [`deploy/container/start.sh`](../deploy/container/start.sh), in its local mode, which only `agent-office docker` turns on (with `AGENT_OFFICE_LOCAL_MODE=1`): it starts no SSH server and takes no admin keys, and the office listens on the container's network, which Docker publishes on your computer's `127.0.0.1` only. Cloud deploys don't set it and work exactly as before. The sign-in link comes from `agent-office sign-in-link`, run inside the container with `docker exec`: it asks the running office for a one-time link over a socket only the office's user can open.

The command's own code is in `src/server/docker/`. Every `docker` call goes through one runner (`runner.ts`) that runs the `docker` on your `PATH`.
