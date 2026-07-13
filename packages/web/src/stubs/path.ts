export function dirname(p: string) { return p.replace(/[/\\][^/\\]+$/, '') || '.'; }
export function join(...parts: string[]) { return parts.join('/').replace(/\/+/g, '/'); }
export default { dirname, join };
