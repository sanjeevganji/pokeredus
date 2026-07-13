// ponytail: browser stub — fingerprint hashing not needed for web UI
export function createHash() {
  return {
    update() { return this; },
    digest() { return 'web-stub'; },
  };
}
