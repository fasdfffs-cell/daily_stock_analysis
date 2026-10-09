// This opt-in bundle preserves the original application in ordinary builds.
export const NATIVE_RESEARCH = import.meta.env.VITE_NATIVE_RESEARCH === 'true';
export const MANUAL_WORKBENCH = NATIVE_RESEARCH || import.meta.env.VITE_MANUAL_WORKBENCH === 'true';
export const RESEARCH_ROUTES = new Set(['/', '/settings', '/portfolio', '/backtest']);
