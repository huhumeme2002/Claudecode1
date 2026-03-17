import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import logger from './lib/logger';

const app = express();
const PORT = parseInt(process.env.ADMIN_PORT || '3001', 10);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Load API routes (admin + user only, NO proxy)
function loadApiRoutes(dir: string, prefix: string = '/api'): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      loadApiRoutes(fullPath, `${prefix}/${entry.name}`);
    } else if (entry.name.endsWith('.js') && !entry.name.includes('.d.') && !entry.name.endsWith('.map') && entry.name !== 'proxy.js') {
      const routeName = entry.name.replace(/\.js$/, '');
      const routePath = `${prefix}/${routeName}`;
      try {
        const mod = require(fullPath);
        const handler = mod.default || mod;
        if (typeof handler === 'function') {
          app.use(routePath, handler);
          logger.debug(`[admin-server] Loaded route: ${routePath}`);
        }
      } catch (err) {
        logger.error(`[admin-server] Failed to load route ${routePath}`, { error: err });
      }
    }
  }
}

const apiDir = path.join(__dirname, 'api');
loadApiRoutes(apiDir);

app.listen(PORT, () => {
  logger.info(`Admin/Dashboard server running on port ${PORT}`);
});

export default app;
