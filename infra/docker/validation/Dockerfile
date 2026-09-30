# Build with: docker build --pull=false -f infra/docker/validation/Dockerfile -t issue79-validation-runtime:local assets/application-template
# Only the allowlisted .dockerignore entries enter this context. Never send the repository root.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# Prisma migration CLI loads OpenSSL 3. Fail the build if the security package is unavailable.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3=3.0.22-1~deb12u1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/validation
COPY package.json package-lock.json ./
COPY prisma.config.ts ./
COPY prisma/schema.prisma prisma/schema.prisma
COPY scripts/validate-candidate.mjs runner.mjs
RUN npm ci --no-audit --no-fund && ./node_modules/.bin/prisma generate \
    && chmod -R a+rX /opt/validation
LABEL com.zdan.paimeng.validation.lock-sha256="ab59c23c9f878615a88dcc1bc03c39159abb6c8f782b86deb82cc8c22573ac26"
ENV HOME=/tmp npm_config_cache=/tmp/.npm npm_config_update_notifier=false XDG_CACHE_HOME=/tmp/.cache \
    PATH=/opt/validation/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /workspace/app
USER node
CMD ["sleep", "infinity"]
