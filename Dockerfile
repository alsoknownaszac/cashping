# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage — full dependencies (including dev) + TypeScript compilation
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The generated Prisma client lives under src/ and is gitignored - and excluded
# from the build context by .dockerignore - so it does not exist on a fresh
# clone. It has to be regenerated inside the image before `nest build` compiles
# it. `--no-install` keeps this on the version pinned in package-lock.json rather
# than fetching whatever `latest` happens to point at.
RUN npx --no-install prisma generate

RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage — slim: production node_modules + compiled dist/ only
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /usr/src/app

# `tini` becomes PID 1 (see the ENTRYPOINT at the foot of this file), so a
# SIGTERM that Render or `docker stop` sends lands on a process whose whole job
# is to forward it, rather than on a `/bin/sh` that forked the app and will not
# relay the signal to its child. The app depends on that: `main.ts` calls
# `app.enableShutdownHooks()` to close the Prisma pool and the queue producer on
# SIGTERM, and those hooks only run if Node itself is the process that receives
# it. Installed from Alpine's own repositories rather than copied in.
RUN apk add --no-cache tini

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /usr/src/app/dist ./dist

# The Prisma schema, its migrations and the Prisma 7 config are not inputs to
# `nest build` (the *generated client* is) so the runtime stage would otherwise
# carry none of them, and a `prisma migrate deploy` run inside this container
# would have nothing to read. Render does not run this image any more - the
# service is `runtime: node` and migrates from its own start command, see
# render.yaml - so these copies are for the docker-compose route, where they are
# what makes the CLI usable from inside the container. `prisma` itself is a
# production dependency, so the CLI is already here; the schema, the migrations
# and the config that names the datasource URL are what have to travel. That
# config imports "dotenv/config", which is a dev-only package, so `dotenv` comes
# along too - without it the CLI dies on an unresolved import before it reads a
# single migration.
COPY --from=build /usr/src/app/node_modules/dotenv ./node_modules/dotenv
COPY prisma ./prisma
COPY prisma7.config.ts ./

EXPOSE 3000
USER node

# See the `tini` install above. `--` separates tini's own flags from the command
# it supervises, so the CMD below - or any command passed to `docker run` or
# `docker compose`, which overrides it - is what tini execs and whose signals it
# forwards. Render is not one of those any more (see render.yaml): there, the
# `exec` in the start command does tini's job, by replacing the shell with `node`
# rather than by supervising what a shell forked.
ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "dist/main.js"]
