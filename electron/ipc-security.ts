export type IpcSenderLike = {
  sender?: { id?: number };
  senderFrame?: { url?: string } | null;
};

/** IPC must come from the one BrowserWindow and from the loopback app origin. */
export function isTrustedIpcSender(
  event: IpcSenderLike,
  expectedWebContentsId: number,
  expectedOrigin: string,
): boolean {
  if (event.sender?.id !== expectedWebContentsId) return false;
  const raw = event.senderFrame?.url;
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.origin === expectedOrigin && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch {
    return false;
  }
}
