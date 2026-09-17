const DOWNLOAD_REVOKE_MS = 1000;

export function createJsonDownload(options: { mount: HTMLElement; signal: AbortSignal }) {
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();
  options.signal.addEventListener('abort', () => {
    for (const [url, timeout] of downloads) {
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
    }
    downloads.clear();
  }, { once: true });

  return (filename: string, text: string): void => {
    if (options.signal.aborted) throw new Error('Cannot export from a disposed editor.');
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    downloads.set(url, setTimeout(() => {
      URL.revokeObjectURL(url);
      downloads.delete(url);
    }, DOWNLOAD_REVOKE_MS));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    options.mount.append(link);
    link.click();
    link.remove();
  };
}
