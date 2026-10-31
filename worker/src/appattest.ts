/**
 * Apple App Attest verification, dependency-free (WebCrypto + hand-rolled
 * DER and CBOR readers). Ported from the NuKey theme Worker.
 *
 * Trust anchor: Apple App Attestation Root CA. No client-supplied root is
 * ever trusted.
 *
 * Two operations:
 *   verifyAttestation  one-time proof that a key was created in the Secure
 *                      Enclave of a genuine device running our app
 *   verifyAssertion    per-request signature over (authenticatorData ||
 *                      SHA-256(clientData)) with a strictly increasing counter
 */

const ROOT_CERT_BASE64 =
  'MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD';

export class AttestError extends Error {
  constructor(readonly reason: string) {
    super(`app attest: ${reason}`);
  }
}

export interface VerifiedAttestation {
  /** SubjectPublicKeyInfo of the attested key (DER). */
  spki: Uint8Array;
  validationCategory: number;
  bundleVersion: string;
}

export interface VerifiedAssertion {
  counter: number;
  validationCategory: number;
  bundleVersion: string;
}

/**
 * @param attestation  CBOR attestation object from `attestKey`
 * @param keyID        Apple's key identifier (base64 of SHA-256 of the public key)
 * @param challenge    the server-issued challenge bytes the client hashed as clientDataHash
 * @param appID        "<team id>.<bundle id>"
 */
export async function verifyAttestation(
  attestation: Uint8Array,
  keyID: string,
  challenge: Uint8Array,
  appID: string,
  allowDevelopment: boolean,
): Promise<VerifiedAttestation> {
  const object = decodeCBOR(attestation).value;
  if (!(object instanceof Map) || object.get('fmt') !== 'apple-appattest') throw new AttestError('format');
  const statement = object.get('attStmt');
  const authData = object.get('authData');
  const chain = statement instanceof Map ? statement.get('x5c') : undefined;
  if (!(authData instanceof Uint8Array) || !Array.isArray(chain) || chain.length < 2) throw new AttestError('shape');

  const leaf = parseCertificate(chain[0] as Uint8Array);
  const intermediate = parseCertificate(chain[1] as Uint8Array);
  const root = parseCertificate(fromBase64(ROOT_CERT_BASE64));
  if (!(await verifyCertificate(leaf, intermediate))) throw new AttestError('leaf certificate');
  if (!(await verifyCertificate(intermediate, root))) throw new AttestError('certificate chain');

  const nonce = await sha256(concat(authData, await sha256(challenge)));
  if (!equal(leaf.appAttestNonce, nonce)) throw new AttestError('nonce');

  const keyIDBytes = fromBase64(keyID);
  if (!equal(await sha256(leaf.publicPoint), keyIDBytes)) throw new AttestError('key id');
  if (!equal(authData.slice(0, 32), await sha256(utf8(appID)))) throw new AttestError('app id');
  if (readU32(authData, 33) !== 0) throw new AttestError('counter');

  const aaguid = new TextDecoder().decode(authData.slice(37, 53)).replace(/\0+$/, '');
  const allowed =
    aaguid === 'appattest' || (allowDevelopment && (aaguid === 'appattestdevelop' || aaguid === 'appattestsandbox'));
  if (!allowed) throw new AttestError('environment');

  const credentialLength = (authData[53]! << 8) | authData[54]!;
  const credentialID = authData.slice(55, 55 + credentialLength);
  if (!equal(credentialID, keyIDBytes)) throw new AttestError('credential');

  // Skip the fixed 77-byte P-256 COSE key, then read Apple's extensions.
  const extensions = decodeCBOR(authData, 55 + credentialLength + 77).value;
  const validationCategory = readValidationCategory(mapValue(extensions, 'apple_validation_category_01'));
  const bundleVersion = readText(mapValue(extensions, 'apple_bundle_version_01'));
  if (!Number.isInteger(validationCategory) || validationCategory! < 2 || validationCategory! > 6) {
    throw new AttestError('validation category');
  }
  if (typeof bundleVersion !== 'string' || bundleVersion.length === 0) throw new AttestError('bundle version');

  return { spki: leaf.spki, validationCategory: validationCategory!, bundleVersion };
}

/**
 * @param assertion        CBOR { signature, authenticatorData } from `generateAssertion`
 * @param clientData       the exact bytes the client hashed as clientDataHash
 * @param spki             stored public key
 * @param previousCounter  stored counter; the assertion's must be greater
 */
export async function verifyAssertion(
  assertion: Uint8Array,
  clientData: Uint8Array,
  spki: Uint8Array,
  previousCounter: number,
  appID: string,
): Promise<VerifiedAssertion> {
  const object = decodeCBOR(assertion).value;
  const authData = mapValue(object, 'authenticatorData');
  const signature = mapValue(object, 'signature');
  if (!(authData instanceof Uint8Array) || !(signature instanceof Uint8Array)) throw new AttestError('assertion shape');
  if (!equal(authData.slice(0, 32), await sha256(utf8(appID)))) throw new AttestError('assertion app id');

  const counter = readU32(authData, 33);
  if (counter <= previousCounter) throw new AttestError('assertion replay');
  if (authData.length <= 37) throw new AttestError('missing assertion extensions');

  const extensions = decodeCBOR(authData, 37).value;
  const validationCategory = readValidationCategory(mapValue(extensions, 'apple_validation_category_01'));
  const bundleVersion = readText(mapValue(extensions, 'apple_bundle_version_01'));
  if (!Number.isInteger(validationCategory) || validationCategory! < 2 || validationCategory! > 6) {
    throw new AttestError('assertion validation category');
  }
  if (typeof bundleVersion !== 'string' || bundleVersion.length === 0 || bundleVersion.length > 64) {
    throw new AttestError('assertion bundle version');
  }

  const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  // App Attest signs SHA-256(authData || SHA-256(clientData)); WebCrypto hashes
  // the supplied message itself, so pass that nonce as the message.
  const nonce = await sha256(concat(authData, await sha256(clientData)));
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derSignatureToRaw(signature, 32), nonce);
  if (!valid) throw new AttestError('assertion signature');

  return { counter, validationCategory: validationCategory!, bundleVersion };
}

// MARK: - X.509 (just enough for Apple's chain)

interface DerNode {
  tag: number;
  start: number;
  contentStart: number;
  end: number;
}

interface ParsedCertificate {
  tbs: Uint8Array;
  spki: Uint8Array;
  publicPoint: Uint8Array;
  signature: Uint8Array;
  signatureAlgorithm: string;
  appAttestNonce: Uint8Array | null;
  notBefore: number;
  notAfter: number;
}

function parseCertificate(bytes: Uint8Array): ParsedCertificate {
  const cert = derNode(bytes, 0);
  const top = derChildren(bytes, cert);
  const tbs = top[0]!;
  const tbsChildren = derChildren(bytes, tbs);
  let index = tbsChildren[0]!.tag === 0xa0 ? 1 : 0;
  index += 5; // serial, signature, issuer, validity, subject
  const spkiNode = tbsChildren[index]!;
  const spki = bytes.slice(spkiNode.start, spkiNode.end);
  const spkiChildren = derChildren(bytes, spkiNode);
  const publicPoint = bytes.slice(spkiChildren[1]!.contentStart + 1, spkiChildren[1]!.end);

  let nonce: Uint8Array | null = null;
  const extensionContainer = tbsChildren.find((node) => node.tag === 0xa3);
  if (extensionContainer) {
    const sequence = derChildren(bytes, extensionContainer)[0]!;
    for (const extension of derChildren(bytes, sequence)) {
      const fields = derChildren(bytes, extension);
      if (oid(bytes.slice(fields[0]!.contentStart, fields[0]!.end)) === '1.2.840.113635.100.8.2') {
        const last = fields[fields.length - 1]!;
        const wrapped = bytes.slice(last.contentStart, last.end);
        let inner = derNode(wrapped, 0);
        while (inner.tag !== 0x04) {
          const children = derChildren(wrapped, inner);
          if (children.length !== 1) throw new AttestError('nonce extension');
          inner = children[0]!;
        }
        nonce = wrapped.slice(inner.contentStart, inner.end);
      }
    }
  }

  const validity = tbsChildren[index - 2]!;
  const [notBeforeNode, notAfterNode] = derChildren(bytes, validity);
  const notBefore = asn1Time(bytes.slice(notBeforeNode!.contentStart, notBeforeNode!.end));
  const notAfter = asn1Time(bytes.slice(notAfterNode!.contentStart, notAfterNode!.end));
  const signature = bytes.slice(top[2]!.contentStart + 1, top[2]!.end);
  return {
    tbs: bytes.slice(tbs.start, tbs.end),
    spki,
    publicPoint,
    signature,
    signatureAlgorithm: oidFromAlgorithm(bytes, top[1]!),
    appAttestNonce: nonce,
    notBefore,
    notAfter,
  };
}

async function verifyCertificate(certificate: ParsedCertificate, issuer: ParsedCertificate): Promise<boolean> {
  const now = Date.now();
  if (now < certificate.notBefore || now > certificate.notAfter) return false;
  const curve = issuer.publicPoint.length === 97 ? 'P-384' : 'P-256';
  const size = curve === 'P-384' ? 48 : 32;
  const hash = certificate.signatureAlgorithm === '1.2.840.10045.4.3.3' ? 'SHA-384' : 'SHA-256';
  const key = await crypto.subtle.importKey('spki', issuer.spki, { name: 'ECDSA', namedCurve: curve }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash }, key, derSignatureToRaw(certificate.signature, size), certificate.tbs);
}

function oidFromAlgorithm(bytes: Uint8Array, node: DerNode): string {
  const first = derChildren(bytes, node)[0]!;
  return oid(bytes.slice(first.contentStart, first.end));
}

function derNode(bytes: Uint8Array, offset: number): DerNode {
  const start = offset;
  const tag = bytes[offset++]!;
  let length = bytes[offset++]!;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++]!;
  }
  return { tag, start, contentStart: offset, end: offset + length };
}

function derChildren(bytes: Uint8Array, node: DerNode): DerNode[] {
  const children: DerNode[] = [];
  for (let offset = node.contentStart; offset < node.end; ) {
    const child = derNode(bytes, offset);
    children.push(child);
    offset = child.end;
  }
  return children;
}

function oid(bytes: Uint8Array): string {
  const parts = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let value = 0;
  for (const byte of bytes.slice(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

function asn1Time(bytes: Uint8Array): number {
  const value = new TextDecoder().decode(bytes);
  const yearDigits = value.length === 13 ? 2 : 4;
  let year = Number(value.slice(0, yearDigits));
  if (yearDigits === 2) year += year >= 50 ? 1900 : 2000;
  const o = yearDigits;
  return Date.UTC(
    year,
    Number(value.slice(o, o + 2)) - 1,
    Number(value.slice(o + 2, o + 4)),
    Number(value.slice(o + 4, o + 6)),
    Number(value.slice(o + 6, o + 8)),
    Number(value.slice(o + 8, o + 10)),
  );
}

function derSignatureToRaw(signature: Uint8Array, size: number): Uint8Array {
  const sequence = derNode(signature, 0);
  const [rNode, sNode] = derChildren(signature, sequence);
  const integer = (node: DerNode) => {
    let value = signature.slice(node.contentStart, node.end);
    while (value.length > size && value[0] === 0) value = value.slice(1);
    const padded = new Uint8Array(size);
    padded.set(value, size - value.length);
    return padded;
  };
  return concat(integer(rNode!), integer(sNode!));
}

// MARK: - CBOR (subset used by App Attest)

type CBORValue = number | string | Uint8Array | CBORValue[] | Map<CBORValue, CBORValue> | boolean | null;

export function decodeCBOR(bytes: Uint8Array, start = 0): { value: CBORValue; offset: number } {
  let offset = start;
  const read = (): CBORValue => {
    const initial = bytes[offset++]!;
    const major = initial >> 5;
    const additional = initial & 31;
    let length: number;
    if (additional < 24) length = additional;
    else if (additional === 24) length = bytes[offset++]!;
    else if (additional === 25) {
      length = (bytes[offset]! << 8) | bytes[offset + 1]!;
      offset += 2;
    } else if (additional === 26) {
      length = readU32(bytes, offset);
      offset += 4;
    } else throw new AttestError('unsupported CBOR');
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2) {
      const value = bytes.slice(offset, offset + length);
      offset += length;
      return value;
    }
    if (major === 3) {
      const value = new TextDecoder().decode(bytes.slice(offset, offset + length));
      offset += length;
      return value;
    }
    if (major === 4) return Array.from({ length }, read);
    if (major === 5) {
      const map = new Map<CBORValue, CBORValue>();
      for (let i = 0; i < length; i++) {
        const key = read();
        map.set(key, read());
      }
      return map;
    }
    if (major === 7 && additional === 20) return false;
    if (major === 7 && additional === 21) return true;
    if (major === 7 && additional === 22) return null;
    throw new AttestError('unsupported CBOR value');
  };
  const value = read();
  return { value, offset };
}

function mapValue(value: CBORValue, key: string): CBORValue | undefined {
  return value instanceof Map ? value.get(key) : undefined;
}

function readValidationCategory(value: CBORValue | undefined): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  // Apple currently carries this UInt32 extension in little-endian bytes.
  if (value instanceof Uint8Array && value.length === 4) {
    return (value[0]! | (value[1]! << 8) | (value[2]! << 16) | (value[3]! << 24)) >>> 0;
  }
  return undefined;
}

function readText(value: CBORValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined;
}

// MARK: - Bytes

export function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! * 0x1000000 + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!) >>> 0;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Constant-time comparison. */
export function equal(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let value = 0;
  for (let i = 0; i < a.length; i++) value |= a[i]! ^ b[i]!;
  return value === 0;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function fromBase64url(value: string): Uint8Array {
  return fromBase64(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
}

export function toBase64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

export function toBase64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
