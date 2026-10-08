/** A build-time, same-origin mount path, never a URL or credential carrier. */
export function normalizeWorkbenchBasePath(value?: string): string {
  const path = value?.trim() || '';
  if (!path || path === '/') return '';
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\/?$/.test(path)) {
    throw new Error('VITE_WORKBENCH_BASE_PATH must be a canonical same-origin path');
  }
  return path.replace(/\/$/, '');
}
