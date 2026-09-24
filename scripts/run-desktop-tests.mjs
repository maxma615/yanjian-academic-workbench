import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const temporary = path.resolve('.cache/desktop-tmp');
await mkdir(temporary, { recursive: true });
const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.desktop.config.ts', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_CACHE: path.resolve('.cache/electron'), TMPDIR: temporary, TEMP: temporary, TMP: temporary },
});
child.on('exit', code => process.exit(code ?? 1));
