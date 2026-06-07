# Single backend image for both the API and the worker.
#
# Why one image for both: the workspace is tightly interlinked (`@nessie/api`
# depends on `@nessie/worker`, both depend on the shared `packages/*` and on the
# Prisma client generated from `api/prisma/schema.prisma`). Building the whole
# workspace once and selecting the entrypoint per container is simpler and more
# reliable than maintaining two partial-copy builds that each have to re-derive
# the Prisma client. The API runs `api/dist/index.js`; the worker container
# overrides the command to run `worker/dist/index.js`.
FROM node:22-slim

WORKDIR /app

# openssl + ca-certificates: Prisma's query engine needs libssl to load, and the
# slim base omits it (otherwise Prisma warns and falls back to the wrong engine).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Full workspace: a frozen install validates every workspace member, so all
# package manifests must be present. The root .dockerignore trims node_modules,
# build output, git, screenshots, and other non-build cruft from the context.
COPY . .

RUN pnpm install --frozen-lockfile --filter='!@nessie/mobile' --filter='!@nessie/desktop'

# Generate the Prisma client into node_modules before building any package that
# imports it (@nessie/db → @prisma/client).
RUN pnpm --filter @nessie/api exec prisma generate --schema prisma/schema.prisma

# turbo build resolves the ^build dependency graph, so this builds the shared
# packages, the worker, and the API in the correct order.
RUN pnpm exec turbo run build --filter=@nessie/api --filter=@nessie/worker

ENV NODE_ENV=production

EXPOSE 5554

CMD ["node", "api/dist/index.js"]
