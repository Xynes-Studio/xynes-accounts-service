import { Hono } from 'hono';
import { getHealth } from '../controllers/health.controller';

export const healthRoute = new Hono();

healthRoute.get('/', getHealth);
