# Fixed application template

This is the AD-014 Node 24.20.0 / Vue 3.5.17 / Vite 7.3.6 / Fastify 5.12.3 / Prisma 7.10.0 / MySQL 8 application source. The same Fastify process serves `/api/items` and Vite's production output. `GET /healthz` is always at the server root for an internal health probe. Set `APP_BASE_PATH=/apps/<application-id>/` at both build and runtime; the ingress must preserve that prefix when forwarding requests. The browser requests the API beneath the same base. A release built for one base must be rebuilt if the base changes.

The dependency manifest and lockfile include Prisma's MariaDB adapter. The adapter depends on the LGPL-2.1-or-later MariaDB Connector/Node.js; retain its license when redistributing dependencies. Targeted lockfile overrides raise `mariadb`, `mysql2`, and `deepmerge-ts` to audited patch versions; `npm audit` reported zero vulnerabilities when this lockfile was generated. Audit results are time-dependent and do not replace the Platform's isolated validation or license review at release time.

From this directory, with Node 24.20.0 and a trusted registry/lockfile:

```sh
npm ci
npm run type-check
npm test
npm run build
```

For an isolated MySQL 8 database only, inject `DATABASE_URL` from the environment (never commit real credentials):

```sh
npm run db:migrate:status
npm run db:migrate:deploy
```

`db:migrate:deploy` applies only the committed SQL migration; it does not check schema drift or migration compatibility. The Platform's migration gate must review SQL and control isolated/production execution. Never run `migrate reset` on existing data or let an Agent connect to Production. To run the built server, set `DATABASE_URL`, `APP_BASE_PATH`, `HOST` and `PORT`, then run `npm start`. `HOST=0.0.0.0` is needed inside a container; the container must not publish its port to the host. This template's item API is public example data, not an authentication or authorization implementation for sensitive business data.

For a local, synthetic smoke check with preexisting `mysql:8.0.46` and the pinned Node base image, run `bash scripts/verify-isolated.sh` after `npm ci`. This builds a dedicated validation image using the official Debian security package `libssl3=3.0.22-1~deb12u1` (Apache-2.0 upstream); builds require the Debian package repository and fail if the pinned version is unavailable. OpenSSL 3.0 has ended upstream public support, so review Debian security maintenance before any long-lived deployment. The check creates and removes an internal network and disposable containers without host ports or mounts; local test images remain cached. Its temporary application workspace allows executable files because the test streams host-installed tools into tmpfs. Production Sandbox and Deployment images must bake locked dependencies into their own read-only layers. This script does not validate the Platform migration admission gate or approve the test image for production.

`npm run dev` runs only the Vite frontend; API calls require the Fastify process at the same base or a separately configured local proxy. Use `npm run build` and `npm start` for the single-server verification. Local Node tests use the built-in test runner; database migration verification requires a separately provisioned isolated MySQL 8 instance.
