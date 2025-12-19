import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { errorHandler } from './middleware/error-handler';
import { requestIdMiddleware } from './middleware/request-id';
import { internalRoute } from './routes/internal.route';

const app = new Hono();

app.use('*', requestIdMiddleware());
app.use('*', honoLogger());

app.route('/internal', internalRoute);

app.onError(errorHandler);

export default app;
