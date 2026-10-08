// This opt-in bundle preserves the original application in ordinary builds.
export const MANUAL_WORKBENCH = import.meta.env.VITE_MANUAL_WORKBENCH === 'true';
