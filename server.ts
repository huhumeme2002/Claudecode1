import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import logger from './lib/logger';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Dynamic API route loading
function loadApiRoutes(dir: string, prefix: string = '/api'): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      loadApiRoutes(fullPath, `${prefix}/${entry.name}`);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
      const routeName = entry.name.replace(/\.(js|ts)$/, '');
      const routePath = `${prefix}/${routeName}`;
      try {
        const mod = require(fullPath);
        const handler = mod.default || mod;
        if (typeof handler === 'function') {
          app.use(routePath, handler);
          logger.debug(`Loaded route: ${routePath}`);
        }
      } catch (err) {
        logger.error(`Failed to load route ${routePath}`, { error: err });
      }
    }
  }
}

// Load API routes from ./api directory (skip proxy.ts — registered explicitly)
const apiDir = path.join(__dirname, 'api');
loadApiRoutes(apiDir);

// Proxy routes (registered explicitly)
try {
  const proxyModule = require('./api/proxy');
  const proxyHandler = proxyModule.default || proxyModule;
  app.use('/v1', proxyHandler);
  logger.info('Proxy routes registered at /v1');
} catch (err) {
  logger.warn('Proxy module not loaded yet', { error: (err as Error).message });
}

// Admin SPA fallback
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});
app.get('/admin/*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

export default app;
