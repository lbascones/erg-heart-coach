import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { handleBackup } from './server/backup.js';

/** The git commit being built, recorded in diagnostics files. */
function appVersion() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

// In development, the Vite dev server also answers /api/backup, so backups can be tested on this PC.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
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
