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

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /usr/src/app/dist ./dist

EXPOSE 3000
USER node

CMD ["node", "dist/main.js"]
