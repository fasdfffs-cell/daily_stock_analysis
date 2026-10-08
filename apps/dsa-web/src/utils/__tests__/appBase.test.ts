import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeWorkbenchBasePath } from '../basePath';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('canonical workbench mount path', () => {
  it('keeps root deployments unchanged', () => {
    expect(normalizeWorkbenchBasePath(undefined)).toBe('');
    expect(normalizeWorkbenchBasePath('/')).toBe('');
    expect(normalizeWorkbenchBasePath('/plugins/dsa-workbench/app/')).toBe('/plugins/dsa-workbench/app');
  });
  it.each(['https://other.invalid/app', '//other/app', '/app/../outside', '/app?token=no', '/app#hash', '/a//b', '/a/%2e/b', '/a\\b'])('rejects %s', (value) => {
    expect(() => normalizeWorkbenchBasePath(value)).toThrow();
  });
  it('confines assets, API and SSE to the same app prefix', async () => {
    vi.stubEnv('VITE_WORKBENCH_BASE_PATH', '/plugins/dsa-workbench/app');
    vi.stubEnv('VITE_API_URL', 'https://should-not-be-used.invalid');
    const { appPath, stripAppBase } = await import('../appBase');
    const { API_BASE_URL } = await import('../constants');
    const { analysisApi } = await import('../../api/analysis');
    expect(API_BASE_URL).toBe('/plugins/dsa-workbench/app');
    expect(analysisApi.getTaskStreamUrl()).toBe('/plugins/dsa-workbench/app/api/v1/analysis/tasks/stream');
    expect(appPath('/login')).toBe('/plugins/dsa-workbench/app/login');
    expect(stripAppBase('/plugins/dsa-workbench/app/login')).toBe('/login');
    expect(stripAppBase('/plugins/todo/')).toBeNull();
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetch);
    const { loadStockIndex } = await import('../stockIndexLoader');
    await loadStockIndex();
    expect(fetch.mock.calls[0][0]).toMatch(/^\/plugins\/dsa-workbench\/app\/stocks.index.json\?_t=\d+$/);
  });
  it('returns router-relative login redirects only within the prefix', async () => {
    vi.stubEnv('VITE_WORKBENCH_BASE_PATH', '/plugins/dsa-workbench/app');
    const { resolveLoginRedirect } = await import('../loginRedirect');
    expect(resolveLoginRedirect('/plugins/dsa-workbench/app/?report=2#saved')).toBe('/?report=2#saved');
    for (const path of ['/plugins/todo/', '/login', '/plugins/dsa-workbench/app/login', '//outside.invalid', '/plugins/dsa-workbench/app/../todo']) {
      expect(resolveLoginRedirect(path)).toBe('/');
    }
  });
});
