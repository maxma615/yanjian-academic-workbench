import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import * as asar from '@electron/asar';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseDirectory = path.join(projectRoot, 'release');
const outputPath = path.join(releaseDirectory, 'package-verification.json');
const managedRoots = ['dist', 'desktop-dist'];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function filesUnder(relativeRoot) {
  const result = [];
  async function visit(relative) {
    const absolute = path.join(projectRoot, relative);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) result.push(child.split(path.sep).join('/'));
      else throw new Error(`当前构建目录含非普通文件：${child}`);
    }
  }
  await visit(relativeRoot);
  return result.sort();
}

async function latestFile(extension) {
  let entries;
  try { entries = await readdir(releaseDirectory, { withFileTypes: true }); } catch { return undefined; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(extension)) continue;
    const file = path.join(releaseDirectory, entry.name);
    candidates.push({ file, mtime: (await stat(file)).mtimeMs });
  }
  return candidates.sort((a, b) => b.mtime - a.mtime)[0]?.file;
}

function sameFileState(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
}

async function asarFromZip(zipBytes, zipPath, temporaryDirectory) {
  const archive = unzipSync(zipBytes, {
    filter: file => /(?:^|\/)resources\/app\.asar$/i.test(file.name),
  });
  const name = Object.keys(archive).find(candidate => /(?:^|\/)resources\/app\.asar$/i.test(candidate));
  if (!name) throw new Error(`ZIP 中未找到 resources/app.asar：${path.basename(zipPath)}`);
  const asarPath = path.join(temporaryDirectory, 'app.asar');
  await writeFile(asarPath, archive[name]);
  return asarPath;
}

async function verifyAsar(asarPath, currentFiles) {
  const errors = [];
  const files = [];
  const archiveEntries = asar.listPackage(asarPath).map(entry => entry.replace(/^\/+/, ''));
  const archiveFiles = archiveEntries.filter(entry => {
    try { return typeof asar.statFile(asarPath, entry).size === 'number'; } catch { return false; }
  }).sort();
  const expectedFiles = [...currentFiles, 'package.json'].sort();
  const expectedSet = new Set(expectedFiles);
  for (const entry of archiveFiles) if (!expectedSet.has(entry)) errors.push(`ASAR 含未授权文件：${entry}`);
  for (const entry of expectedFiles) if (!archiveFiles.includes(entry)) errors.push(`ASAR 缺少构建文件：${entry}`);

  for (const relative of currentFiles) {
    const sourceBytes = await readFile(path.join(projectRoot, relative));
    let embeddedBytes;
    try { embeddedBytes = asar.extractFile(asarPath, relative); }
    catch {
      errors.push(`ASAR 缺少或无法读取：${relative}`);
      files.push({ path: relative, byteSize: sourceBytes.length, sourceSha256: sha256(sourceBytes), embeddedSha256: null, matches: false });
      continue;
    }
    const sourceHash = sha256(sourceBytes), embeddedHash = sha256(embeddedBytes);
    const item = { path: relative, byteSize: sourceBytes.length, sourceSha256: sourceHash, embeddedSha256: embeddedHash, matches: sourceHash === embeddedHash && sourceBytes.length === embeddedBytes.length };
    files.push(item);
    if (!item.matches) errors.push(`ASAR 与当前文件不一致：${relative}`);
  }
  try {
    const metadata = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
    if (metadata.main !== 'desktop-dist/main.cjs') errors.push(`ASAR package.json main 无效：${metadata.main ?? '(missing)'}`);
  } catch (error) { errors.push(`ASAR package.json 无法读取：${error instanceof Error ? error.message : String(error)}`); }
  return { archiveFiles, files, errors };
}

async function main() {
  const requestedZip = argument('--zip');
  const zipPath = requestedZip ? path.resolve(projectRoot, requestedZip) : await latestFile('.zip');
  const zipInfo = zipPath && await stat(zipPath).catch(() => undefined);
  if (!zipPath || !zipInfo?.isFile()) throw new Error('未找到 ZIP 产物；请传入 --zip release/<file>.zip');
  const currentFiles = (await Promise.all(managedRoots.map(filesUnder))).flat().sort();
  if (!currentFiles.length) throw new Error('当前 dist/desktop-dist 没有可校验文件，请先构建');

  await mkdir(path.join(projectRoot, '.cache'), { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(projectRoot, '.cache', 'desktop-verify-'));
  const requestedAsar = argument('--asar');
  const errors = [];
  try {
    const zipBytes = await readFile(zipPath);
    const zipAfterRead = await stat(zipPath);
    if (!sameFileState(zipInfo, zipAfterRead)) throw new Error('ZIP 在读取期间发生变化；请等待 electron-builder 完全退出后重试');
    const zipAsarPath = await asarFromZip(zipBytes, zipPath, temporaryDirectory);
    const zipResult = await verifyAsar(zipAsarPath, currentFiles);
    errors.push(...zipResult.errors.map(error => `ZIP 内 ${error}`));
    const additional = [];
    if (requestedAsar) {
      const directoryAsarPath = path.resolve(projectRoot, requestedAsar);
      const directoryInfo = await stat(directoryAsarPath).catch(() => undefined);
      if (!directoryInfo?.isFile()) throw new Error(`未找到额外 ASAR：${requestedAsar}`);
      const directoryResult = await verifyAsar(directoryAsarPath, currentFiles);
      errors.push(...directoryResult.errors.map(error => `额外 ASAR ${error}`));
      additional.push({ path: path.relative(projectRoot, directoryAsarPath), entries: directoryResult.archiveFiles, files: directoryResult.files });
    }
    const zipFinalState = await stat(zipPath);
    if (!sameFileState(zipInfo, zipFinalState)) throw new Error('ZIP 在校验期间发生变化；请等待 electron-builder 完全退出后重试');

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceRoot: projectRoot,
      zip: { path: path.relative(projectRoot, zipPath), byteSize: zipBytes.length, sha256: sha256(zipBytes) },
      asar: { path: 'ZIP:resources/app.asar', entries: zipResult.archiveFiles },
      files: zipResult.files,
      additionalAsar: additional,
      ok: errors.length === 0,
      errors,
    };
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`${report.ok ? 'PASS' : 'FAIL'} desktop package verification: ${path.relative(projectRoot, outputPath)}`);
    console.log(`ZIP SHA-256: ${report.zip.sha256}`);
    if (!report.ok) for (const error of errors) console.error(`- ${error}`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch(async error => {
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), sourceRoot: projectRoot, ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n').catch(() => undefined);
  console.error(`FAIL desktop package verification: ${report.errors[0]}`);
  process.exitCode = 1;
});
