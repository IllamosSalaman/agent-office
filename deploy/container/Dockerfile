# Agent Office in a container, the way deploy/railway.sh runs it on Railway, deploy/fly.sh on Fly.io,
# deploy/dokploy.sh on Dokploy and deploy/coolify.sh on Coolify. Any Docker host works the same way:
# mount a volume at /data and publish port 22 (or the port in AGENT_OFFICE_SSHD_PORT, which
# deploy/fly.sh sets to 2222).
#
# The office listens on 127.0.0.1:4600 inside the container and is never published. sshd on port 22
# is the only way in: the keys in AGENT_OFFICE_ADMIN_KEYS get a shell as agentoffice, the user that
# runs the office, and teammates invited from the office log in as `office`, which can only open
# the tunnel. Everything that has to outlive a restart or a redeploy is on the volume (start.sh).
#
# Build it from the repository root: docker build -f deploy/container/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /opt/agent-office
COPY package.json package-lock.json ./
# No install scripts: `prepare` would build before the sources are here.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
# Dokploy unpacks deploy/dokploy.sh's upload without file modes, so the scripts get theirs back here.
RUN chmod 755 bin/*.js deploy/container/*.sh \
  && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0: corepack fetches the pnpm (or yarn) a project's packageManager
# names without stopping to ask, which would hang a worker.
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# sshd for the tunnels, tini to reap what workers leave behind, `ss` (iproute2) for the office to
# find the web servers workers start, and what workers need: git, the GitHub CLI (from GitHub's own
# apt repo, like deploy/provision.sh) and build tools.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server sudo tini procps iproute2 ca-certificates curl git less build-essential python3 \
  && install -d -m 755 /etc/apt/keyrings \
  && curl -fsSLo /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    >/etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*
# What workers' own projects need to build and test:
# - pnpm (and yarn) through corepack, at the version a project's packageManager names.
# - Postgres 16's server programs from PostgreSQL's own apt repo, in /usr/lib/postgresql/16/bin, for
#   the throwaway databases a project's tests start themselves. Installed only: no cluster is made,
#   and nothing starts it.
# - The system libraries Playwright's Chromium needs, with no browser: a project's own
#   `playwright install chromium` puts its matching browser in ~/.cache on the volume, without root.
RUN corepack enable \
  && curl -fsSLo /etc/apt/keyrings/postgresql.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && chmod go+r /etc/apt/keyrings/postgresql.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/postgresql.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    >/etc/apt/sources.list.d/pgdg.list \
  && install -d -m 755 /etc/postgresql-common/createcluster.d \
  && echo 'create_main_cluster = false' >/etc/postgresql-common/createcluster.d/agent-office.conf \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-16 \
  && npx --yes playwright install-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /opt/agent-office /opt/agent-office
RUN /opt/agent-office/deploy/container/install.sh
EXPOSE 22
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/agent-office/deploy/container/start.sh"]
