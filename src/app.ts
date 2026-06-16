import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { errorHandler } from './middleware/error-handler';
import { requestIdMiddleware } from './middleware/request-id';
import { internalRoute } from './routes/internal.route';
import { healthRoute } from './routes/health.route';
import { readyRoute } from './routes/ready.route';

const app = new Hono();

app.use('*', requestIdMiddleware());

// H-2 (HEALTHCHECK-CONTRACT.md §2.6): /health and /ready MUST NOT
// generate per-request structured logs. A 30-second healthcheck cadence
// × every probe surface would flood retention without any actionable
// signal — failures already surface via the response status (503) +
// Caddy / Uptime Kuma alerts. Mount honoLogger ONLY on paths the access
// log actually cares about.
const ACCESS_LOG_SKIP_PATHS = new Set<string>(['/health', '/ready']);
app.use('*', async (c, next) => {
  if (ACCESS_LOG_SKIP_PATHS.has(c.req.path)) {
    return next();
  }
  return honoLogger()(c, next);
});

// Health and readiness endpoints (no auth required)
app.route('/health', healthRoute);
app.route('/ready', readyRoute);

// Internal service routes
app.route('/internal', internalRoute);

app.onError(errorHandler);

export default app;
