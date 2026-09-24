import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { createApp } from './app';

const production = process.argv.includes('--production');
const systemData = process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local')) : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : (process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share'));
const dataDirectory = path.resolve(process.env.ACADEMIC_DATA_DIR ?? (production ? path.join(systemData, 'YanJian/workspace') : '.dev-data/workspace'));
const controlDirectory = path.resolve(process.env.ACADEMIC_CONTROL_DIR ?? (production ? path.join(systemData, 'YanJian/control') : '.dev-data/control'));
const instance = await createApp(dataDirectory, { controlDirectory });
const server = createServer(instance.app);
let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
if (!production) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  instance.app.use(vite.middlewares);
} else {
  instance.app.use(express.static(path.resolve('dist')));
  instance.app.get('/{*path}', (_req, res) => { res.sendFile(path.resolve('dist/index.html')); });
}
let port = Number(process.env.ACADEMIC_PORT ?? 5178);
for (;;) {
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); break; }
  catch (error: any) { if (error.code !== 'EADDRINUSE' || process.env.ACADEMIC_STRICT_PORT === '1') throw error; port++; }
}
const address = server.address();
if (address && typeof address !== 'string') port = address.port;
console.log(`研笺开发预览：http://127.0.0.1:${port}`);
console.log(`资料目录：${instance.getWorkspace().root}`);
console.log('验证范围：当前开发机；Windows 11 安装与系统集成尚待实机验收。');
let exiting = false;
async function shutdown() { if (exiting) return; exiting = true; server.close(); await vite?.close(); await instance.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
