// Moved to src/util/downloadState.ts so src/web/static can share it (the web bundles
// with platform:"browser"; this module imports only types, so it is safe from either
// side). Re-exported so existing src/ui callers are untouched.
export { downloadStateFor, deliveryMethod, type DownloadState } from "../util/downloadState";
