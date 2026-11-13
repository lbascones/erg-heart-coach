import { defineConfig } from 'vite';
import { handleBackup } from './server/backup.js';

// In development, the Vite dev server also answers /api/backup, so backups can be tested on this PC.
export default defineConfig({
  plugins: [
    {
      name: 'rowing-backup-api',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!(await handleBackup(req, res))) next();
        });
      },
    },
  ],
});
