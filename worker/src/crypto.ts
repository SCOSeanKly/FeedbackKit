const encoder = new TextEncoder();

/** Lower-case hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A fresh installation token: 256 bits of randomness, base64url, with a
 * version prefix so a future token format (for example one bound to an App
 * Attest key) can be told apart at a glance.
 */
export function newInstallationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `fk1_${base64url(bytes)}`;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
