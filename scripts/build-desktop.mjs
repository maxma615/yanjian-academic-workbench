import { access, mkdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const desktopSource = path.join(projectRoot, 'electron');
const outputDirectory = path.join(projectRoot, 'desktop-dist');
const webBuild = path.join(projectRoot, 'dist', 'index.html');

async function required(file, description) {
  try {
    await access(file);
  } catch {
    throw new Error(`桌面构建缺少${description}: ${path.relative(projectRoot, file)}`);
  }
}

async function main() {
  await required(path.join(desktopSource, 'main.ts'), 'Electron 主入口');
  await required(path.join(desktopSource, 'preload.ts'), 'Electron preload 入口');
  await required(webBuild, 'Web 生产构建；请先运行 npm run build');
  await mkdir(outputDirectory, { recursive: true });

  const external = [...new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`), 'electron'])];
  const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: true,
    external,
    absWorkingDir: projectRoot,
    legalComments: 'none',
    logLevel: 'info',
  };
  // Electron loads the main bundle as CommonJS. Preserve the source module's
  // import.meta.url semantics so resources resolve beside main.cjs. The
  // preload bundle intentionally receives no banner: its sandboxed renderer
  // context should only load Electron's contextBridge/ipcRenderer external.
  const mainOptions = {
    ...common,
    define: { 'import.meta.url': '__desktop_import_meta_url' },
    banner: { js: "const __desktop_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  };
  await build({ ...mainOptions, entryPoints: [path.join(desktopSource, 'main.ts')], outfile: path.join(outputDirectory, 'main.cjs') });
  await build({ ...common, entryPoints: [path.join(desktopSource, 'preload.ts')], outfile: path.join(outputDirectory, 'preload.cjs') });
  console.log(`Electron bundle ready: ${path.relative(projectRoot, outputDirectory)}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
