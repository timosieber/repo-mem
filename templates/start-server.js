#!/usr/bin/env node

/**
 * repo-mem MCP Server launcher
 * Auto-installs dependencies if missing, then starts the actual server.
 */

import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Auto-install dependencies if missing
if (!existsSync(join(__dirname, 'node_modules', 'better-sqlite3'))) {
  try {
    execSync('npm install --silent', { cwd: __dirname, timeout: 60000, stdio: 'ignore' });
  } catch (e) {
    process.stderr.write(`[repo-mem] npm install failed: ${e.message}\n`);
    process.exit(1);
  }
}

// Now start the actual server
await import('./server.js');
