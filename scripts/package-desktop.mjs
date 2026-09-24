import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cacheRoot = path.join(projectRoot, '.cache');
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? 'a signal'}`)));
});

async function main() {
  await mkdir(path.join(cacheRoot, 'electron-builder'), { recursive: true });
  await mkdir(path.join(cacheRoot, 'electron'), { recursive: true });
  await mkdir(path.join(cacheRoot, 'tmp'), { recursive: true });

  const userArgs = process.argv.slice(2);
  const skipBundle = userArgs.includes('--skip-build');
  const args = userArgs.filter(arg => arg !== '--skip-build');
  if (!skipBundle) await run(process.execPath, ['scripts/build-desktop.mjs']);

  // Invoke the JS entry through Node so the same command works on Windows
  // without relying on shell execution of a .cmd shim.
  const builder = path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js');
  const targetArgs = args.length ? args : ['--win', '--x64'];
  if (targetArgs.includes('--win') && !targetArgs.some(arg => arg === '--x64' || arg === '--ia32' || arg === '--arm64')) targetArgs.push('--x64');
  const env = {
    ...process.env,
    ELECTRON_BUILDER_CACHE: path.join(cacheRoot, 'electron-builder'),
    ELECTRON_CACHE: path.join(cacheRoot, 'electron'),
    npm_config_cache: path.join(projectRoot, '.npm-cache'),
    TMPDIR: path.join(cacheRoot, 'tmp'),
    TEMP: path.join(cacheRoot, 'tmp'),
    TMP: path.join(cacheRoot, 'tmp'),
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  };
  await run(process.execPath, [builder, '--config', 'electron-builder.yml', '--publish', 'never', ...targetArgs], { env });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
