import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { EncryptedCredentialStore } from '../../electron/credentials';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() { await fs.mkdir('.test-data', { recursive: true }); const root = await fs.mkdtemp(path.resolve('.test-data/credential-')); roots.push(root); return root; }
function cipher() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
    decryptString(value: Buffer) { const d = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return d.update(value.subarray(28), undefined, 'utf8') + d.final('utf8'); },
  };
}
it('stores only encrypted credentials outside the workspace and disconnect removes them', async () => {
  const root = await fixture(), safe = cipher(), store = new EncryptedCredentialStore(root, safe);
  const token = 'synthetic-test-credential-never-a-real-token';
  await store.set(token);
  expect(await store.get()).toBe(token);
  const files = await fs.readdir(root); expect(files).toEqual(['github-credential.bin']);
  expect((await fs.readFile(path.join(root, files[0]))).includes(Buffer.from(token))).toBe(false);
  expect(await new EncryptedCredentialStore(root, safe).get()).toBe(token);
  await store.delete(); expect(await store.get()).toBeNull(); expect(await fs.readdir(root)).toEqual([]);
});
it('fails closed when secure storage is unavailable or uses a plaintext backend', async () => {
  const root = await fixture(), safe = cipher();
  await expect(new EncryptedCredentialStore(root, { ...safe, isEncryptionAvailable: () => false }).set('test')).rejects.toThrow(/安全存储/);
  await expect(new EncryptedCredentialStore(root, { ...safe, getSelectedStorageBackend: () => 'basic_text' }).set('test')).rejects.toThrow(/安全存储/);
  expect(await fs.readdir(root)).toEqual([]);
});
it('does not follow credential-file links or expose ciphertext decryption errors', async () => {
  const root = await fixture(), safe = cipher(), store = new EncryptedCredentialStore(root, safe);
  const outside = await fixture(); await fs.writeFile(path.join(outside, 'file'), 'existing');
  await fs.symlink(path.join(outside, 'file'), path.join(root, 'github-credential.bin'));
  await expect(store.get()).rejects.toThrow(); await expect(store.set('test')).rejects.toThrow();
  expect(await fs.readFile(path.join(outside, 'file'), 'utf8')).toBe('existing');
});
