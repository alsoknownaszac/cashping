Cashping — NestJS Build Sequence
A literal step-by-step walkthrough, in order, from project setup to deployment. This sits underneath the architecture plan — that document explains what and why; this one explains how, in order. Follow it top to bottom. Each step names what to build and what "done" looks like before moving to the next one.

Two items identified as MVP-blocking in the architecture plan's gap analysis (decimal precision handling, phone number normalization) are folded into the relevant steps below rather than left as a separate afterthought — they're cheap to do right the first time and expensive to retrofit.

Day 0 — Project Setup & Folder Structure
Step 1 — Initialize the repository

mkdir cashping-backend && cd cashping-backend
git init
npm i -g @nestjs/cli
nest new . --package-manager npm
Done when: a fresh NestJS app runs locally with npm run start:dev and responds on the default port.

Step 2 — Establish the folder structure Set this up before writing any feature code — it mirrors the module breakdown from the architecture plan and keeps bounded contexts separated from day one.

src/
├── main.ts
├── app.module.ts
├── config/
│   ├── configuration.ts        # env var loading/typing
│   └── validation.schema.ts    # class-validator schema for env vars
├── common/
│   ├── decorators/
│   ├── filters/                # global exception filter
│   ├── guards/                 # auth guards, step-up-auth guard
│   ├── interceptors/           # idempotency-key interceptor
│   └── pipes/                  # validation pipe config
├── identity/
│   ├── identity.module.ts
│   ├── controllers/
│   ├── services/
│   └── dto/
├── wallet/                     # Stellar account + signing
│   ├── wallet.module.ts
│   ├── controllers/
│   ├── services/
│   └── dto/
├── payments/
│   ├── payments.module.ts
│   ├── controllers/
│   ├── services/
│   ├── dto/
│   └── jobs/                   # BullMQ processors
├── notifications/
│   ├── notifications.module.ts
│   └── services/                # Africa's Talking client
├── ledger/
│   ├── ledger.module.ts
│   └── services/                # reconciliation, audit log
└── prisma/
    └── prisma.service.ts
prisma/
└── schema.prisma
Done when: the folder tree exists as empty modules that compile and boot together via app.module.ts imports.

Step 3 — Dockerize from the start

Write a multi-stage Dockerfile (build stage with full deps, slim runtime stage copying only dist/ + production node_modules).
Write docker-compose.yml for local dev: api, postgres, redis services.
Add .dockerignore (node_modules, .git, .env).
Done when: docker-compose up boots Postgres + Redis locally, and the API container connects to both.

Audit Checklist — Steps 1–3
Run this after building, before moving to Step 4. Each line should be a verified yes, not an assumption.

 Step 1: npm run start:dev boots without errors; hitting the default endpoint returns a response (not a connection error, not a silent hang).
 Step 2: every folder listed in the tree exists exactly as specified; app.module.ts imports all module stubs and the app still boots cleanly with no unused/orphaned modules.
 Step 3: docker-compose up starts all three services (api, postgres, redis) with no restart-looping containers; the API container can reach Postgres and Redis (verify with a trivial connection test, e.g. a health-check log line on boot, not just "the containers are running").
 .dockerignore excludes node_modules, .git, and .env — confirm none of these ended up inside the built image (docker exec in and check, or inspect image size for a red flag).
If anything fails: fix it before proceeding — do not carry a failed Step 1–3 item forward into Step 4, since everything after this depends on this foundation being solid.

Step 4 — Environment configuration

.env.example listing every required variable (DB URL, Redis URL, JWT secret, Africa's Talking API key, Sentry DSN, AWS credentials/KMS key ID, Stellar network config).
@ne

<!-- ============================================================
     ⚠️  TRUNCATION POINT — TEXT LOST IN TRANSMISSION
     The source paste was cut here, mid-sentence, at "@ne" (i.e.
     "@nestjs/config"). 12,031 characters are missing from this
     point until the marker below, including:
       - the remainder of Step 4 — Environment configuration
       - Step 5 (Prisma setup) — ENTIRELY
       - Step 6 (Sentry) — ENTIRELY
       - Step 7 (Basic CI) — ENTIRELY
       - "Audit Checklist — Steps 4–7" — ENTIRELY
       - Day 1 through Day 5 (Steps 8–34) — ENTIRELY
     Steps 4–7 CANNOT be implemented "exactly as written" or
     audited until this region is supplied. The text on either
     side of this marker is verbatim as received.
     ============================================================ -->

when: every item in Section 5 of the architecture plan has a concrete answer in the codebase, not just an intention.

<!-- (The "Done when:" opening of the line above was also lost on the far side of the truncation point.) -->

Days 6–7 — Buffer
No new features. This time is explicitly for:

Edge cases: expired OTPs, insufficient balance, malformed phone numbers, duplicate handle race conditions, Horizon timeouts.
Bug fixing anything surfaced by the Day 5 security review.
Absorbing any slippage from Days 1–5 — with one developer, treat this buffer as expected, not a sign something went wrong.
Deployment — ECS/Fargate
Step 35 — Production Docker image Confirm the multi-stage Dockerfile from Step 3 produces a slim, production-only image (no dev dependencies, no source maps unless intentionally kept for Sentry).

Step 36 — Push to Amazon ECR Create an ECR repository, authenticate Docker to it, build and push the production image.

Step 37 — Secrets in AWS Secrets Manager Move every value from .env (DB credentials, JWT secret, Africa's Talking key, KMS key reference) into Secrets Manager — never bake secrets into the Docker image or commit them to the ECS task definition in plaintext.

Step 38 — ECS cluster, task definition, and service Create a Fargate cluster, define a task (CPU/memory sized to match the earlier cost estimate — start small, e.g. 0.5 vCPU/1GB), reference the ECR image and Secrets Manager values, and create a service with a target group behind an Application Load Balancer.

Step 39 — Health checks Point the ALB's health check at GET /v1/health (and separately verify /v1/health/stellar manually — don't wire Horizon connectivity into the ALB health check itself, since a Horizon blip shouldn't cause ECS to cycle the container).

Step 40 — Staging smoke test Run the entire register → verify → wallet provision → search recipient → send payment → confirm flow against the deployed staging environment on Stellar Testnet, not just locally — this is the first time the KMS integration, Secrets Manager values, and real network latency are all exercised together.

Step 41 — CI/CD deploy step Extend the Day 0 GitHub Actions workflow with a deploy job (build → push to ECR → force new ECS deployment) gated on the main branch, so future changes ship without a manual console click-through.

Done when: a fresh clone of the repo, with only AWS credentials and the documented env vars, can be built and deployed to a working staging environment by someone who wasn't the original developer — that's the real test of whether this sequence actually captured everything.

This document is the implementation companion to the NestJS architecture plan. If a step here conflicts with something in that plan, the architecture plan's reasoning wins — this is the "in what order" layer on top of it, not a replacement for it.

