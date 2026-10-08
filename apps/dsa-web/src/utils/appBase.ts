import { normalizeWorkbenchBasePath } from './basePath';

export const WORKBENCH_BASE_PATH = normalizeWorkbenchBasePath(import.meta.env.VITE_WORKBENCH_BASE_PATH);

/** Prefix paths used outside React Router (assets, HTTP redirects and APIs). */
export function appPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('Expected an app-relative absolute path');
  }
  return `${WORKBENCH_BASE_PATH}${path}`;
}

/** Router destinations omit the basename; reject destinations outside this app. */
export function stripAppBase(path: string): string | null {
  if (!WORKBENCH_BASE_PATH) return path;
  if (path === WORKBENCH_BASE_PATH) return '/';
  return path.startsWith(`${WORKBENCH_BASE_PATH}/`) ? path.slice(WORKBENCH_BASE_PATH.length) : null;
}
