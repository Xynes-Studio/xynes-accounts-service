import { Hono } from 'hono';
import { getReady } from '../controllers/ready.controller';

export const readyRoute = new Hono();

readyRoute.get('/', getReady);
