import {
  arrayBufferToBase64,
  base64ToUint8Array,
  signTechnicalChallenge
} from './deviceCrypto';

const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function getSubtle(): SubtleCrypto {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || !cryptoObj.subtle || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('Web Crypto API (SubtleCrypto) no está disponible en este entorno.');
  }
  return cryptoObj.subtle;
}

/**
 * Genera una invitación efímera de un solo uso de 8 caracteres (4+4 legible).
 */
export function generateEphemeralPairingCode(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < bytes.length; i++) {
    code += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Importa la clave pública ECDH P-256 SPKI del dispositivo par.
 */
export async function importPeerEcdhPublicKey(spkiBase64: string): Promise<CryptoKey> {
  const subtle = getSubtle();
  const keyBytes = base64ToUint8Array(spkiBase64);
  return subtle.importKey(
    'spki',
    keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
    {
      name: 'ECDH',
      namedCurve: 'P-256'
    },
    true,
    []
  );
}

/**
 * Deriva la clave de sesión AES-256-GCM no exportable mediante ECDH P-256 + HKDF SHA-256.
 * La clave se vincula criptográficamente al linkId y a ambos identificadores técnicos (CORE y MÓVIL).
 */
export async function deriveSharedE2EESessionKey(params: {
  localPrivateEcdhKey: CryptoKey;
  peerPublicKeySpkiBase64: string;
  linkId: string;
  coreDeviceId: string;
  terminalDeviceId: string;
}): Promise<CryptoKey> {
  const subtle = getSubtle();
  const peerPublicKey = await importPeerEcdhPublicKey(params.peerPublicKeySpkiBase64);

  const sharedBits = await subtle.deriveBits(
    {
      name: 'ECDH',
      public: peerPublicKey
    },
    params.localPrivateEcdhKey,
    256
  );

  const hkdfKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

  const encoder = new TextEncoder();
  const saltDigest = await subtle.digest('SHA-256', encoder.encode(`VEL-SALT-v1|${params.linkId}`));
  const infoBytes = encoder.encode(
    `VEL-E2EE-AESGCM-v1|${params.coreDeviceId}|${params.terminalDeviceId}|${params.linkId}`
  );

  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltDigest,
      info: infoBytes
    },
    hkdfKey,
    {
      name: 'AES-GCM',
      length: 256
    },
    false, // Clave de sesión no exportable
    ['encrypt', 'decrypt']
  );
}

/**
 * Calcula un código SAS verificable cara a cara (6 dígitos "XXX XXX") vinculado
 * criptográficamente a las claves públicas reales de ambos teléfonos y al código efímero.
 */
export async function computePairingSasCode(params: {
  pairingCode: string;
  coreDeviceId: string;
  terminalDeviceId: string;
  corePublicKeySpkiBase64: string;
  terminalPublicKeySpkiBase64: string;
}): Promise<string> {
  const subtle = getSubtle();
  const canonical = [
    'VEL-SAS-v1',
    params.pairingCode.trim().toUpperCase(),
    params.coreDeviceId.trim(),
    params.terminalDeviceId.trim(),
    params.corePublicKeySpkiBase64.trim(),
    params.terminalPublicKeySpkiBase64.trim()
  ].join('|');

  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const view = new DataView(digest);
  const numeric = view.getUint32(0, false) % 1000000;
  const padded = String(numeric).padStart(6, '0');
  return `${padded.slice(0, 3)} ${padded.slice(3)}`;
}

export interface E2EEEnvelopeMetadata {
  sessionId: string;
  senderId: string;
  recipientId: string;
  operationId: string;
  timestamp: number;
}

function buildEnvelopeAad(meta: E2EEEnvelopeMetadata): Uint8Array {
  const aadText = `VEL-AAD-v1|${meta.sessionId}|${meta.senderId}|${meta.recipientId}|${meta.operationId}|${meta.timestamp}`;
  return new TextEncoder().encode(aadText);
}

/**
 * Cifra un mensaje E2EE con AES-256-GCM usando un nonce/IV único de 96 bits (12 bytes)
 * y asociando los metadatos exactos de origen, destino, sesión, operación y timestamp en AAD.
 */
export async function encryptE2EEPayload(
  sessionKey: CryptoKey,
  plaintext: string,
  meta: E2EEEnvelopeMetadata
): Promise<{ ivBase64: string; ciphertextBase64: string }> {
  const subtle = getSubtle();
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);

  const aad = buildEnvelopeAad(meta);
  const encoded = new TextEncoder().encode(plaintext);

  const encrypted = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aad.buffer.slice(aad.byteOffset, aad.byteOffset + aad.byteLength) as ArrayBuffer,
      tagLength: 128
    },
    sessionKey,
    encoded
  );

  return {
    ivBase64: arrayBufferToBase64(iv.buffer),
    ciphertextBase64: arrayBufferToBase64(encrypted)
  };
}

/**
 * Descifra y verifica autenticidad e integridad (AEAD + AAD) de un sobre E2EE.
 * Falla si el texto cifrado fue manipulado o si alguien alteró senderId/recipientId/sessionId/operationId.
 */
export async function decryptE2EEPayload(
  sessionKey: CryptoKey,
  ivBase64: string,
  ciphertextBase64: string,
  meta: E2EEEnvelopeMetadata
): Promise<string> {
  const subtle = getSubtle();
  const iv = base64ToUint8Array(ivBase64);
  if (iv.length !== 12) {
    throw new Error('IV inválido en sobre cifrado AES-GCM (se requieren 12 bytes).');
  }

  const ciphertext = base64ToUint8Array(ciphertextBase64);
  const aad = buildEnvelopeAad(meta);

  const decrypted = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer,
      additionalData: aad.buffer.slice(aad.byteOffset, aad.byteOffset + aad.byteLength) as ArrayBuffer,
      tagLength: 128
    },
    sessionKey,
    ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer
  );

  return new TextDecoder().decode(decrypted);
}

export interface E2EEBinaryAadMetadata extends E2EEEnvelopeMetadata {
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
  purpose?: 'FILE_CHUNK' | 'FILE_MANIFEST' | 'FILE_CONTROL';
}

export interface EncryptedBinaryPayload {
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
  ivBase64: string;
  ciphertextBase64: string;
}

function normalizeBinaryBuffer(input: Uint8Array | ArrayBuffer | string, label: string): Uint8Array {
  if (typeof input === 'string') {
    return base64ToUint8Array(input);
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  throw new Error(`Formato binario inválido para ${label}.`);
}

function toSubArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function buildBinaryEnvelopeAad(meta: E2EEBinaryAadMetadata): Uint8Array {
  if (!meta.sessionId?.trim() || !meta.senderId?.trim() || !meta.recipientId?.trim() || !meta.operationId?.trim()) {
    throw new Error('Metadatos E2EE incompletos para construir AAD binario.');
  }
  if (!meta.fileId?.trim()) {
    throw new Error('fileId es obligatorio en AAD binario.');
  }
  if (!Number.isInteger(meta.totalChunks) || meta.totalChunks < 1) {
    throw new Error(`totalChunks inválido en AAD binario: ${meta.totalChunks}`);
  }
  if (!Number.isInteger(meta.chunkIndex) || meta.chunkIndex < 0 || meta.chunkIndex >= meta.totalChunks) {
    throw new Error(`chunkIndex inválido en AAD binario: ${meta.chunkIndex}/${meta.totalChunks}`);
  }
  const purpose = meta.purpose || 'FILE_CHUNK';
  const aadText = `VEL-BIN-AAD-v1|${purpose}|${meta.sessionId}|${meta.senderId}|${meta.recipientId}|${meta.operationId}|${meta.timestamp}|${meta.fileId}|${meta.chunkIndex}|${meta.totalChunks}`;
  return new TextEncoder().encode(aadText);
}

/**
 * Cifra un bloque binario E2EE con AES-256-GCM usando la clave de sesión existente,
 * IV aleatorio de 96 bits (12 bytes) y AAD vinculado al bloque concreto.
 */
export async function encryptE2EEBytes(
  sessionKey: CryptoKey,
  plaintextBytes: Uint8Array | ArrayBuffer,
  meta: E2EEBinaryAadMetadata
): Promise<EncryptedBinaryPayload> {
  const subtle = getSubtle();
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);

  const plainView = plaintextBytes instanceof Uint8Array ? plaintextBytes : new Uint8Array(plaintextBytes);
  const aad = buildBinaryEnvelopeAad(meta);

  const encrypted = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: toSubArrayBuffer(aad),
      tagLength: 128
    },
    sessionKey,
    toSubArrayBuffer(plainView)
  );

  return {
    iv,
    ciphertext: encrypted,
    ivBase64: arrayBufferToBase64(toSubArrayBuffer(iv)),
    ciphertextBase64: arrayBufferToBase64(encrypted)
  };
}

/**
 * Descifra y verifica integridad/autenticidad AEAD+AAD de un bloque binario E2EE.
 * Falla si cambia cualquier byte del ciphertext, IV o cualquiera de los identificadores del bloque en AAD.
 */
export async function decryptE2EEBytes(
  sessionKey: CryptoKey,
  ivInput: Uint8Array | ArrayBuffer | string,
  ciphertextInput: Uint8Array | ArrayBuffer | string,
  meta: E2EEBinaryAadMetadata
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const iv = normalizeBinaryBuffer(ivInput, 'IV');
  if (iv.length !== 12) {
    throw new Error('IV inválido en bloque binario cifrado AES-GCM (se requieren 12 bytes).');
  }

  const ciphertext = normalizeBinaryBuffer(ciphertextInput, 'ciphertext');
  const aad = buildBinaryEnvelopeAad(meta);

  const decrypted = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toSubArrayBuffer(iv),
      additionalData: toSubArrayBuffer(aad),
      tagLength: 128
    },
    sessionKey,
    toSubArrayBuffer(ciphertext)
  );

  return new Uint8Array(decrypted);
}

/**
 * Firma el desafío emitido por el Relay WebSocket para demostrar posesión física
 * de la clave privada ECDSA P-256 registrada en Firestore.
 */
export async function signRelayAuthChallenge(
  privateSigningKey: CryptoKey,
  challenge: string,
  deviceId: string,
  timestamp: number
): Promise<string> {
  const canonical = `VEL-RELAY-AUTH-v1|${challenge}|${deviceId}|${timestamp}`;
  return signTechnicalChallenge(privateSigningKey, canonical);
}
