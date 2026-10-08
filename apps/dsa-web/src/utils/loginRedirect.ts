import { stripAppBase } from './appBase';

/** Resolve a router destination, confined to this app's basename, without login loops. */
export function resolveLoginRedirect(rawRedirect: string | null): string {
  if (!rawRedirect?.startsWith('/') || rawRedirect.startsWith('//') || rawRedirect.includes('\\')) {
    return '/';
  }

  try {
    const target = new URL(rawRedirect, window.location.origin);
    const pathname = decodeURIComponent(target.pathname);
    const appRoute = stripAppBase(pathname);
    if (
      target.origin !== window.location.origin
      || pathname.startsWith('//')
      || pathname.includes('\\')
      || appRoute === null
      || /(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname)
      || /^\/login\/?$/i.test(appRoute)
    ) {
      return '/';
    }
    return `${stripAppBase(target.pathname)}${target.search}${target.hash}`;
  } catch {
    return '/';
  }
}
