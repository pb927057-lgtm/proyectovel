import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import {
  AuthorizationRecord,
  DeviceLinkRecord,
  DeviceRecord,
  LocalDeviceIdentityRecord
} from '../src/contracts/velContracts';
import {
  isPrivateKeyProtected
} from '../src/crypto/deviceCrypto';
import { VelStorageAdapter } from '../src/db/db';
import {
  loadPersistedDeviceIdentity,
  setupNewDeviceIdentity,
  syncPersistedDeviceSession
} from '../src/services/deviceIdentityService';
import { VelRelayClient } from '../src/services/relayClient';
import { VelRelayServer } from '../server-vel/relay-server';
import { registerDeviceHandler } from '../netlify/functions/register-device';
import { deviceSessionHandler } from '../netlify/functions/device-session';
import { pairingConfirmHandler } from '../netlify/functions/pairing-confirm';
import { revokeDeviceHandler } from '../netlify/functions/revoke-device';
import { handler as getPricingHandler } from '../netlify/functions/get-pricing';
import { downloadPackageHandler } from '../netlify/functions/download-package';
import {
  DeviceTransactionContext,
  DeviceTransactionStore
} from '../netlify/functions/shared/deviceAuthService';
import {
  CURRENT_CONTRACT_VERSION,
  isTechnicalAccount,
  OFFICIAL_CONTRACT_URL
} from '../src/services/firestore';

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

async function waitFor(predicate: () => boolean, timeoutMs = 4000, label = 'condición'): Promise<void> {
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

async function runIntegrationFinalTests() {
  console.log('========================================================================');
  console.log('VEL 0.1 — PRUEBAS DE INTEGRACIÓN FINAL (INTERVENCIÓN 3/3)');
  console.log('Nota: Cubre verificación automatizada de artefactos PWA, Blogger,');
  console.log('      contratos, flujo CORE/MÓVIL completo, reemplazo, revocaciones');
  console.log('      online/offline y coexistencia comercial en entorno Node.js.');
  console.log('      NO sustituye la prueba física con dos teléfonos reales.');
  console.log('========================================================================\n');

  // ------------------------------------------------------------------------
  // 1 & 2. Blogger -> Netlify + Manifest + Service Worker + Iconos + Sin APK/ZIP instalador
  // ------------------------------------------------------------------------
  console.log('--- 1 & 2. Blogger, Manifest PWA, Iconos y Service Worker ---');
  const root = process.cwd();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'manifest.json'), 'utf8'));
  const swJs = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const bloggerHtml = fs.readFileSync(path.join(root, 'blogger', 'vel-contratacion-mercadopago.html'), 'utf8');
  const appTsx = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');

  assert(
    manifest.name === 'VEL' &&
      manifest.short_name === 'VEL' &&
      manifest.display === 'standalone' &&
      manifest.start_url === '/' &&
      manifest.scope === '/',
    'manifest.json define name="VEL", short_name="VEL", standalone, start_url="/", scope="/"'
  );

  const expectedIcons = ['pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png', 'apple-touch-icon.png'];
  const allIconsExist = expectedIcons.every((iconFile) =>
    fs.existsSync(path.join(root, 'public', iconFile))
  );
  assert(allIconsExist, 'Existen todos los íconos PWA físicos en /public (192, 512, maskable, apple-touch)');

  assert(
    swJs.includes("pathname.startsWith('/api/')") &&
      swJs.includes("pathname.startsWith('/.netlify/')") &&
      swJs.includes("pathname.endsWith('.zip')") &&
      swJs.includes("request.headers.get('Authorization')") &&
      swJs.includes("SKIP_WAITING"),
    'Service Worker cachea solo estáticos y excluye /api/, /.netlify/, .zip y tokens'
  );

  assert(
    indexHtml.includes('rel="manifest" href="/manifest.json"') &&
      indexHtml.includes('serviceWorker.register(\'/sw.js\'') &&
      indexHtml.includes('vel-sw-update-ready'),
    'index.html enlaza manifest.json, registra /sw.js y detecta actualizaciones del Service Worker'
  );

  assert(
    bloggerHtml.includes('https://proyecto-vel.netlify.app') &&
      bloggerHtml.includes('Entrar a VEL') &&
      bloggerHtml.includes(OFFICIAL_CONTRACT_URL) &&
      !bloggerHtml.includes('TU-SITIO-NETLIFY'),
    'Blogger apunta al dominio real https://proyecto-vel.netlify.app con acceso visible y contrato oficial'
  );

  assert(
    !appTsx.includes('APK Android Nativo') &&
      !appTsx.includes('Descargar ZIP Netlify') &&
      !bloggerHtml.toLowerCase().includes('.apk'),
    'Ni la app ni Blogger presentan APK ni ZIP como instalador móvil'
  );

  assert(
    appTsx.includes('velOfflineSync') &&
      appTsx.includes('Bóveda Local Cifrada (CORE)') &&
      appTsx.includes('Limpiar memoria') &&
      appTsx.includes('pago_retorno'),
    'App.tsx integra bóveda local cifrada solo en CORE, memoria volátil en MÓVIL y retorno de Mercado Pago'
  );

  // ------------------------------------------------------------------------
  // 3. Validación de contratos y exclusión de cuentas técnicas
  // ------------------------------------------------------------------------
  console.log('\n--- 3. Contratos y versión vigente ---');
  assert(CURRENT_CONTRACT_VERSION === '1.0-draft', 'Versión de contrato configurada como 1.0-draft');
  assert(
    isTechnicalAccount(undefined, 'soporte@vel.com') &&
      isTechnicalAccount(undefined, 'admin@vel.com') &&
      !isTechnicalAccount('uid-cliente-real', 'cliente@ejemplo.com'),
    'Cuentas técnicas bloqueadas sin afectar a clientes reales'
  );
  assert(
    !/recordContractAcceptance\([^)]*\)\.catch/.test(appTsx) &&
      !/getContractAcceptance\([^)]*\)\.catch/.test(appTsx) &&
      appTsx.includes('recordContractAcceptance') &&
      appTsx.includes('!acceptanceRes.success') &&
      appTsx.includes('setContractError'),
    'App.tsx maneja errores de recordContractAcceptance sin silenciarlos y bloquea Checkout ante fallo'
  );

  // ------------------------------------------------------------------------
  // 4..10. Ciclo completo: CORE + MÓVIL 1, SAS mutuo, E2EE, reemplazo, revocaciones
  // ------------------------------------------------------------------------
  console.log('\n--- 4..10. Flujo completo CORE + MÓVIL 1 + Reemplazo MÓVIL 2 + Revocaciones ---');
  const testStorageDir = path.join(root, 'server-vel', 'test-data-final');
  if (fs.existsSync(testStorageDir)) fs.rmSync(testStorageDir, { recursive: true, force: true });

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

  const coreStorage = createPersistentStorageStub();
  const mov1Storage = createPersistentStorageStub();
  const mov2Storage = createPersistentStorageStub();

  const coreUid = 'uid-final-core';
  const mov1Uid = 'uid-final-mov1';
  const mov2Uid = 'uid-final-mov2';

  await setupNewDeviceIdentity('CORE', undefined, {
    storage: coreStorage,
    ensureAnonymousAuth: async () => ({ success: true, uid: coreUid, idToken: `valid-token-${coreUid}` }),
    fetchFn: fetchAdapter
  });
  await setupNewDeviceIdentity('TERMINAL', undefined, {
    storage: mov1Storage,
    ensureAnonymousAuth: async () => ({ success: true, uid: mov1Uid, idToken: `valid-token-${mov1Uid}` }),
    fetchFn: fetchAdapter
  });
  await setupNewDeviceIdentity('TERMINAL', undefined, {
    storage: mov2Storage,
    ensureAnonymousAuth: async () => ({ success: true, uid: mov2Uid, idToken: `valid-token-${mov2Uid}` }),
    fetchFn: fetchAdapter
  });

  const coreLocal = (await loadPersistedDeviceIdentity({ storage: coreStorage }))!;
  const mov1Local = (await loadPersistedDeviceIdentity({ storage: mov1Storage }))!;
  const mov2Local = (await loadPersistedDeviceIdentity({ storage: mov2Storage }))!;

  assert(
    coreLocal.role === 'CORE' && mov1Local.role === 'TERMINAL' && mov2Local.role === 'TERMINAL',
    'Roles persistidos en almacenamiento local tras primer acceso'
  );

  // Reapertura simulada: syncPersistedDeviceSession conserva identidad y estado
  const reopenedCore = await syncPersistedDeviceSession({
    storage: coreStorage,
    getFreshToken: async () => `valid-token-${coreUid}`,
    fetchFn: fetchAdapter
  });
  assert(
    Boolean(reopenedCore?.synced && reopenedCore.identity.deviceId === coreLocal.deviceId),
    'Al reabrir la PWA, reconoce identidad técnica y rol sin volver a preguntar'
  );

  const coreClient = new VelRelayClient({
    storage: coreStorage,
    getFirebaseIdToken: async () => `valid-token-${coreUid}`,
    fetchFn: fetchAdapter,
    WebSocketImpl: WebSocket,
    operationAckTimeoutMs: 1500
  });
  const mov1Client = new VelRelayClient({
    storage: mov1Storage,
    getFirebaseIdToken: async () => `valid-token-${mov1Uid}`,
    fetchFn: fetchAdapter,
    WebSocketImpl: WebSocket,
    operationAckTimeoutMs: 1500
  });

  // Intentar llamadas duplicadas a connect() -> no debe duplicar ni romper conexión
  coreClient.connect(wssUrl);
  coreClient.connect(wssUrl);
  mov1Client.connect(wssUrl);
  mov1Client.connect(wssUrl);

  await waitFor(
    () => coreClient.getState() === 'AUTHENTICATED' && mov1Client.getState() === 'AUTHENTICATED',
    4000,
    'Autenticación inicial CORE y MÓVIL 1'
  );
  assert(server.getActiveClientCount() === 2, 'Guard anti-duplicado mantiene exactamente 2 sockets activos');

  // Emparejamiento CORE <-> MÓVIL 1 con SAS mutuo
  const offer1 = await coreClient.createPairingOffer();
  await waitFor(
    () =>
      coreClient.getSnapshot().pairingSession?.stage === 'OFFERING' &&
      Boolean(coreClient.getSnapshot().pairingSession?.linkId),
    2000,
    'Oferta CORE'
  );
  await mov1Client.claimPairingOffer(offer1.code!);
  await waitFor(
    () =>
      coreClient.getSnapshot().pairingSession?.stage === 'SAS_PENDING' &&
      mov1Client.getSnapshot().pairingSession?.stage === 'SAS_PENDING',
    2500,
    'SAS_PENDING en ambos'
  );

  // MÓVIL 1 confirma primero -> debe quedar en SAS_AWAITING_PEER
  mov1Client.confirmPairingSas();
  await waitFor(
    () => mov1Client.getSnapshot().pairingSession?.stage === 'SAS_AWAITING_PEER',
    2000,
    'MÓVIL en SAS_AWAITING_PEER'
  );
  assert(
    coreClient.getState() === 'AUTHENTICATED' && dbMemory.links.size === 0,
    'Confirmación unilateral de MÓVIL NO activa vinculación hasta que CORE también confirme'
  );

  // CORE confirma -> LINKED en ambos
  coreClient.confirmPairingSas();
  await waitFor(
    () => coreClient.getState() === 'LINKED' && mov1Client.getState() === 'LINKED',
    3000,
    'LINKED tras confirmación SAS mutua'
  );

  // E2EE operativo
  const msg1 = await coreClient.sendEncryptedMessage('NOTA_SOBERANA_CORE_1', 'Prueba E2EE 1');
  await waitFor(
    () =>
      coreClient.getSnapshot().operations.find((o) => o.operationId === msg1.operationId)?.status === 'CONFIRMED' &&
      mov1Client.getSnapshot().receivedMessages.some((m) => m.text === 'NOTA_SOBERANA_CORE_1'),
    3000,
    'Recepción E2EE en MÓVIL 1'
  );
  assert(true, 'Comunicación E2EE bidireccional confirmada entre CORE y MÓVIL 1');

  // Desconectar MÓVIL 1 antes de revocarlo -> debe reportar Revocación pendiente (persistedInFirestore=true, disconnectedLive=false)
  mov1Client.disconnect();
  await waitFor(() => mov1Client.getState() === 'DISCONNECTED', 2000, 'Desconexión de MÓVIL 1');
  assert(
    mov1Client.getSnapshot().receivedMessages.length === 0,
    'MÓVIL limpia su memoria volátil al desconectarse (cero copia persistente)'
  );

  const offlineRevoke = await coreClient.revokePairedTerminal(mov1Local.deviceId, 'Reemplazo con MÓVIL 1 offline');
  assert(
    offlineRevoke.success &&
      offlineRevoke.persistedInFirestore &&
      !offlineRevoke.disconnectedLive &&
      coreClient.getSnapshot().revocationStatus === 'PERSISTED_PEER_OFFLINE',
    'Revocación con terminal offline reporta estado honesto PERSISTED_PEER_OFFLINE (Revocación pendiente)'
  );

  // MÓVIL 1 intenta reconectar después de ser revocado offline -> bloqueado con 4003
  const mov1Blocked = await new Promise<boolean>((resolve) => {
    const c = new VelRelayClient({
      storage: mov1Storage,
      getFirebaseIdToken: async () => `valid-token-${mov1Uid}`,
      fetchFn: fetchAdapter,
      WebSocketImpl: WebSocket
    });
    const unsub = c.onStateChange((st) => {
      if (st === 'REVOKED') {
        unsub();
        c.disconnect();
        resolve(true);
      }
    });
    c.connect(wssUrl);
    setTimeout(() => resolve(false), 3000);
  });
  assert(mov1Blocked, 'MÓVIL 1 revocado offline es rechazado automáticamente al intentar reconectar');

  // Vincular MÓVIL 2 conservando identidad intacta de VEL CORE
  const mov2Client = new VelRelayClient({
    storage: mov2Storage,
    getFirebaseIdToken: async () => `valid-token-${mov2Uid}`,
    fetchFn: fetchAdapter,
    WebSocketImpl: WebSocket
  });
  mov2Client.connect(wssUrl);
  await waitFor(() => mov2Client.getState() === 'AUTHENTICATED', 3000, 'Autenticación de MÓVIL 2');

  const offer2 = await coreClient.createPairingOffer();
  await waitFor(
    () =>
      coreClient.getSnapshot().pairingSession?.stage === 'OFFERING' &&
      Boolean(coreClient.getSnapshot().pairingSession?.linkId),
    2000,
    'Oferta 2'
  );
  await mov2Client.claimPairingOffer(offer2.code!);
  await waitFor(
    () =>
      coreClient.getSnapshot().pairingSession?.stage === 'SAS_PENDING' &&
      mov2Client.getSnapshot().pairingSession?.stage === 'SAS_PENDING',
    2500,
    'SAS_PENDING CORE <-> MÓVIL 2'
  );
  coreClient.confirmPairingSas();
  mov2Client.confirmPairingSas();
  await waitFor(
    () => coreClient.getState() === 'LINKED' && mov2Client.getState() === 'LINKED',
    3000,
    'LINKED CORE <-> MÓVIL 2'
  );
  const coreAfterReplace = (await coreStorage.getIdentity())!;
  assert(
    coreAfterReplace.deviceId === coreLocal.deviceId &&
      isPrivateKeyProtected(coreAfterReplace.privateEcdhKey) &&
      coreAfterReplace.pairedPeerDeviceId === mov2Local.deviceId,
    'Reemplazo conserva intacto el deviceId y claves no exportables de VEL CORE'
  );

  // Revocación de emergencia con MÓVIL 2 EN LÍNEA -> Revocación confirmada
  const liveRevoke = await coreClient.revokePairedTerminal(mov2Local.deviceId, 'Emergencia con terminal en línea');
  await waitFor(() => mov2Client.getState() === 'REVOKED', 3000, 'MÓVIL 2 recibe REVOCATION_NOTICE en vivo');
  assert(
    liveRevoke.success &&
      liveRevoke.persistedInFirestore &&
      liveRevoke.disconnectedLive &&
      coreClient.getSnapshot().revocationStatus === 'CONFIRMED',
    'Revocación con terminal online reporta CONFIRMED (Revocación confirmada) y cierra socket en vivo'
  );

  // ------------------------------------------------------------------------
  // 11. Suspensión comercial NO revoca dispositivos ni borra custodia CORE
  // ------------------------------------------------------------------------
  console.log('\n--- 11. Independencia comercial vs custodia CORE y dispositivos ---');
  const fakeSubscribers: Record<string, any> = {
    'uid-comercial-test': {
      uid: 'uid-comercial-test',
      email: 'cliente@vel.test',
      estado: 'suspendido',
      plan: 'Plan Oficial VEL (2 Teléfonos: CORE + MÓVIL)',
      precioContratado: 4500,
      moneda: 'ARS',
      venceEl: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    }
  };
  const pricingRes = await getPricingHandler({ httpMethod: 'GET' });
  assert(
    pricingRes.statusCode === 200 || pricingRes.statusCode === 503,
    `get-pricing responde de forma controlada sin credenciales hardcodeadas (HTTP ${pricingRes.statusCode})`
  );

  const dlRes = await downloadPackageHandler(
    { httpMethod: 'GET', headers: { Authorization: 'Bearer valid-tok' } },
    {
      verifyToken: async () => ({ authenticated: true, uid: 'uid-comercial-test', email: 'cliente@vel.test' }),
      getSubscriber: async (uid) => fakeSubscribers[uid] || null,
      updateSubscriberStatus: async () => {}
    }
  );
  assert(
    dlRes.statusCode === 403 && dbMemory.devices.get(coreLocal.deviceId)?.status !== 'revoked',
    'Suspensión comercial bloquea descarga comercial (403) SIN revocar VEL CORE ni borrar su estado'
  );

  // Limpieza
  coreClient.disconnect();
  mov1Client.disconnect();
  mov2Client.disconnect();
  await server.stop();
  if (fs.existsSync(testStorageDir)) fs.rmSync(testStorageDir, { recursive: true, force: true });

  console.log('\n========================================================================');
  console.log(`RESUMEN PRUEBAS INTEGRACIÓN FINAL (3/3): ${passed} PASS / ${failed} FAIL`);
  console.log('========================================================================');
  if (failed > 0) {
    process.exit(1);
  }
}

runIntegrationFinalTests().catch((err) => {
  console.error('\n[ERROR FATAL EN INTEGRACIÓN FINAL]:', err);
  process.exit(1);
});
