import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Keep the development runtime's temporary/cache files inside this application.
const runtimeDirectory = path.resolve('.cache/runtime');
await mkdir(runtimeDirectory, { recursive: true });
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TSX_DISABLE_CACHE: '1', TMPDIR: runtimeDirectory, TEMP: runtimeDirectory, TMP: runtimeDirectory },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
