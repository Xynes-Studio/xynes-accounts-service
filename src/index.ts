import app from './app';
import { config } from './infra/config';
import { logger } from './infra/logger';
import { registerAccountsActions } from './actions/register';

const port = parseInt(config.server.PORT, 10);

registerAccountsActions();

logger.info(`Server is starting on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
