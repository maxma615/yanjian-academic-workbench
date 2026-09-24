import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
mkdirSync('.test-data/browser-tmp', { recursive: true });
const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.resolve('.cache/ms-playwright'), TMPDIR: path.resolve('.test-data/browser-tmp') },
});
child.on('exit', code => process.exit(code ?? 1));
