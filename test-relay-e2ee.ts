import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import {
  AuthorizationRecord,
  DeviceLinkRecord,
  DeviceRecord,
  LocalDeviceIdentityRecord
} from '../src/contracts/velContracts';
import {
  generateDeviceCryptoMaterial,
  isPrivateKeyProtected
} from '../src/crypto/deviceCrypto';
import {
  decryptE2EEPayload,
  deriveSharedE2EESessionKey,
  encryptE2EEPayload,
  signRelayAuthChallenge
} from '../src/crypto/e2eeSession';
import { VelStorageAdapter } from '../src/db/db';
import { setupNewDeviceIdentity } from '../src/services/deviceIdentityService';
import { VelRelayClient } from '../src/services/relayClient';
import { VelRelayServer } from '../server-vel/relay-server';
import { registerDeviceHandler } from '../netlify/functions/register-device';
import { deviceSessionHandler } from '../netlify/functions/device-session';
import { pairingConfirmHandler } from '../netlify/functions/pairing-confirm';
import { revokeDeviceHandler } from '../netlify/functions/revoke-device';
import { relayConfigHandler } from '../netlify/functions/relay-config';
import {
  DeviceTransactionContext,
  DeviceTransactionStore
} from '../netlify/functions/shared/deviceAuthService';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`✓ [PASS] ${label}`);
  } else {
    failed++;
    console.error(`✗ [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3500,
  label = 'condición'
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timeout (${timeoutMs}ms) esperando: ${label}`);
}

function createPersistentStorageStub(): VelStorageAdapter {
  let identity: LocalDeviceIdentityRecord | null = null;
  const config = new Map<string, any>();
  const auths = new Map<string, AuthorizationRecord>();
  const linksMap = new Map<string, DeviceLinkRecord>();

  return {
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
    }
  };
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
      const parsedUrl = new URL(target, 'https://proyecto-vel.netlify.app');
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
  console.log('VEL 0.1 — PRUEBAS AUTOMATIZADAS INTERVENCIÓN 2/3 (RELAY + E2EE + SAS)');
  console.log('Nota: Simulación automatizada de dos clientes en Node.js (no equivale a');
  console.log('      una prueba física con dos teléfonos móviles separados).');
  console.log('========================================================================\n');

  const testStorageDir = path.join(process.cwd(), 'server-vel', 'test-data-e2ee');
  if (fs.existsSync(testStorageDir)) {
    fs.rmSync(testStorageDir, { recursive: true, force: true });
  }

  const dbMemory = createInMemoryFirestoreDeviceStore();
  const fetchAdapter = makeFetchAdapter(dbMemory);
  const verifyToken = makeVerifyTokenFn();

  // ------------------------------------------------------------------------
  // 0. Verificar /api/relay-config sin URL inventada vs URL real
  // ------------------------------------------------------------------------
  console.log('--- 0. Configuración segura de /api/relay-config ---');
  const unconfRes = await relayConfigHandler({ httpMethod: 'GET' }, {});
  const unconfJson = JSON.parse(unconfRes.body);
  assert(
    unconfRes.statusCode === 200 && unconfJson.configured === false && unconfJson.wssUrl === null,
    'Sin VEL_RELAY_WSS_URL, /api/relay-config reporta configured=false sin inventar URL'
  );

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

  const confRes = await relayConfigHandler({ httpMethod: 'GET' }, { VEL_RELAY_WSS_URL: 'wss://relay-real.ejemplo.org/' });
  const confJson = JSON.parse(confRes.body);
  assert(
    confJson.configured === true && confJson.wssUrl === 'wss://relay-real.ejemplo.org',
    '/api/relay-config entrega URL WSS real configurada por entorno'
  );

  // Verificar /health
  const healthResp = await fetch(`http://127.0.0.1:${port}/health`);
  const healthJson = await healthResp.json();
  assert(
    healthResp.status === 200 && healthJson.status === 'UP' && healthJson.firebaseAdminConfigured === true,
    'Endpoint /health responde estado operativo y verificación Admin'
  );

  // Preparar dos instalaciones independientes: CORE y MÓVIL
  const coreStorage = createPersistentStorageStub();
  const movStorage = createPersistentStorageStub();
  const coreUid = 'anon-core-uid-e2ee-1';
  const movUid = 'anon-mov-uid-e2ee-2';

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
  assert(coreSetup.success && movSetup.success, 'CORE y MÓVIL registrados con identidades independientes en Firestore');

  const coreLocal = (await coreStorage.getIdentity())!;
  const movLocal = (await movStorage.getIdentity())!;

  // ------------------------------------------------------------------------
  // 1. Rechazo de conexiones no autenticadas, /ws/{id}, token inválido o firma ECDSA falsa
  // ------------------------------------------------------------------------
  console.log('\n--- 1. Rechazo de autenticación débil o suplantación ---');
  const legacyPathReject = await new Promise<boolean>((resolve) => {
    const s = new WebSocket(`${wssUrl}/ws/${coreLocal.deviceId}`);
    s.on('close', (code) => resolve(code === 4001));
  });
  assert(legacyPathReject, 'Ruta heredada sin autenticación /ws/{deviceId} es rechazada (código 4001)');

  const badSigReject = await new Promise<boolean>((resolve) => {
    const s = new WebSocket(wssUrl);
    let closed = false;
    s.on('message', async (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'AUTH_CHALLENGE') {
        const fakeSigner = await generateDeviceCryptoMaterial('CORE');
        const sig = await signRelayAuthChallenge(
          fakeSigner.signingKeyPair.privateKey,
          m.challenge,
          coreLocal.deviceId,
          Date.now()
        );
        s.send(
          JSON.stringify({
            type: 'AUTH',
            deviceId: coreLocal.deviceId,
            role: 'CORE',
            fingerprint: coreLocal.fingerprint,
            firebaseIdToken: `valid-token-${coreUid}`,
            challenge: m.challenge,
            signatureBase64: sig,
            timestamp: Date.now()
          })
        );
      }
    });
    s.on('close', (code) => {
      if (!closed) {
        closed = true;
        resolve(code === 4001);
      }
    });
  });
  assert(badSigReject, 'Rechaza posesión física falsa (firma ECDSA con otra clave privada)');

  const spoofUidReject = await new Promise<boolean>((resolve) => {
    const s = new WebSocket(wssUrl);
    s.on('message', async (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'AUTH_CHALLENGE') {
        const ts = Date.now();
        const sig = await signRelayAuthChallenge(coreLocal.privateSigningKey, m.challenge, coreLocal.deviceId, ts);
        s.send(
          JSON.stringify({
            type: 'AUTH',
            deviceId: coreLocal.deviceId,
            role: 'CORE',
            fingerprint: coreLocal.fingerprint,
            firebaseIdToken: 'valid-token-attacker-uid',
            challenge: m.challenge,
            signatureBase64: sig,
            timestamp: ts
          })
        );
      }
    });
    s.on('close', (code) => resolve(code === 4003));
  });
  assert(spoofUidReject, 'Rechaza token Firebase cuyo UID no es el propietario de dispositivos/{deviceId}');

  // ------------------------------------------------------------------------
  // 2. Dos clientes independientes conectan y autentican vía desafío ECDSA + Token
  // ------------------------------------------------------------------------
  console.log('\n--- 2. Conexión y autenticación simultánea de dos clientes reales ---');
  const coreClient = new VelRelayClient({
    storage: coreStorage,
    getFirebaseIdToken: async () => `valid-token-${coreUid}`,
    fetchFn: fetchAdapter,
    WebSocketImpl: WebSocket,
    operationAckTimeoutMs: 2500,
    reconnectBaseDelayMs: 80,
    reconnectMaxDelayMs: 300
  });
  const movClient = new VelRelayClient({
    storage: movStorage,
    getFirebaseIdToken: async () => `valid-token-${movUid}`,
    fetchFn: fetchAdapter,
    WebSocketImpl: WebSocket,
    operationAckTimeoutMs: 2500,
    reconnectBaseDelayMs: 80,
    reconnectMaxDelayMs: 300
  });

  coreClient.connect(wssUrl);
  movClient.connect(wssUrl);

  await waitFor(
    () => coreClient.getState() === 'AUTHENTICATED' && movClient.getState() === 'AUTHENTICATED',
    4000,
    'Autenticación de ambos clientes'
  );
  assert(
    coreClient.getState() === 'AUTHENTICATED' && movClient.getState() === 'AUTHENTICATED',
    'Ambos clientes completan AUTH_CHALLENGE -> AUTH -> AUTH_SUCCESS'
  );

  // ------------------------------------------------------------------------
  // 3. Emparejamiento temporal, verificación SAS idéntica y persistencia en Firestore
  // ------------------------------------------------------------------------
  console.log('\n--- 3. Emparejamiento cifrado, código SAS 6 dígitos y confirmación ---');
  const offerRes = await coreClient.createPairingOffer();
  assert(offerRes.success && Boolean(offerRes.code), `CORE emite invitación efímera única (${offerRes.code})`);

  await waitFor(
    () => coreClient.getSnapshot().pairingSession?.stage === 'OFFERING' && Boolean(coreClient.getSnapshot().pairingSession?.linkId),
    2000,
    'Registro de oferta en Relay'
  );

  const claimRes = await movClient.claimPairingOffer(offerRes.code!);
  assert(claimRes.success, 'MÓVIL reclama la invitación con su propia clave pública SPKI');

  await waitFor(
    () =>
      coreClient.getSnapshot().pairingSession?.stage === 'SAS_PENDING' &&
      movClient.getSnapshot().pairingSession?.stage === 'SAS_PENDING',
    2500,
    'Intercambio de claves y cálculo de SAS en ambos extremos'
  );

  const coreSas = coreClient.getSnapshot().pairingSession!.sasCode;
  const movSas = movClient.getSnapshot().pairingSession!.sasCode;
  assert(
    Boolean(coreSas && /^\d{3} \d{3}$/.test(coreSas) && coreSas === movSas),
    `Ambos clientes calculan el mismo código SAS verificable (${coreSas})`
  );
  assert(
    coreClient.getState() !== 'LINKED' && movClient.getState() !== 'LINKED',
    'La vinculación NO se activa antes de confirmar explícitamente el código SAS'
  );

  // Intentar reutilizar el mismo código de invitación desde un tercero -> rechazado
  const reuseRejected = await new Promise<boolean>((resolve) => {
    const s = new WebSocket(wssUrl);
    s.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'PAIRING_ERROR') resolve(true);
    });
    s.on('open', () => {
      // No autenticado ni reutilizable -> Relay rechaza CLAIM o exige auth
      s.send(JSON.stringify({ type: 'PAIRING_CLAIM', code: offerRes.code, claimerDeviceId: 'VEL-MOV-ZZZZZZZZZZZZ', claimerPublicKeyBase64: 'AAA' }));
    });
    setTimeout(() => { s.close(); }, 1000);
  });
  assert(reuseRejected, 'Código ya reclamado / socket no autenticado rechazado al intentar reutilizar invitación');

  // Confirmar SAS desde CORE primero -> debe permanecer en SAS_AWAITING_PEER sin persistir aún
  const sasConfirmSent = coreClient.confirmPairingSas();
  assert(sasConfirmSent, 'CORE confirma coincidencia SAS ante el Relay');

  await waitFor(
    () =>
      coreClient.getSnapshot().pairingSession?.stage === 'SAS_AWAITING_PEER' &&
      movClient.getSnapshot().pairingSession?.peerConfirmedSas === true,
    2500,
    'Espera de confirmación mutua del par tras confirmación de CORE'
  );
  assert(
    coreClient.getState() !== 'LINKED' && movClient.getState() !== 'LINKED' && dbMemory.links.size === 0,
    'Una sola confirmación SAS NO activa ni persiste la vinculación en Firestore'
  );

  // Confirmar SAS también desde MÓVIL -> persiste en Firestore y deriva AES-256-GCM en ambos
  const movSasConfirmSent = movClient.confirmPairingSas();
  assert(movSasConfirmSent, 'MÓVIL confirma coincidencia SAS ante el Relay');

  await waitFor(
    () => coreClient.getState() === 'LINKED' && movClient.getState() === 'LINKED',
    3000,
    'Ambos clientes pasan a estado LINKED tras confirmación SAS mutua'
  );

  const persistedCore = dbMemory.devices.get(coreLocal.deviceId)!;
  const persistedMov = dbMemory.devices.get(movLocal.deviceId)!;
  const persistedLink = dbMemory.links.get(persistedCore.activeLinkId!)!;
  const persistedAuth = dbMemory.authorizations.get(persistedCore.activeLinkId!)!;
  assert(
    persistedCore.status === 'paired' &&
      persistedMov.status === 'paired' &&
      persistedLink.status === 'active' &&
      persistedLink.sasVerified === true &&
      persistedAuth.status === 'active',
    'Vinculación y autorización SAS persistidas atómicamente en Firestore'
  );

  // ------------------------------------------------------------------------
  // 4. Intercambio E2EE bidireccional, opacidad en Relay y confirmaciones reales
  // ------------------------------------------------------------------------
  console.log('\n--- 4. Comunicación E2EE bidireccional y estados honestos ---');
  const secretFromCore = 'SOLICITUD_E2EE_DESDE_CORE_SECRETO_9182';
  const sendCoreOut = await coreClient.sendEncryptedMessage(secretFromCore, 'Prueba CORE->MÓVIL');
  assert(sendCoreOut.accepted, 'CORE cifra y envía mensaje E2EE al Relay');

  // Asegurar que no quedó marcado CONFIRMED inmediatamente sin ACK del destinatario
  const initialOp = coreClient.getSnapshot().operations.find((o) => o.operationId === sendCoreOut.operationId)!;
  assert(initialOp.status !== 'CONFIRMED', 'Nunca marca Recibido/Confirmado antes de la confirmación real del destinatario');

  await waitFor(
    () =>
      coreClient.getSnapshot().operations.find((o) => o.operationId === sendCoreOut.operationId)?.status === 'CONFIRMED' &&
      movClient.getSnapshot().receivedMessages.some((m) => m.operationId === sendCoreOut.operationId),
    3000,
    'MÓVIL descifra y confirma recepción'
  );
  assert(
    movClient.getSnapshot().receivedMessages[0].text === secretFromCore,
    'VEL MÓVIL descifra exactamente el mensaje emitido por VEL CORE'
  );

  // Bidireccional: MÓVIL -> CORE
  const secretFromMov = 'RESPUESTA_E2EE_DESDE_MOVIL_4477';
  const sendMovOut = await movClient.sendEncryptedMessage(secretFromMov, 'Prueba MÓVIL->CORE');
  await waitFor(
    () =>
      movClient.getSnapshot().operations.find((o) => o.operationId === sendMovOut.operationId)?.status === 'CONFIRMED' &&
      coreClient.getSnapshot().receivedMessages.some((m) => m.operationId === sendMovOut.operationId),
    3000,
    'CORE descifra y confirma respuesta de MÓVIL'
  );
  assert(
    coreClient.getSnapshot().receivedMessages[0].text === secretFromMov,
    'VEL CORE descifra exactamente la respuesta de VEL MÓVIL'
  );

  // Verificar que el Relay rechaza texto plano explícito
  const plaintextRejected = await new Promise<boolean>((resolve) => {
    const wsRaw = new WebSocket(wssUrl);
    wsRaw.on('message', async (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'AUTH_CHALLENGE') {
        const ts = Date.now();
        const sig = await signRelayAuthChallenge(coreLocal.privateSigningKey, m.challenge, coreLocal.deviceId, ts);
        wsRaw.send(
          JSON.stringify({
            type: 'AUTH',
            deviceId: coreLocal.deviceId,
            role: 'CORE',
            fingerprint: coreLocal.fingerprint,
            firebaseIdToken: `valid-token-${coreUid}`,
            challenge: m.challenge,
            signatureBase64: sig,
            timestamp: ts
          })
        );
      } else if (m.type === 'AUTH_SUCCESS') {
        wsRaw.send(
          JSON.stringify({
            type: 'ENCRYPTED_MESSAGE',
            senderId: coreLocal.deviceId,
            recipientId: movLocal.deviceId,
            sessionId: persistedLink.linkId,
            operationId: 'op-plaintext-attack',
            plaintext: 'ESTO NO DEBE PASAR',
            iv: 'AAAA',
            ciphertext: 'BBBB'
          })
        );
      } else if (m.type === 'ERROR' && m.error === 'PLAINTEXT_REJECTED') {
        wsRaw.close();
        resolve(true);
      }
    });
  });
  assert(plaintextRejected, 'El Relay rechaza sobres que contengan campos en texto plano (PLAINTEXT_REJECTED)');

  // Reconnect coreClient cleanly since the temporary socket above superseded its socket intentionally
  coreClient.connect(wssUrl);
  await waitFor(() => coreClient.getState() === 'LINKED', 3000, 'Reconexión limpia de CORE tras prueba');

  // ------------------------------------------------------------------------
  // 5. Detección de alteración de cifrado / AAD (Fallo AEAD) y rechazo anti-replay
  // ------------------------------------------------------------------------
  console.log('\n--- 5. Detección de manipulación (integridad AEAD) y replay ---');
  const coreDerivedKey = await deriveSharedE2EESessionKey({
    localPrivateEcdhKey: coreLocal.privateEcdhKey,
    peerPublicKeySpkiBase64: movLocal.publicKeySpkiBase64,
    linkId: persistedLink.linkId,
    coreDeviceId: coreLocal.deviceId,
    terminalDeviceId: movLocal.deviceId
  });
  const movDerivedKey = await deriveSharedE2EESessionKey({
    localPrivateEcdhKey: movLocal.privateEcdhKey,
    peerPublicKeySpkiBase64: coreLocal.publicKeySpkiBase64,
    linkId: persistedLink.linkId,
    coreDeviceId: coreLocal.deviceId,
    terminalDeviceId: movLocal.deviceId
  });

  const testMeta = {
    sessionId: persistedLink.linkId,
    senderId: coreLocal.deviceId,
    recipientId: movLocal.deviceId,
    operationId: 'op-integrity-test-1',
    timestamp: Date.now()
  };
  const { ivBase64, ciphertextBase64 } = await encryptE2EEPayload(coreDerivedKey, 'DATO_SENSIBLE', testMeta);
  const tamperedBuf = Buffer.from(ciphertextBase64, 'base64');
  tamperedBuf[0] ^= 0xff;

  let cipherTamperRejected = false;
  try {
    await decryptE2EEPayload(movDerivedKey, ivBase64, tamperedBuf.toString('base64'), testMeta);
  } catch {
    cipherTamperRejected = true;
  }
  assert(cipherTamperRejected, 'Alterar 1 byte del ciphertext provoca fallo inmediato en AES-256-GCM');

  let aadTamperRejected = false;
  try {
    await decryptE2EEPayload(movDerivedKey, ivBase64, ciphertextBase64, {
      ...testMeta,
      senderId: 'VEL-CORE-IMPOSTOR1234'
    });
  } catch {
    aadTamperRejected = true;
  }
  assert(aadTamperRejected, 'Alterar metadatos autenticados (AAD senderId) invalida el descifrado');

  // Envío alterado a través del Relay -> receptor responde CONFIRMATION REJECTED
  const tamperedEnvelopeOpId = 'op-live-tamper-01';
  const liveEnc = await encryptE2EEPayload(coreDerivedKey, 'OK', { ...testMeta, operationId: tamperedEnvelopeOpId });
  const liveTamperedBuf = Buffer.from(liveEnc.ciphertextBase64, 'base64');
  liveTamperedBuf[2] ^= 0x55;

  const rejectedByPeer = await new Promise<boolean>((resolve) => {
    const s = new WebSocket(wssUrl);
    s.on('message', async (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'AUTH_CHALLENGE') {
        const ts = Date.now();
        const sig = await signRelayAuthChallenge(coreLocal.privateSigningKey, m.challenge, coreLocal.deviceId, ts);
        s.send(
          JSON.stringify({
            type: 'AUTH',
            deviceId: coreLocal.deviceId,
            role: 'CORE',
            fingerprint: coreLocal.fingerprint,
            firebaseIdToken: `valid-token-${coreUid}`,
            challenge: m.challenge,
            signatureBase64: sig,
            timestamp: ts
          })
        );
      } else if (m.type === 'AUTH_SUCCESS') {
        s.send(
          JSON.stringify({
            type: 'ENCRYPTED_MESSAGE',
            senderId: coreLocal.deviceId,
            recipientId: movLocal.deviceId,
            sessionId: persistedLink.linkId,
            operationId: tamperedEnvelopeOpId,
            iv: liveEnc.ivBase64,
            ciphertext: liveTamperedBuf.toString('base64'),
            timestamp: testMeta.timestamp
          })
        );
      } else if (m.type === 'CONFIRMATION' && m.operationId === tamperedEnvelopeOpId && m.status === 'REJECTED') {
        // Test duplicate replay immediately after
        s.send(
          JSON.stringify({
            type: 'ENCRYPTED_MESSAGE',
            senderId: coreLocal.deviceId,
            recipientId: movLocal.deviceId,
            sessionId: persistedLink.linkId,
            operationId: tamperedEnvelopeOpId,
            iv: liveEnc.ivBase64,
            ciphertext: liveTamperedBuf.toString('base64'),
            timestamp: testMeta.timestamp
          })
        );
      } else if (m.type === 'ERROR' && m.error === 'DUPLICATE_OPERATION' && m.operationId === tamperedEnvelopeOpId) {
        s.close();
        resolve(true);
      }
    });
  });
  assert(rejectedByPeer, 'Destinatario emite CONFIRMATION REJECTED ante ciphertext alterado y Relay bloquea replay DUPLICATE_OPERATION');

  coreClient.connect(wssUrl);
  await waitFor(() => coreClient.getState() === 'LINKED', 3000, 'CORE reconectado');

  // ------------------------------------------------------------------------
  // 6. Desconexión, ausencia de cola offline y reconexión
  // ------------------------------------------------------------------------
  console.log('\n--- 6. Desconexión, descarte sin cola y reconexión transparente ---');
  movClient.disconnect();
  await waitFor(() => movClient.getState() === 'DISCONNECTED', 2000, 'Desconexión de MÓVIL');

  const offlineSend = await coreClient.sendEncryptedMessage('MENSAJE_CUANDO_OFFLINE', 'Prueba offline');
  await waitFor(
    () => coreClient.getSnapshot().operations.find((o) => o.operationId === offlineSend.operationId)?.status === 'FAILED',
    2500,
    'Fallo explícito al enviar con par desconectado'
  );
  const failedOp = coreClient.getSnapshot().operations.find((o) => o.operationId === offlineSend.operationId)!;
  assert(
    failedOp.errorReason === 'RECIPIENT_OFFLINE',
    'Relay notifica RECIPIENT_OFFLINE y descarta el mensaje sin guardar en cola privada'
  );

  // Reconectar MÓVIL y verificar que re-deriva sesión E2EE automáticamente sin re-emparejar
  const prevMsgCount = movClient.getSnapshot().receivedMessages.length;
  movClient.connect(wssUrl);
  await waitFor(() => movClient.getState() === 'LINKED', 3000, 'Reconexión y re-derivación E2EE automática de MÓVIL');

  // Asegurar que el mensaje enviado offline NO fue re-entregado en secreto al reconectar
  await new Promise((r) => setTimeout(r, 150));
  assert(
    movClient.getSnapshot().receivedMessages.length === prevMsgCount,
    'No hubo cola ni entrega retroactiva de contenido personal tras reconectar'
  );

  // Enviar nuevo mensaje tras reconexión -> éxito inmediato
  const postReconnectOp = await coreClient.sendEncryptedMessage('DESPUES_DE_RECONEXION', 'Post reconexión');
  await waitFor(
    () => coreClient.getSnapshot().operations.find((o) => o.operationId === postReconnectOp.operationId)?.status === 'CONFIRMED',
    3000,
    'Comunicación E2EE activa tras reconexión'
  );
  assert(true, 'Intercambio E2EE operativo tras reconexión sin repetir emparejamiento');

  // ------------------------------------------------------------------------
  // 7. Persistencia en Firestore tras reinicio del servidor Relay
  // ------------------------------------------------------------------------
  console.log('\n--- 7. Continuidad de autorización tras reinicio del Relay (respaldado en Firestore) ---');
  coreClient.disconnect();
  movClient.disconnect();
  await server.stop();

  const restartedServer = new VelRelayServer({
    port: 0,
    storageDir: testStorageDir,
    deviceStore: dbMemory.store,
    verifyToken,
    hasDbCredentials: () => true,
    heartbeatIntervalMs: 60_000,
    authTimeoutMs: 5_000
  });
  const port2 = await restartedServer.start();
  const wssUrl2 = `ws://127.0.0.1:${port2}`;

  coreClient.connect(wssUrl2);
  movClient.connect(wssUrl2);
  await waitFor(
    () => coreClient.getState() === 'LINKED' && movClient.getState() === 'LINKED',
    4000,
    'Reautenticación automática con Firestore tras reinicio del Relay'
  );
  assert(true, 'Las vinculaciones y autorizaciones en Firestore sobreviven al reinicio del Relay');

  // ------------------------------------------------------------------------
  // 8. Revocación remota cierra socket, persiste en Firestore y bloquea reconexión
  // ------------------------------------------------------------------------
  console.log('\n--- 8. Revocación remota desde CORE y bloqueo permanente ---');
  const revokeOutcome = await coreClient.revokePairedTerminal(movLocal.deviceId, 'Prueba de revocación por pérdida');
  assert(
    revokeOutcome.success && revokeOutcome.persistedInFirestore && revokeOutcome.disconnectedLive,
    'CORE ejecuta revocación persistida en Firestore con desconexión en vivo'
  );

  await waitFor(() => movClient.getState() === 'REVOKED', 3000, 'MÓVIL pasa inmediatamente a estado REVOKED');
  assert(
    dbMemory.devices.get(movLocal.deviceId)?.status === 'revoked' &&
      dbMemory.links.get(persistedLink.linkId)?.status === 'revoked' &&
      dbMemory.authorizations.get(persistedLink.linkId)?.status === 'revoked' &&
      dbMemory.devices.get(coreLocal.deviceId)?.status === 'registered',
    'Firestore registra terminal/vínculo/autorización como revoked y conserva identidad de CORE'
  );

  // Verificar que intentar reconectar con el terminal revocado es rechazado por el Relay
  const revokedReconnectBlocked = await new Promise<boolean>((resolve) => {
    const s = new WebSocket(wssUrl2);
    s.on('message', async (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'AUTH_CHALLENGE') {
        const ts = Date.now();
        const sig = await signRelayAuthChallenge(movLocal.privateSigningKey, m.challenge, movLocal.deviceId, ts);
        s.send(
          JSON.stringify({
            type: 'AUTH',
            deviceId: movLocal.deviceId,
            role: 'TERMINAL',
            fingerprint: movLocal.fingerprint,
            firebaseIdToken: `valid-token-${movUid}`,
            challenge: m.challenge,
            signatureBase64: sig,
            timestamp: ts
          })
        );
      }
    });
    s.on('close', (code) => resolve(code === 4003));
  });
  assert(revokedReconnectBlocked, 'Reconexión de dispositivo revocado rechazada inmediatamente con código 4003');

  // ------------------------------------------------------------------------
  // 9. Ausencia absoluta de claves privadas y contenido personal en Firestore
  // ------------------------------------------------------------------------
  console.log('\n--- 9. Verificación de cero datos personales y protección de claves ---');
  const finalCoreStored = (await coreStorage.getIdentity())!;
  assert(
    isPrivateKeyProtected(finalCoreStored.privateEcdhKey) &&
      isPrivateKeyProtected(finalCoreStored.privateSigningKey),
    'Claves privadas en almacenamiento local mantienen extractable=false'
  );

  const firestoreSnapshotJson = JSON.stringify({
    devices: Array.from(dbMemory.devices.values()),
    links: Array.from(dbMemory.links.values()),
    authorizations: Array.from(dbMemory.authorizations.values())
  });
  assert(
    !firestoreSnapshotJson.includes(secretFromCore) &&
      !firestoreSnapshotJson.includes(secretFromMov) &&
      !firestoreSnapshotJson.includes('privateKey') &&
      !firestoreSnapshotJson.includes('privateEcdhKey'),
    'Firestore contiene cero mensajes personales y cero claves privadas'
  );

  coreClient.disconnect();
  movClient.disconnect();
  await restartedServer.stop();
  if (fs.existsSync(testStorageDir)) {
    fs.rmSync(testStorageDir, { recursive: true, force: true });
  }

  console.log('\n========================================================================');
  console.log(`RESUMEN PRUEBAS INTERVENCIÓN 2/3 (RELAY + E2EE): ${passed} PASS / ${failed} FAIL`);
  console.log('========================================================================');
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('\n[ERROR FATAL EN PRUEBAS RELAY E2EE]:', err);
  process.exit(1);
});
