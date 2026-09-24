import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFile(path.join(root, file), 'utf8');

describe('Electron packaging contract', () => {
  it('declares Windows x64 NSIS and ZIP plus a per-user data-preserving installer', async () => {
    const config = await read('electron-builder.yml');
    expect(config).toMatch(/target:\s*nsis/);
    expect(config).toMatch(/target:\s*zip/);
    expect(config).toMatch(/- x64/);
    expect(config).toMatch(/perMachine:\s*false/);
    expect(config).toMatch(/deleteAppDataOnUninstall:\s*false/);
    expect(config).toMatch(/requestedExecutionLevel:\s*asInvoker/);
    expect(config).toMatch(/signAndEditExecutable:\s*false/);
    expect(config).toMatch(/appId:\s*local\.yanjian\.academicworkbench/);
  });

  it('keeps the packaged app self-contained and excludes development data', async () => {
    const config = await read('electron-builder.yml');
    expect(config).toContain('- dist/**/*');
    expect(config).toContain('- desktop-dist/**/*');
    expect(config).toContain("- '!**/.dev-data/**'");
    expect(config).toContain("- '!**/.test-data/**'");
    expect(config).toContain("- '!**/.cache/**'");
    expect(config).toContain("- '!node_modules/**'");
    expect(config).toContain("- '!**/*.zip'");
    expect(config).not.toMatch(/^\s*- node_modules/m);
    expect(config).toContain('main: desktop-dist/main.cjs');
  });

  it('uses application-local caches, disables publishing and makes x64 the default', async () => {
    const script = await read('scripts/package-desktop.mjs');
    expect(script).toContain("ELECTRON_BUILDER_CACHE");
    expect(script).toContain("ELECTRON_CACHE");
    expect(script).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'");
    expect(script).toContain("'--publish', 'never'");
    expect(script).toContain("'node_modules', 'electron-builder', 'cli.js'");
    expect(script).toContain("['--win', '--x64']");
    const bundle = await read('scripts/build-desktop.mjs');
    expect(bundle).toContain("outfile: path.join(outputDirectory, 'main.cjs')");
    expect(bundle).toContain("outfile: path.join(outputDirectory, 'preload.cjs')");
    expect(bundle).toContain("'electron'");
  });
});
