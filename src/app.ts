import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { errorHandler } from './middleware/error-handler';
import { requestIdMiddleware } from './middleware/request-id';
import { internalRoute } from './routes/internal.route';
import { healthRoute } from './routes/health.route';
import { readyRoute } from './routes/ready.route';

const app = new Hono();

app.use('*', requestIdMiddleware());
app.use('*', honoLogger());

// Health and readiness endpoints (no auth required)
app.route('/health', healthRoute);
app.route('/ready', readyRoute);

// Internal service routes
app.route('/internal', internalRoute);

app.onError(errorHandler);

export default app;
