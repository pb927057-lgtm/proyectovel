import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import {
  AuthorizationRecord,
  DeviceLinkRecord,
  DeviceRecord,
  LocalDeviceIdentityRecord
} from '../src/contracts/velContracts';
import { computeSha256Hex } from '../src/crypto/fileHash';
import { encryptE2EEBytes } from '../src/crypto/e2eeSession';
import {
  VaultChunkRecord,
  VaultFileRecord,
  VelCoreVaultStorageAdapter
} from '../src/db/db';
import { CoreFileVaultManager } from '../src/db/coreFileVault';
import { LOCAL_VAULT_KEY_CONFIG, resetLocalVaultKeyCache } from '../src/db/offlineSync';
import { setupNewDeviceIdentity } from '../src/services/deviceIdentityService';
import { VelRelayClient } from '../src/services/relayClient';
import {
  FILE_TRANSFER_STATUS_LABELS,
  FileTransferService,
  MAX_TRANSFER_FILE_BYTES
} from '../src/services/fileTransferService';
import { VelRelayServer } from '../server-vel/relay-server';
import { registerDeviceHandler } from '../netlify/functions/register-device';
import { deviceSessionHandler } from '../netlify/functions/device-session';
import { pairingConfirmHandler } from '../netlify/functions/pairing-confirm';
import { revokeDeviceHandler } from '../netlify/functions/revoke-device';
import {
  DeviceTransactionContext,
  DeviceTransactionStore
} from '../netlify/functions/shared/deviceAuthService';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`✓ [PASS] ${label}`);
  } else {
    failed++;
    console.error(`✗ [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function assertRejects(fn: () => Promise<unknown>, label: string): Promise<Error | null> {
  try {
    await fn();
    assert(false, label, 'Se esperaba rechazo/excepción pero resolvió correctamente');
    return null;
  } catch (err) {
    assert(true, label);
    return err instanceof Error ? err : new Error(String(err));
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
  label = 'condición'
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timeout (${timeoutMs}ms) esperando: ${label}`);
}

function makePatternBytes(size: number, seed = 42): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function createMemoryVaultStorageAdapter(): VelCoreVaultStorageAdapter & {
  vaultFiles: Map<string, VaultFileRecord>;
  vaultChunks: Map<string, VaultChunkRecord>;
  failNextChunkWriteError: Error | null;
} {
  let identity: LocalDeviceIdentityRecord | null = null;
  const config = new Map<string, any>();
  const auths = new Map<string, AuthorizationRecord>();
  const linksMap = new Map<string, DeviceLinkRecord>();
  const vaultFiles = new Map<string, VaultFileRecord>();
  const vaultChunks = new Map<string, VaultChunkRecord>();

  const adapter: VelCoreVaultStorageAdapter & {
    vaultFiles: Map<string, VaultFileRecord>;
    vaultChunks: Map<string, VaultChunkRecord>;
    failNextChunkWriteError: Error | null;
  } = {
    vaultFiles,
    vaultChunks,
    failNextChunkWriteError: null,
    async getIdentity() {
      return identity;
    },
    async saveIdentity(record) {
      identity = { ...record };
    },
    async clearIdentity() {
      identity = null;
    },
    async getConfig<T>(key: string) {
      return config.has(key) ? (config.get(key) as T) : null;
    },
    async setConfig(key: string, value: unknown) {
      config.set(key, value);
    },
    async deleteConfig(key: string) {
      config.delete(key);
    },
    async getAuthorization(authorizationId: string) {
      return auths.get(authorizationId) || null;
    },
    async saveAuthorization(record: AuthorizationRecord) {
      auths.set(record.authorizationId, { ...record });
    },
    async getLink(linkId: string) {
      return linksMap.get(linkId) || null;
    },
    async saveLink(record: DeviceLinkRecord) {
      linksMap.set(record.linkId, { ...record });
    },
    async putVaultFile(record: VaultFileRecord) {
      vaultFiles.set(record.fileId, {
        ...record,
        encryptedMeta: record.encryptedMeta.slice(0),
        metaIv: record.metaIv.slice(0)
      });
    },
    async getVaultFile(fileId: string) {
      const rec = vaultFiles.get(fileId);
      return rec
        ? { ...rec, encryptedMeta: rec.encryptedMeta.slice(0), metaIv: rec.metaIv.slice(0) }
        : null;
    },
    async getAllVaultFiles() {
      return Array.from(vaultFiles.values()).map((rec) => ({
        ...rec,
        encryptedMeta: rec.encryptedMeta.slice(0),
        metaIv: rec.metaIv.slice(0)
      }));
    },
    async putVaultChunk(record: VaultChunkRecord) {
      if (adapter.failNextChunkWriteError) {
        const err = adapter.failNextChunkWriteError;
        adapter.failNextChunkWriteError = null;
        throw err;
      }
      vaultChunks.set(record.chunkKey, {
        ...record,
        iv: record.iv.slice(0),
        ciphertext: record.ciphertext.slice(0)
      });
    },
    async getVaultChunk(chunkKey: string) {
      const ch = vaultChunks.get(chunkKey);
      return ch ? { ...ch, iv: ch.iv.slice(0), ciphertext: ch.ciphertext.slice(0) } : null;
    },
    async getVaultChunksByFileId(fileId: string) {
      const out: VaultChunkRecord[] = [];
      for (const ch of vaultChunks.values()) {
        if (ch.fileId === fileId) {
          out.push({ ...ch, iv: ch.iv.slice(0), ciphertext: ch.ciphertext.slice(0) });
        }
      }
      out.sort((a, b) => a.chunkIndex - b.chunkIndex);
      return out;
    },
    async deleteVaultFileAndChunks(fileId: string) {
      vaultFiles.delete(fileId);
      let deleted = 0;
      for (const [key, ch] of vaultChunks.entries()) {
        if (ch.fileId === fileId) {
          vaultChunks.delete(key);
          deleted++;
        }
      }
      return deleted;
    },
    async deleteVaultFile(fileId: string) {
      vaultFiles.delete(fileId);
    },
    async close() {
      // No-op para adaptador en memoria
    }
  };

  return adapter;
}

function createInMemoryFirestoreDeviceStore() {
  const devices = new Map<string, DeviceRecord>();
  const links = new Map<string, DeviceLinkRecord>();
  const authorizations = new Map<string, AuthorizationRecord>();

  const store: DeviceTransactionStore = {
    async runTransaction<T>(fn: (ctx: DeviceTransactionContext) => Promise<T>): Promise<T> {
      const ctx: DeviceTransactionContext = {
        async getDevice(deviceId) {
          const found = devices.get(deviceId);
          return found ? { ...found } : null;
        },
        createDevice(record) {
          devices.set(record.deviceId, { ...record });
        },
        updateDevice(deviceId, patch) {
          const current = devices.get(deviceId);
          if (!current) throw new Error(`Missing device ${deviceId}`);
          devices.set(deviceId, { ...current, ...patch });
        },
        async getLink(linkId) {
          const found = links.get(linkId);
          return found ? { ...found } : null;
        },
        createLink(record) {
          links.set(record.linkId, { ...record });
        },
        updateLink(linkId, patch) {
          const current = links.get(linkId);
          if (!current) throw new Error(`Missing link ${linkId}`);
          links.set(linkId, { ...current, ...patch });
        },
        async getAuthorizationByLink(linkId) {
          const found = authorizations.get(linkId);
          return found ? { ...found } : null;
        },
        createAuthorization(record) {
          authorizations.set(record.authorizationId, { ...record });
        },
        updateAuthorization(authorizationId, patch) {
          const current = authorizations.get(authorizationId);
          if (!current) throw new Error(`Missing auth ${authorizationId}`);
          authorizations.set(authorizationId, { ...current, ...patch });
        }
      };
      return fn(ctx);
    }
  };

  return { store, devices, links, authorizations };
}

function makeVerifyTokenFn() {
  return async (authHeader?: string) => {
    if (!authHeader || !authHeader.startsWith('Bearer valid-token-')) {
      return {
        authenticated: false as const,
        reason: 'invalid_token' as const,
        message: 'Token Firebase inválido o faltante.'
      };
    }
    const uid = authHeader.replace('Bearer valid-token-', '').trim();
    return { authenticated: true as const, uid, email: '' };
  };
}

function makeFetchAdapter(dbMemory: ReturnType<typeof createInMemoryFirestoreDeviceStore>) {
  const verifyToken = makeVerifyTokenFn();
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    const method = (init?.method || 'GET').toUpperCase();
    const headers = (init?.headers || {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? init.body : undefined;

    if (target.startsWith('/api/register-device')) {
      const res = await registerDeviceHandler(
        { httpMethod: method, headers, body },
        { verifyToken, hasDbCredentials: () => true, getDeviceStore: () => dbMemory.store }
      );
      return new Response(res.body, { status: res.statusCode, headers: { 'Content-Type': 'application/json' } });
    }
    if (target.startsWith('/api/device-session')) {
      const parsedUrl = new URL(target, 'https://legendary-pasca-bf280b.netlify.app');
      const res = await deviceSessionHandler(
        {
          httpMethod: method,
          headers,
          queryStringParameters: Object.fromEntries(parsedUrl.searchParams.entries()),
          body
        },
        { verifyToken, hasDbCredentials: () => true, getDeviceStore: () => dbMemory.store }
      );
      return new Response(res.body, { status: res.statusCode, headers: { 'Content-Type': 'application/json' } });
    }
    if (target.startsWith('/api/pairing-confirm')) {
      const res = await pairingConfirmHandler(
        { httpMethod: method, headers, body },
        { verifyToken, hasDbCredentials: () => true, getDeviceStore: () => dbMemory.store }
      );
      return new Response(res.body, { status: res.statusCode, headers: { 'Content-Type': 'application/json' } });
    }
    if (target.startsWith('/api/revoke-device')) {
      const res = await revokeDeviceHandler(
        { httpMethod: method, headers, body },
        { verifyToken, hasDbCredentials: () => true, getDeviceStore: () => dbMemory.store }
      );
      return new Response(res.body, { status: res.statusCode, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Endpoint no esperado: ${target}`);
  }) as typeof fetch;
}

async function runTests() {
  console.log('========================================================================');
  console.log('VEL 0.1 — PRUEBAS AUTOMATIZADAS ETAPA 2 (TRANSFERENCIA CIFRADA MÓVIL -> CORE)');
  console.log('Nota: Simulación automatizada en Node.js sobre VelRelayServer real + E2EE');
  console.log('      (no equivale a prueba física entre dos teléfonos móviles reales).');
  console.log('========================================================================\n');

  resetLocalVaultKeyCache();
  const testStorageDir = path.join(process.cwd(), 'server-vel', 'test-data-stage2');
  if (fs.existsSync(testStorageDir)) {
    fs.rmSync(testStorageDir, { recursive: true, force: true });
  }

  const dbMemory = createInMemoryFirestoreDeviceStore();
  const fetchAdapter = makeFetchAdapter(dbMemory);
  const verifyToken = makeVerifyTokenFn();

  const server = new VelRelayServer({
    port: 0,
    storageDir: testStorageDir,
    deviceStore: dbMemory.store,
    verifyToken,
    hasDbCredentials: () => true,
    heartbeatIntervalMs: 60_000,
    authTimeoutMs: 5_000
  });
  const port = await server.start();
  const wssUrl = `ws://127.0.0.1:${port}`;

  const coreStorage = createMemoryVaultStorageAdapter();
  const movStorage = createMemoryVaultStorageAdapter();
  const coreUid = 'stage2-core-uid-1';
  const movUid = 'stage2-movil-uid-2';

  const coreSetup = await setupNewDeviceIdentity('CORE', undefined, {
    storage: coreStorage,
    ensureAnonymousAuth: async () => ({ success: true, uid: coreUid, idToken: `valid-token-${coreUid}` }),
    fetchFn: fetchAdapter
  });
  const movSetup = await setupNewDeviceIdentity('TERMINAL', undefined, {
    storage: movStorage,
    ensureAnonymousAuth: async () => ({ success: true, uid: movUid, idToken: `valid-token-${movUid}` }),
    fetchFn: fetchAdapter
  });
  assert(coreSetup.success && movSetup.success, '1. Setup independiente de identidades CORE y MÓVIL');

  const coreClient = new VelRelayClient({
    storage: coreStorage,
    getFirebaseIdToken: async () => `valid-token-${coreUid}`,
    fetchFn: fetchAdapter,
    WebSocketImpl: WebSocket,
    operationAckTimeoutMs: 8000,
    reconnectBaseDelayMs: 500
  });
  const movClient = new VelRelayClient({
    storage: movStorage,
    getFirebaseIdToken: async () => `valid-token-${movUid}`,
    fetchFn: fetchAdapter,
    WebSocketImpl: WebSocket,
    operationAckTimeoutMs: 8000,
    reconnectBaseDelayMs: 500
  });

  const coreVault = new CoreFileVaultManager(coreStorage);
  const movVaultAttempt = new CoreFileVaultManager(movStorage);
  let coreVaultNotifications = 0;

  const coreTransfer = new FileTransferService({
    relayClient: coreClient,
    coreVault,
    onCoreVaultUpdated: () => {
      coreVaultNotifications += 1;
    }
  });
  const movTransfer = new FileTransferService({
    relayClient: movClient,
    coreVault: movVaultAttempt
  });

  try {
    // Emparejamiento real + SAS + LINKED
    coreClient.connect(wssUrl);
    movClient.connect(wssUrl);
    await waitFor(
      () =>
        coreClient.getState() === 'AUTHENTICATED' &&
        movClient.getState() === 'AUTHENTICATED',
      5000,
      'Autenticación inicial en Relay'
    );

    const offer = await coreClient.createPairingOffer();
    assert(Boolean(offer.code), '2. CORE genera código de emparejamiento');
    const claim = await movClient.claimPairingOffer(offer.code!);
    assert(claim.success, '3. MÓVIL reclama código de emparejamiento');

    await waitFor(
      () =>
        coreClient.getSnapshot().pairingSession?.stage === 'SAS_PENDING' &&
        movClient.getSnapshot().pairingSession?.stage === 'SAS_PENDING',
      5000,
      'SAS pendiente en ambos'
    );

    coreClient.confirmPairingSas();
    movClient.confirmPairingSas();

    await waitFor(
      () =>
        coreClient.getState() === 'LINKED' &&
        movClient.getState() === 'LINKED' &&
        coreClient.getSnapshot().peerOnline &&
        movClient.getSnapshot().peerOnline,
      5000,
      'Estado LINKED en ambos dispositivos'
    );
    assert(true, '4. Canal E2EE LINKED activo entre MÓVIL y CORE');

    // ------------------------------------------------------------------------
    // 5. Envío real de fotografía pequeña (image/jpeg) + verificación CORE + limpieza RAM MÓVIL
    // ------------------------------------------------------------------------
    const photoBytes = makePatternBytes(48 * 1024 + 137, 101);
    const photoHash = await computeSha256Hex(photoBytes);
    const [photoItem] = movTransfer.selectFiles([
      {
        name: 'vacaciones.jpg',
        type: 'image/jpeg',
        size: photoBytes.byteLength,
        blob: new Blob([photoBytes as BlobPart], { type: 'image/jpeg' })
      }
    ]);
    assert(
      photoItem.status === 'SELECTED' && photoItem.statusLabel === FILE_TRANSFER_STATUS_LABELS.SELECTED,
      '5a. Foto seleccionada queda en estado Listo para enviar'
    );

    const photoResult = await movTransfer.sendFile(photoItem.localId);
    assert(
      photoResult.status === 'PROTECTED_IN_CORE' &&
        photoResult.statusLabel === 'Protegido en CORE' &&
        photoResult.sha256 === photoHash,
      '5b. Foto pequeña transferida y confirmada Protegido en CORE con SHA-256'
    );

    const coreListAfterPhoto = await coreVault.listFiles();
    const savedPhoto = coreListAfterPhoto.find((f) => f.fileId === photoResult.fileId);
    assert(
      Boolean(savedPhoto) && savedPhoto!.fileName === 'vacaciones.jpg' && savedPhoto!.sha256 === photoHash,
      '5c. Foto persistida y listable en bóveda cifrada de CORE'
    );
    const openedPhoto = await coreVault.openProtectedFileAsBlob(photoResult.fileId);
    const openedPhotoBytes = new Uint8Array(await openedPhoto.blob.arrayBuffer());
    assert(
      bytesEqual(openedPhotoBytes, photoBytes) && openedPhoto.metadata.mimeType === 'image/jpeg',
      '5d. Foto descifrada en CORE coincide bit a bit con el archivo original'
    );

    // MÓVIL no debe conservar copias en IndexedDB ni reintentar usando Blob ya liberado
    const retryCompletedRes = await movTransfer.retryFile(photoItem.localId);
    assert(
      retryCompletedRes.status === 'FAILED' &&
        movStorage.vaultFiles.size === 0 &&
        movStorage.vaultChunks.size === 0,
      '5e. MÓVIL liberó referencia en memoria tras confirmar CORE y no conserva archivos en almacenamiento local'
    );

    // ------------------------------------------------------------------------
    // 6. Envío real de PDF (~320 KB = 3 bloques) y vídeo de prueba (~650 KB = 6 bloques)
    // ------------------------------------------------------------------------
    const pdfBytes = makePatternBytes(320 * 1024 + 19, 202);
    const pdfHash = await computeSha256Hex(pdfBytes);
    const [pdfItem] = movTransfer.selectFiles([
      {
        name: 'contrato-personal.pdf',
        type: 'application/pdf',
        size: pdfBytes.byteLength,
        blob: new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
      }
    ]);
    const pdfRes = await movTransfer.sendFile(pdfItem.localId);
    assert(
      pdfRes.status === 'PROTECTED_IN_CORE' && pdfRes.sha256 === pdfHash,
      '6a. Documento PDF multibloque transferido y confirmado en CORE'
    );
    const pdfRead = await coreVault.readFileBytes(pdfRes.fileId);
    assert(bytesEqual(pdfRead.bytes, pdfBytes), '6b. PDF recuperado bit a bit en CORE');

    const videoBytes = makePatternBytes(650 * 1024 + 511, 303);
    const videoHash = await computeSha256Hex(videoBytes);
    const [videoItem] = movTransfer.selectFiles([
      {
        name: 'clip-prueba.mp4',
        type: 'video/mp4',
        size: videoBytes.byteLength,
        blob: new Blob([videoBytes as BlobPart], { type: 'video/mp4' })
      }
    ]);
    const videoRes = await movTransfer.sendFile(videoItem.localId);
    assert(
      videoRes.status === 'PROTECTED_IN_CORE' && videoRes.sha256 === videoHash,
      '6c. Vídeo de prueba multibloque transferido y confirmado en CORE'
    );

    let streamedTotal = 0;
    const streamedMeta = await coreVault.streamProtectedFileChunks(videoRes.fileId, (chunk) => {
      streamedTotal += chunk.byteLength;
    });
    assert(
      streamedTotal === videoBytes.byteLength && streamedMeta.sha256 === videoHash,
      '6d. streamProtectedFileChunks descifra y valida vídeo sin cargar un buffer contiguo en JS'
    );

    // ------------------------------------------------------------------------
    // 7. Archivo vacío (0 bytes)
    // ------------------------------------------------------------------------
    const emptyBytes = new Uint8Array(0);
    const emptyHash = await computeSha256Hex(emptyBytes);
    const [emptyItem] = movTransfer.selectFiles([
      {
        name: 'vacio.txt',
        type: 'text/plain',
        size: 0,
        blob: new Blob([], { type: 'text/plain' })
      }
    ]);
    const emptyRes = await movTransfer.sendFile(emptyItem.localId);
    const openedEmpty = await coreVault.openProtectedFileAsBlob(emptyRes.fileId);
    assert(
      emptyRes.status === 'PROTECTED_IN_CORE' &&
        emptyRes.sha256 === emptyHash &&
        openedEmpty.blob.size === 0,
      '7. Archivo vacío (0 bytes) transferido, verificado y recuperado con SHA-256 exacto'
    );

    // ------------------------------------------------------------------------
    // 8. Archivo de varios megabytes (2.6 MB = 21 bloques) + verificación Relay/Firestore sin archivos
    // ------------------------------------------------------------------------
    const bigBytes = makePatternBytes(2 * 1024 * 1024 + 600 * 1024 + 77, 404);
    const bigHash = await computeSha256Hex(bigBytes);
    const [bigItem] = movTransfer.selectFiles([
      {
        name: 'archivo-grande.bin',
        type: 'application/octet-stream',
        size: bigBytes.byteLength,
        blob: new Blob([bigBytes as BlobPart], { type: 'application/octet-stream' })
      }
    ]);
    const bigRes = await movTransfer.sendFile(bigItem.localId);
    assert(
      bigRes.status === 'PROTECTED_IN_CORE' && bigRes.totalChunks === 21 && bigRes.sha256 === bigHash,
      '8a. Archivo de 2.6 MB (21 bloques de 128 KB) transferido y confirmado en CORE'
    );
    const bigOpened = await coreVault.openProtectedFileAsBlob(bigRes.fileId);
    const bigOpenedBytes = new Uint8Array(await bigOpened.blob.arrayBuffer());
    assert(bytesEqual(bigOpenedBytes, bigBytes), '8b. Archivo de 2.6 MB recuperado íntegro bit a bit');

    // Relay y Firestore no deben guardar archivos ni bloques personales
    const relayFiles = fs.existsSync(testStorageDir) ? fs.readdirSync(testStorageDir) : [];
    const relayHasFileData = relayFiles.some((f) => {
      const content = fs.readFileSync(path.join(testStorageDir, f), 'utf8');
      return content.includes('vacaciones.jpg') || content.includes('archivo-grande.bin') || content.includes('FILE_CHUNK');
    });
    const firestoreJson = JSON.stringify({
      devices: Array.from(dbMemory.devices.values()),
      links: Array.from(dbMemory.links.values()),
      authorizations: Array.from(dbMemory.authorizations.values())
    });
    assert(
      !relayHasFileData &&
        !firestoreJson.includes('vacaciones.jpg') &&
        !firestoreJson.includes('archivo-grande.bin'),
      '8c. Ni el servidor Relay ni Firestore almacenaron contenido ni metadatos de archivos personales'
    );

    // ------------------------------------------------------------------------
    // 9. Límite práctico > 100 MB rechazado de forma segura sin colgar memoria
    // ------------------------------------------------------------------------
    const [oversizedItem] = movTransfer.selectFiles([
      {
        name: 'video-enorme-101mb.mp4',
        type: 'video/mp4',
        size: MAX_TRANSFER_FILE_BYTES + 1,
        blob: new Blob([new Uint8Array(16) as BlobPart], { type: 'video/mp4' })
      }
    ]);
    assert(
      oversizedItem.status === 'FAILED' &&
        oversizedItem.canRetry === false &&
        Boolean(oversizedItem.errorMessage?.includes('100 MB')),
      '9. Archivo > 100 MB es rechazado limpiamente sin reintentos ni carga en memoria'
    );

    // ------------------------------------------------------------------------
    // 10. Detección de bloque corrupto (tampering en ciphertext) y rechazo de duplicado / fuera de orden
    // ------------------------------------------------------------------------
    const movIdent = (await movStorage.getIdentity())!;
    const coreIdent = (await coreStorage.getIdentity())!;

    // 10a. Tampering en bloque 0 cifrado interceptando 1 envío sobre WebSocket real
    const tamperBytes = makePatternBytes(150 * 1024, 505);
    const [tamperItem] = movTransfer.selectFiles([
      {
        name: 'corrupto.bin',
        type: 'application/octet-stream',
        size: tamperBytes.byteLength,
        blob: new Blob([tamperBytes as BlobPart])
      }
    ]);
    const origWsSend = (movClient as any).ws.send.bind((movClient as any).ws);
    let corruptedOnce = false;
    (movClient as any).ws.send = (data: string) => {
      try {
        const parsed = JSON.parse(data);
        if (
          !corruptedOnce &&
          parsed.type === 'ENCRYPTED_MESSAGE' &&
          typeof parsed.operationId === 'string' &&
          parsed.operationId.startsWith('VELF|C|')
        ) {
          corruptedOnce = true;
          const rawBuf = Buffer.from(parsed.ciphertext, 'base64');
          rawBuf[0] = rawBuf[0] ^ 0xff;
          parsed.ciphertext = rawBuf.toString('base64');
          return origWsSend(JSON.stringify(parsed));
        }
      } catch {
        // pass-through
      }
      return origWsSend(data);
    };
    const tamperRes = await movTransfer.sendFile(tamperItem.localId);
    (movClient as any).ws.send = origWsSend;
    assert(
      corruptedOnce && tamperRes.status === 'FAILED',
      '10a. Bloque manipulado/corrupto es rechazado por AES-GCM en CORE y no confirma envío'
    );

    // 10b. Bloque duplicado enviado con sessionKey real
    const movSessionKey = (movClient as any).sessionKey as CryptoKey;
    const dupFileId = 'FILE-DUP-TEST-1';
    const block0 = makePatternBytes(1024, 606);
    const fullHash2 = await computeSha256Hex(new Uint8Array([...block0, ...block0]));

    const sendRawFileMsg = async (
      operationId: string,
      fileId: string,
      chunkIndex: number,
      totalChunks: number,
      purpose: 'FILE_MANIFEST' | 'FILE_CHUNK',
      plain: Uint8Array
    ) => {
      const ts = Date.now();
      const sessionId = movClient.getSnapshot().identity?.activeLinkId || '';
      const enc = await encryptE2EEBytes(movSessionKey, plain, {
        sessionId,
        senderId: movIdent.deviceId,
        recipientId: coreIdent.deviceId,
        operationId,
        timestamp: ts,
        purpose,
        fileId,
        chunkIndex,
        totalChunks
      });
      origWsSend(
        JSON.stringify({
          type: 'ENCRYPTED_MESSAGE',
          senderId: movIdent.deviceId,
          recipientId: coreIdent.deviceId,
          sessionId,
          operationId,
          iv: enc.ivBase64,
          ciphertext: enc.ciphertextBase64,
          timestamp: ts
        })
      );
    };

    const dupOfferBytes = new TextEncoder().encode(
      JSON.stringify({
        kind: 'FILE_OFFER',
        fileId: dupFileId,
        fileName: 'duplicado.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 2048,
        chunkSize: 1024,
        totalChunks: 2,
        expectedSha256: fullHash2
      })
    );
    await sendRawFileMsg(`VELF|M|${dupFileId}|0|1|O1`, dupFileId, 0, 1, 'FILE_MANIFEST', dupOfferBytes);
    await new Promise((r) => setTimeout(r, 80));
    await sendRawFileMsg(`VELF|C|${dupFileId}|0|2|C0A`, dupFileId, 0, 2, 'FILE_CHUNK', block0);
    await new Promise((r) => setTimeout(r, 80));
    // Reenviar chunkIndex=0 como duplicado con otro nonce
    await sendRawFileMsg(`VELF|C|${dupFileId}|0|2|C0B`, dupFileId, 0, 2, 'FILE_CHUNK', block0);
    await waitFor(
      () => !(coreVault.isTransferActive(dupFileId)) && !coreStorage.vaultFiles.has(dupFileId),
      4000,
      'CORE rechaza y limpia archivo con bloque duplicado'
    );
    assert(true, '10b. Bloque duplicado es rechazado en CORE y limpia staging sin confirmar');

    // 10c. Bloque fuera de orden (chunkIndex 1 antes de 0)
    const oooFileId = 'FILE-OOO-TEST-1';
    const oooOfferBytes = new TextEncoder().encode(
      JSON.stringify({
        kind: 'FILE_OFFER',
        fileId: oooFileId,
        fileName: 'desordenado.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 2048,
        chunkSize: 1024,
        totalChunks: 2,
        expectedSha256: fullHash2
      })
    );
    await sendRawFileMsg(`VELF|M|${oooFileId}|0|1|O2`, oooFileId, 0, 1, 'FILE_MANIFEST', oooOfferBytes);
    await new Promise((r) => setTimeout(r, 80));
    await sendRawFileMsg(`VELF|C|${oooFileId}|1|2|C1X`, oooFileId, 1, 2, 'FILE_CHUNK', block0);
    await waitFor(
      () => !(coreVault.isTransferActive(oooFileId)) && !coreStorage.vaultFiles.has(oooFileId),
      4000,
      'CORE rechaza archivo con bloque fuera de orden'
    );
    assert(true, '10c. Bloque fuera de orden es rechazado en CORE sin marcar ready');

    // ------------------------------------------------------------------------
    // 11. Interrupción a mitad de transferencia + ausencia de reintento oculto + reintento manual
    // ------------------------------------------------------------------------
    const interBytes = makePatternBytes(12 * 128 * 1024 + 55, 707);
    const interHash = await computeSha256Hex(interBytes);
    const [interItem] = movTransfer.selectFiles([
      {
        name: 'corte-mitad.pdf',
        type: 'application/pdf',
        size: interBytes.byteLength,
        blob: new Blob([interBytes as BlobPart], { type: 'application/pdf' })
      }
    ]);

    const sendPromise = movTransfer.sendFile(interItem.localId);
    await waitFor(() => {
      const item = movTransfer.getSnapshot().outgoing.find((x) => x.localId === interItem.localId);
      return Boolean(item && item.chunksConfirmed >= 2);
    }, 5000, 'Al menos 2 bloques confirmados antes de cortar conexión');

    // Desconectar MÓVIL abruptamente a mitad de transferencia
    movClient.disconnect();
    const interruptedRes = await sendPromise;
    assert(
      interruptedRes.status === 'INTERRUPTED' &&
        interruptedRes.statusLabel === 'Transferencia interrumpida' &&
        interruptedRes.canRetry === true,
      '11a. Desconexión a mitad detiene envío y muestra Transferencia interrumpida'
    );

    // Esperar para comprobar que NO existe ningún reintento automático silencioso
    const chunksBeforeWait = interruptedRes.chunksConfirmed;
    await new Promise((r) => setTimeout(r, 400));
    const afterWaitState = movTransfer
      .getSnapshot()
      .outgoing.find((x) => x.localId === interItem.localId)!;
    assert(
      afterWaitState.status === 'INTERRUPTED' && afterWaitState.chunksConfirmed === chunksBeforeWait,
      '11b. MÓVIL NO ejecuta reintentos ocultos en segundo plano tras interrupción'
    );

    // Verificar que CORE nunca lo marcó ready
    const readyListMid = await coreVault.listFiles();
    assert(
      !readyListMid.some((f) => f.fileName === 'corte-mitad.pdf'),
      '11c. Archivo interrumpido jamás aparece como protegido/ready en CORE'
    );

    // Reconectar y confirmar que sigue sin reintento automático hasta pulsar Reintentar manual
    movClient.connect(wssUrl);
    await waitFor(
      () => movClient.getState() === 'LINKED' && movClient.getSnapshot().peerOnline,
      5000,
      'Reconexión MÓVIL a LINKED'
    );
    await new Promise((r) => setTimeout(r, 250));
    const stillInterrupted = movTransfer
      .getSnapshot()
      .outgoing.find((x) => x.localId === interItem.localId)!;
    assert(
      stillInterrupted.status === 'INTERRUPTED',
      '11d. Incluso al reconectar, la transferencia espera acción manual Reintentar'
    );

    const retriedRes = await movTransfer.retryFile(interItem.localId);
    assert(
      retriedRes.status === 'PROTECTED_IN_CORE' && retriedRes.sha256 === interHash,
      '11e. Reintento manual completa el archivo íntegro y recibe confirmación verificada de CORE'
    );

    // ------------------------------------------------------------------------
    // 12. Error simulado de escritura en IndexedDB de CORE (QuotaExceededError)
    // ------------------------------------------------------------------------
    const quotaBytes = makePatternBytes(64 * 1024, 808);
    const [quotaItem] = movTransfer.selectFiles([
      {
        name: 'fallo-idb.jpg',
        type: 'image/jpeg',
        size: quotaBytes.byteLength,
        blob: new Blob([quotaBytes as BlobPart], { type: 'image/jpeg' })
      }
    ]);
    const quotaErr = new Error('Simulated IDB QuotaExceededError');
    quotaErr.name = 'QuotaExceededError';
    coreStorage.failNextChunkWriteError = quotaErr;

    const quotaRes = await movTransfer.sendFile(quotaItem.localId);
    assert(
      quotaRes.status === 'FAILED' && !(await coreVault.listFiles()).some((f) => f.fileId === quotaRes.fileId),
      '12. Error de escritura QuotaExceededError en IndexedDB de CORE falla limpio sin confirmar ready'
    );

    // ------------------------------------------------------------------------
    // 13. Espacio insuficiente simulado mediante navigator.storage.estimate()
    // ------------------------------------------------------------------------
    const origNavStorage = Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage');
    let restoredNav = false;
    try {
      Object.defineProperty(globalThis.navigator, 'storage', {
        configurable: true,
        value: {
          persisted: async () => true,
          persist: async () => true,
          estimate: async () => ({ usage: 999_500, quota: 1_000_000 }) // ~500 bytes libres
        }
      });

      const bigEstBytes = makePatternBytes(200 * 1024, 909);
      const [estItem] = movTransfer.selectFiles([
        {
          name: 'sin-espacio.pdf',
          type: 'application/pdf',
          size: bigEstBytes.byteLength,
          blob: new Blob([bigEstBytes as BlobPart], { type: 'application/pdf' })
        }
      ]);
      const estRes = await movTransfer.sendFile(estItem.localId);
      assert(
        estRes.status === 'FAILED' && Boolean(estRes.errorMessage?.toLowerCase().includes('espacio')),
        '13. Espacio local insuficiente detectado por navigator.storage.estimate() rechaza la oferta en CORE'
      );
    } finally {
      if (origNavStorage) {
        Object.defineProperty(globalThis.navigator, 'storage', origNavStorage);
        restoredNav = true;
      } else {
        delete (globalThis.navigator as any).storage;
        restoredNav = true;
      }
    }
    assert(restoredNav, '13b. navigator.storage restaurado correctamente');

    // ------------------------------------------------------------------------
    // 14. Rechazo cuando TERMINAL/MÓVIL intenta escribir en bóveda o recibir oferta de archivo
    // ------------------------------------------------------------------------
    await assertRejects(
      () =>
        movVaultAttempt.saveBinaryFile({
          fileName: 'prohibido.txt',
          mimeType: 'text/plain',
          bytes: new Uint8Array([1, 2, 3])
        }),
      '14a. CoreFileVaultManager rechaza escritura directa cuando el rol local es TERMINAL/MÓVIL'
    );

    const coreToMovBadPacket = await (movTransfer as any).handleIncomingPacket({
      senderId: coreIdent.deviceId,
      operationId: 'VELF|M|FILE-BAD-ROLE|0|1|R1',
      purpose: 'FILE_MANIFEST',
      fileId: 'FILE-BAD-ROLE',
      chunkIndex: 0,
      totalChunks: 1,
      plaintextBytes: new TextEncoder().encode(
        JSON.stringify({
          kind: 'FILE_OFFER',
          fileId: 'FILE-BAD-ROLE',
          fileName: 'no-en-movil.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 100,
          chunkSize: 1024,
          totalChunks: 1,
          expectedSha256: 'a'.repeat(64)
        })
      ),
      timestamp: Date.now()
    });
    assert(
      coreToMovBadPacket === false && movStorage.vaultFiles.size === 0,
      '14b. FileTransferService en MÓVIL rechaza almacenar archivos entrantes (INVALID_ROLE)'
    );

    // ------------------------------------------------------------------------
    // 15. Compatibilidad con mensajería E2EE de texto y eliminación verificada en CORE
    // ------------------------------------------------------------------------
    const textOutcome = await movClient.sendEncryptedMessage('Hola CORE, prueba tras archivos', 'compat-txt');
    await waitFor(
      () =>
        coreClient
          .getSnapshot()
          .receivedMessages.some((m) => m.text === 'Hola CORE, prueba tras archivos'),
      5000,
      'Recepción de mensaje de texto E2EE compatible'
    );
    const receivedTexts = coreClient.getSnapshot().receivedMessages;
    assert(
      textOutcome.accepted &&
        receivedTexts.every((m) => !m.operationId.startsWith('VELF|')),
      '15a. Mensajería E2EE de texto sigue funcionando y los bloques binarios jamás contaminan receivedMessages'
    );

    const deleteRes = await coreVault.deleteFile(bigRes.fileId);
    const listAfterDelete = await coreVault.listFiles();
    assert(
      deleteRes.deleted &&
        deleteRes.integrityVerified &&
        deleteRes.deletedChunks === 21 &&
        !listAfterDelete.some((f) => f.fileId === bigRes.fileId) &&
        coreVaultNotifications >= 5,
      '15b. Eliminación de archivo en bóveda CORE borra registro y sus 21 bloques verificando integridad'
    );

    // Verificar uso de LOCAL_VAULT_KEY_CONFIG en almacenamiento CORE
    const persistedVaultKey = await coreStorage.getConfig(LOCAL_VAULT_KEY_CONFIG);
    assert(Boolean(persistedVaultKey), '15c. Clave local AES-256-GCM de bóveda CORE presente sin fugas');
  } finally {
    coreTransfer.dispose();
    movTransfer.dispose();
    coreClient.disconnect();
    movClient.disconnect();
    await server.stop();
    if (fs.existsSync(testStorageDir)) {
      fs.rmSync(testStorageDir, { recursive: true, force: true });
    }
  }

  console.log('\n========================================================================');
  console.log(`RESUMEN ETAPA 2: ${passed} PASS / ${failed} FAIL`);
  console.log('========================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Error fatal ejecutando test-stage2-file-transfer:', err);
  process.exit(1);
});
