// ponytail: browser stub — fs only used by KG.save / cache paths we don't call in web
export function existsSync() { return false; }
export function readFileSync() { throw new Error('fs unavailable in browser'); }
export function writeFileSync() { throw new Error('fs unavailable in browser'); }
export function mkdirSync() { throw new Error('fs unavailable in browser'); }
export default { existsSync, readFileSync, writeFileSync, mkdirSync };
