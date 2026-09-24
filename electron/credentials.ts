import * as fs from 'node:fs/promises';
import { AppError, atomicWrite, exists, readSafe, safePath } from '../server/fs-safe';

export interface SecureStringCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(bytes: Buffer): string;
  getSelectedStorageBackend?(): string;
}

/** Stores only platform-encrypted bytes in the application's control directory. */
export class EncryptedCredentialStore {
  private readonly file = 'github-credential.bin';
  constructor(private readonly directory: string, private readonly cipher: SecureStringCipher) {}
  private assertSecure() {
    if (!this.cipher.isEncryptionAvailable() || this.cipher.getSelectedStorageBackend?.() === 'basic_text') throw new AppError('系统安全存储不可用，尚未保存任何连接凭据');
  }
  async get(): Promise<string | null> {
    await fs.mkdir(this.directory, { recursive: true });
    if (!await exists(await safePath(this.directory, this.file))) return null;
    this.assertSecure();
    const bytes = await readSafe(this.directory, this.file);
    try { return this.cipher.decryptString(bytes); }
    catch { throw new AppError('无法解密现有连接凭据，请重新连接私人仓库'); }
  }
  async set(value: string): Promise<void> {
    this.assertSecure();
    if (typeof value !== 'string' || !value.length || value.length > 8192 || /[\r\n]/.test(value) || value !== value.trim()) throw new AppError('连接凭据格式无效');
    await fs.mkdir(this.directory, { recursive: true });
    await atomicWrite(this.directory, this.file, this.cipher.encryptString(value));
  }
  async delete(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    await fs.rm(await safePath(this.directory, this.file), { force: true });
  }
}
