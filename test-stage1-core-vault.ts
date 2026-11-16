import {
  AuthorizationRecord,
  DeviceLinkRecord,
  LocalDeviceIdentityRecord
} from '../src/contracts/velContracts';
import {
  generateDeviceCryptoMaterial,
  isPrivateKeyProtected,
  signTechnicalChallenge
} from '../src/crypto/deviceCrypto';
import {
  decryptE2EEBytes,
  decryptE2EEPayload,
  deriveSharedE2EESessionKey,
  encryptE2EEBytes,
  encryptE2EEPayload
} from '../src/crypto/e2eeSession';
import {
  computeSha256Hex,
  hashBlobIncremental,
  IncrementalSha256
} from '../src/crypto/fileHash';
import {
  CoreFileVaultManager,
  getCoreStorageEstimate,
  requestCorePersistentStorage
} from '../src/db/coreFileVault';
import {
  STORE_AUTHORIZATIONS,
  STORE_CONFIG,
  STORE_IDENTITY,
  STORE_LINKS,
  STORE_RECORDS,
  STORE_VAULT_CHUNKS,
  STORE_VAULT_FILES,
  VEL_DB_VERSION,
  VelCoreVaultStorageAdapter,
  VelDatabase,
  velDb
} from '../src/db/db';
import {
  LOCAL_VAULT_KEY_CONFIG,
  resetLocalVaultKeyCache,
  velOfflineSync
} from '../src/db/offlineSync';

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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function makePatternBytes(size: number, seed = 17): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
}

async function subtleSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Motor IndexedDB fiel a las reglas de transacciones/versionado para probar
 * VelDatabase real (onupgradeneeded v2 -> v3, índices, cursors, oncomplete, onabort, close/reopen).
 */
function createPersistentIndexedDbHarness() {
  interface StoredIndexDef {
    name: string;
    keyPath: string;
    unique: boolean;
  }
  interface StoredObjectStore {
    name: string;
    keyPath: string;
    indexes: Map<string, StoredIndexDef>;
    records: Map<string, any>;
  }
  interface StoredDbSchema {
    version: number;
    stores: Map<string, StoredObjectStore>;
  }

  const databases = new Map<string, StoredDbSchema>();
  let simulatedWriteFailure: { storeName: string; onCallNumber: number; calls: number; error: Error } | null = null;

  class MockIDBKeyRange {
    readonly lower: unknown;
    readonly upper: unknown;
    constructor(value: unknown) {
      this.lower = value;
      this.upper = value;
    }
    static only(value: unknown): MockIDBKeyRange {
      return new MockIDBKeyRange(value);
    }
  }

  function cloneRecordPreservingCryptoKey<T>(val: T): T {
    if (val === null || typeof val !== 'object') return val;
    // CryptoKey no debe ser clonado manualmente como {} ni destruido
    if (typeof (val as any).type === 'string' && typeof (val as any).extractable === 'boolean') {
      return val;
    }
    if (val instanceof ArrayBuffer) {
      return val.slice(0) as unknown as T;
    }
    if (ArrayBuffer.isView(val)) {
      const u = new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
      return u.slice().buffer as unknown as T;
    }
    if (Array.isArray(val)) {
      return val.map((item) => cloneRecordPreservingCryptoKey(item)) as unknown as T;
    }
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      copy[k] = cloneRecordPreservingCryptoKey(v);
    }
    return copy as T;
  }

  function makeDOMStringList(names: string[]) {
    const list = [...names] as any;
    list.contains = (name: string) => names.includes(name);
    list.item = (idx: number) => names[idx] ?? null;
    return list;
  }

  function createRequest<T = any>() {
    return {
      result: undefined as T,
      error: null as any,
      onsuccess: null as ((ev: any) => void) | null,
      onerror: null as ((ev: any) => void) | null,
      transaction: null as any
    };
  }

  function createHarnessDb(name: string, schema: StoredDbSchema, openConnections: Set<any>) {
    let closed = false;

    const dbHandle: any = {
      name,
      get version() {
        return schema.version;
      },
      get objectStoreNames() {
        return makeDOMStringList(Array.from(schema.stores.keys()));
      },
      onversionchange: null as ((ev: any) => void) | null,
      onclose: null as ((ev: any) => void) | null,
      close() {
        if (closed) return;
        closed = true;
        openConnections.delete(dbHandle);
        if (dbHandle.onclose) {
          queueMicrotask(() => dbHandle.onclose?.({ target: dbHandle }));
        }
      },
      createObjectStore(storeName: string, options: { keyPath: string }) {
        if (schema.stores.has(storeName)) {
          throw new Error(`ObjectStore already exists: ${storeName}`);
        }
        const storeDef: StoredObjectStore = {
          name: storeName,
          keyPath: options.keyPath,
          indexes: new Map(),
          records: new Map()
        };
        schema.stores.set(storeName, storeDef);
        return {
          createIndex(indexName: string, keyPath: string, idxOpts?: { unique?: boolean }) {
            storeDef.indexes.set(indexName, {
              name: indexName,
              keyPath,
              unique: Boolean(idxOpts?.unique)
            });
            return { name: indexName, keyPath };
          }
        };
      },
      deleteObjectStore(storeName: string) {
        schema.stores.delete(storeName);
      },
      transaction(storeNames: string | string[], mode: 'readonly' | 'readwrite' = 'readonly') {
        if (closed) {
          throw new Error('InvalidStateError: connection is closed');
        }
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        for (const s of names) {
          if (!schema.stores.has(s)) {
            throw new Error(`NotFoundError: objectStore ${s} not found`);
          }
        }

        const tx: any = {
          mode,
          error: null,
          aborted: false,
          oncomplete: null as ((ev: any) => void) | null,
          onerror: null as ((ev: any) => void) | null,
          onabort: null as ((ev: any) => void) | null,
          pendingOps: 0,
          scheduledComplete: false,
          abort() {
            if (tx.aborted) return;
            tx.aborted = true;
            tx.error = tx.error || new Error('Transaction aborted');
            if (tx.onabort) {
              queueMicrotask(() => tx.onabort?.({ target: tx }));
            }
          },
          objectStore(storeName: string) {
            if (!names.includes(storeName)) {
              throw new Error(`NotFoundError: store ${storeName} not in transaction scope`);
            }
            const storeDef = schema.stores.get(storeName)!;

            const scheduleFinish = () => {
              if (tx.aborted || tx.scheduledComplete) return;
              if (tx.pendingOps === 0) {
                tx.scheduledComplete = true;
                queueMicrotask(() => {
                  if (!tx.aborted) {
                    tx.oncomplete?.({ target: tx });
                  }
                });
              }
            };

            const runOp = <T>(executor: () => T, isWrite = false) => {
              const req = createRequest<T>();
              req.transaction = tx;
              tx.pendingOps++;
              queueMicrotask(() => {
                if (tx.aborted) {
                  tx.pendingOps--;
                  return;
                }
                if (
                  isWrite &&
                  simulatedWriteFailure &&
                  simulatedWriteFailure.storeName === storeName
                ) {
                  simulatedWriteFailure.calls++;
                  if (simulatedWriteFailure.calls >= simulatedWriteFailure.onCallNumber) {
                    const injected = simulatedWriteFailure.error;
                    req.error = injected;
                    tx.error = injected;
                    tx.aborted = true;
                    tx.pendingOps--;
                    req.onerror?.({ target: req });
                    tx.onerror?.({ target: tx });
                    tx.onabort?.({ target: tx });
                    return;
                  }
                }
                try {
                  req.result = executor();
                  tx.pendingOps--;
                  req.onsuccess?.({ target: req });
                  scheduleFinish();
                } catch (err) {
                  req.error = err;
                  tx.error = err;
                  tx.aborted = true;
                  tx.pendingOps--;
                  req.onerror?.({ target: req });
                  tx.onerror?.({ target: tx });
                  tx.onabort?.({ target: tx });
                }
              });
              return req;
            };

            return {
              put(value: any) {
                if (mode !== 'readwrite') throw new Error('ReadOnlyError');
                return runOp(() => {
                  const cloned = cloneRecordPreservingCryptoKey(value);
                  const key = String(cloned[storeDef.keyPath]);
                  storeDef.records.set(key, cloned);
                  return key;
                }, true);
              },
              get(key: unknown) {
                return runOp(() => {
                  const found = storeDef.records.get(String(key));
                  return found !== undefined ? cloneRecordPreservingCryptoKey(found) : undefined;
                });
              },
              getAll() {
                return runOp(() =>
                  Array.from(storeDef.records.values()).map((r) => cloneRecordPreservingCryptoKey(r))
                );
              },
              count() {
                return runOp(() => storeDef.records.size);
              },
              delete(key: unknown) {
                if (mode !== 'readwrite') throw new Error('ReadOnlyError');
                return runOp(() => {
                  storeDef.records.delete(String(key));
                  return undefined;
                }, true);
              },
              index(indexName: string) {
                const idxDef = storeDef.indexes.get(indexName);
                if (!idxDef) {
                  throw new Error(`Index not found: ${indexName}`);
                }
                const matchesRange = (record: any, range?: MockIDBKeyRange) => {
                  if (!range) return true;
                  return record[idxDef.keyPath] === range.lower;
                };
                return {
                  getAll(range?: MockIDBKeyRange) {
                    return runOp(() =>
                      Array.from(storeDef.records.values())
                        .filter((r) => matchesRange(r, range))
                        .map((r) => cloneRecordPreservingCryptoKey(r))
                    );
                  },
                  openCursor(range?: MockIDBKeyRange) {
                    const req = createRequest<any>();
                    req.transaction = tx;
                    tx.pendingOps++;
                    const keys = Array.from(storeDef.records.entries())
                      .filter(([, r]) => matchesRange(r, range))
                      .map(([k]) => k);
                    let cursorPos = 0;

                    const advanceCursor = () => {
                      if (tx.aborted) {
                        tx.pendingOps--;
                        return;
                      }
                      if (cursorPos >= keys.length) {
                        req.result = null;
                        tx.pendingOps--;
                        req.onsuccess?.({ target: req });
                        scheduleFinish();
                        return;
                      }
                      const recordKey = keys[cursorPos++];
                      const rec = storeDef.records.get(recordKey);
                      req.result = {
                        value: cloneRecordPreservingCryptoKey(rec),
                        delete() {
                          if (mode !== 'readwrite') throw new Error('ReadOnlyError');
                          return runOp(() => {
                            storeDef.records.delete(recordKey);
                            return undefined;
                          }, true);
                        },
                        continue() {
                          queueMicrotask(advanceCursor);
                        }
                      };
                      req.onsuccess?.({ target: req });
                    };

                    queueMicrotask(advanceCursor);
                    return req;
                  }
                };
              }
            };
          }
        };

        return tx;
      }
    };

    openConnections.add(dbHandle);
    return dbHandle;
  }

  const connectionsByDb = new Map<string, Set<any>>();

  const factory = {
    open(name: string, version = 1) {
      const req: any = createRequest();
      req.onupgradeneeded = null;
      req.onblocked = null;

      queueMicrotask(() => {
        let schema = databases.get(name);
        const oldVersion = schema ? schema.version : 0;
        if (!schema) {
          schema = { version: 0, stores: new Map() };
          databases.set(name, schema);
        }

        if (version < oldVersion) {
          req.error = new Error(`VersionError: requested ${version} < existing ${oldVersion}`);
          req.onerror?.({ target: req });
          return;
        }

        let openSet = connectionsByDb.get(name);
        if (!openSet) {
          openSet = new Set();
          connectionsByDb.set(name, openSet);
        }

        if (version > oldVersion) {
          for (const existingConn of Array.from(openSet)) {
            existingConn.onversionchange?.({ oldVersion, newVersion: version });
          }
        }

        const snapshotBeforeUpgrade = new Map(
          Array.from(schema.stores.entries()).map(([k, v]) => [
            k,
            {
              ...v,
              indexes: new Map(v.indexes),
              records: new Map(v.records)
            }
          ])
        );

        const dbHandle = createHarnessDb(name, schema, openSet);

        if (version > oldVersion) {
          schema.version = version;
          const upgradeTx = {
            mode: 'versionchange',
            error: null as any,
            aborted: false,
            onerror: null as ((ev: any) => void) | null,
            onabort: null as ((ev: any) => void) | null,
            abort() {
              upgradeTx.aborted = true;
              schema!.version = oldVersion;
              schema!.stores = snapshotBeforeUpgrade;
              upgradeTx.onabort?.({ target: upgradeTx });
            }
          };
          req.result = dbHandle;
          req.transaction = upgradeTx;
          try {
            req.onupgradeneeded?.({ target: req, oldVersion, newVersion: version });
          } catch (err) {
            upgradeTx.error = err;
            upgradeTx.abort();
            req.error = err;
            req.onerror?.({ target: req });
            return;
          }
          if (upgradeTx.aborted) {
            req.error = upgradeTx.error || new Error('Upgrade aborted');
            req.onerror?.({ target: req });
            return;
          }
        }

        req.result = dbHandle;
        req.transaction = null;
        req.onsuccess?.({ target: req });
      });

      return req;
    }
  };

  return {
    factory,
    KeyRange: MockIDBKeyRange,
    setWriteFailure(storeName: string, onCallNumber: number, error: Error) {
      simulatedWriteFailure = { storeName, onCallNumber, calls: 0, error };
    },
    clearWriteFailure() {
      simulatedWriteFailure = null;
    },
    getSchema(name: string) {
      return databases.get(name);
    }
  };
}

async function runTests(): Promise<void> {
  console.log('========================================================================');
  console.log('VEL 0.1 — PRUEBAS OBLIGATORIAS ETAPA 1 (HASH + E2EE BINARIO + BÓVEDA CORE)');
  console.log('========================================================================\n');

  // ------------------------------------------------------------------
  // 1. SHA-256 incremental vs Web Crypto crypto.subtle.digest()
  // ------------------------------------------------------------------
  console.log('--- 1. SHA-256 incremental frente a crypto.subtle.digest() ---');
  const hashCases: Array<{ label: string; size: number; chunkSizes: number[] }> = [
    { label: 'Archivo vacío (0 B)', size: 0, chunkSizes: [1, 64, 128 * 1024] },
    { label: '1 byte', size: 1, chunkSizes: [1, 64] },
    { label: '63 bytes (límite bloque - 1)', size: 63, chunkSizes: [1, 7, 63, 64] },
    { label: '64 bytes (límite exacto bloque)', size: 64, chunkSizes: [1, 13, 64, 128] },
    { label: '65 bytes (límite bloque + 1)', size: 65, chunkSizes: [1, 31, 64, 65] },
    { label: '128 KB', size: 128 * 1024, chunkSizes: [997, 64 * 1024, 128 * 1024] },
    { label: '2 MB', size: 2 * 1024 * 1024, chunkSizes: [128 * 1024, 512 * 1024] },
    { label: '10 MB', size: 10 * 1024 * 1024, chunkSizes: [128 * 1024, 777 * 1024, 2 * 1024 * 1024] }
  ];

  for (const tc of hashCases) {
    const payload = makePatternBytes(tc.size, tc.size + 42);
    const expectedHex = await subtleSha256Hex(payload);
    const singleShotHex = computeSha256Hex(payload);
    assert(singleShotHex === expectedHex, `SHA-256 single-shot coincide para ${tc.label}`);

    for (const step of tc.chunkSizes) {
      const hasher = new IncrementalSha256();
      for (let off = 0; off < payload.byteLength; off += step) {
        hasher.update(payload.subarray(off, Math.min(off + step, payload.byteLength)));
      }
      const incHex = hasher.digestHex();
      const incHexRepeat = hasher.digestHex();
      assert(
        incHex === expectedHex && incHexRepeat === expectedHex && hasher.getTotalBytes() === tc.size,
        `SHA-256 incremental coincide para ${tc.label} (bloque ${step} B)`
      );
    }
  }

  // Trozos irregulares aleatorios + hashBlobIncremental
  {
    const sample = makePatternBytes(350_113, 991);
    const expected = await subtleSha256Hex(sample);
    const hasher = new IncrementalSha256();
    const irregularSizes = [1, 3, 17, 64, 127, 4099, 65537, 131071];
    let offset = 0;
    let idx = 0;
    while (offset < sample.byteLength) {
      const len = irregularSizes[idx % irregularSizes.length];
      hasher.update(sample.subarray(offset, Math.min(offset + len, sample.byteLength)));
      offset += len;
      idx++;
    }
    assert(hasher.digestHex() === expected, 'SHA-256 incremental coincide con bloques irregulares');

    if (typeof Blob !== 'undefined') {
      const blob = new Blob([
        sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength) as ArrayBuffer
      ]);
      const blobHex = await hashBlobIncremental(blob, 64 * 1024);
      assert(blobHex === expected, 'hashBlobIncremental(Blob) coincide con crypto.subtle.digest');
    }
  }

  // ------------------------------------------------------------------
  // 2. Cifrado binario E2EE independiente + compatibilidad mensajería texto
  // ------------------------------------------------------------------
  console.log('\n--- 2. Cifrado binario E2EE (encryptE2EEBytes / decryptE2EEBytes) ---');
  const coreKeys = await generateDeviceCryptoMaterial('CORE');
  const movKeys = await generateDeviceCryptoMaterial('TERMINAL');
  const linkId = 'LNK-STAGE1-E2EE-001';

  const coreSessionKey = await deriveSharedE2EESessionKey({
    localPrivateEcdhKey: coreKeys.ecdhKeyPair.privateKey,
    peerPublicKeySpkiBase64: movKeys.publicKeySpkiBase64,
    linkId,
    coreDeviceId: coreKeys.deviceId,
    terminalDeviceId: movKeys.deviceId
  });
  const movSessionKey = await deriveSharedE2EESessionKey({
    localPrivateEcdhKey: movKeys.ecdhKeyPair.privateKey,
    peerPublicKeySpkiBase64: coreKeys.publicKeySpkiBase64,
    linkId,
    coreDeviceId: coreKeys.deviceId,
    terminalDeviceId: movKeys.deviceId
  });

  // 2a. Verificar que mensajería texto sigue intacta
  const textMeta = {
    sessionId: linkId,
    senderId: movKeys.deviceId,
    recipientId: coreKeys.deviceId,
    operationId: 'OP-TEXT-001',
    timestamp: Date.now()
  };
  const encText = await encryptE2EEPayload(movSessionKey, 'Mensaje de texto intacto en Etapa 1', textMeta);
  const decText = await decryptE2EEPayload(coreSessionKey, encText.ivBase64, encText.ciphertextBase64, textMeta);
  assert(decText === 'Mensaje de texto intacto en Etapa 1', 'Mensajería texto E2EE intacta tras cambios');

  // 2b. Cifrado/descifrado binario 128 KB + Base64 y ArrayBuffer
  const rawChunk = makePatternBytes(128 * 1024, 555);
  const binMeta = {
    sessionId: linkId,
    senderId: movKeys.deviceId,
    recipientId: coreKeys.deviceId,
    operationId: 'OP-BIN-001',
    timestamp: Date.now(),
    fileId: 'FILE-E2EE-TEST-1',
    chunkIndex: 0,
    totalChunks: 4,
    purpose: 'FILE_CHUNK' as const
  };
  const encryptedBlock = await encryptE2EEBytes(movSessionKey, rawChunk, binMeta);
  assert(
    encryptedBlock.iv.length === 12 && encryptedBlock.ciphertext instanceof ArrayBuffer,
    'encryptE2EEBytes genera IV de 12 bytes y ciphertext ArrayBuffer'
  );
  const decFromRaw = await decryptE2EEBytes(coreSessionKey, encryptedBlock.iv, encryptedBlock.ciphertext, binMeta);
  const decFromB64 = await decryptE2EEBytes(
    coreSessionKey,
    encryptedBlock.ivBase64,
    encryptedBlock.ciphertextBase64,
    binMeta
  );
  assert(bytesEqual(decFromRaw, rawChunk) && bytesEqual(decFromB64, rawChunk), 'decryptE2EEBytes recupera 128 KB bit a bit');

  // 2c. Fallo AEAD+AAD al alterar 1 bit o metadata de bloque
  const tamperedCipher = new Uint8Array(encryptedBlock.ciphertext.slice(0));
  tamperedCipher[500] ^= 0x01;
  await assertRejects(
    () => decryptE2EEBytes(coreSessionKey, encryptedBlock.iv, tamperedCipher, binMeta),
    'decryptE2EEBytes rechaza ciphertext binario alterado (1 bit)'
  );
  await assertRejects(
    () => decryptE2EEBytes(coreSessionKey, encryptedBlock.iv, encryptedBlock.ciphertext, { ...binMeta, chunkIndex: 1 }),
    'decryptE2EEBytes rechaza AAD con chunkIndex alterado'
  );
  await assertRejects(
    () => decryptE2EEBytes(coreSessionKey, encryptedBlock.iv, encryptedBlock.ciphertext, { ...binMeta, fileId: 'OTRO-FILE' }),
    'decryptE2EEBytes rechaza AAD con fileId alterado'
  );

  // ------------------------------------------------------------------
  // 3. Migración segura IndexedDB v2 -> v3 + conservación de datos existentes
  // ------------------------------------------------------------------
  console.log('\n--- 3. Migración segura IndexedDB v2 -> v3 y preservación de almacenes ---');
  const prevIndexedDb = (globalThis as any).indexedDB;
  const prevIDBKeyRange = (globalThis as any).IDBKeyRange;
  const harness = createPersistentIndexedDbHarness();
  (globalThis as any).indexedDB = harness.factory;
  (globalThis as any).IDBKeyRange = harness.KeyRange;

  try {
    // 3a. Poblar VelLocalDB versión 2 auténtica (solo los 5 almacenes heredados de v2)
    resetLocalVaultKeyCache();
    await new Promise<void>((resolve, reject) => {
      const seedReq = indexedDB.open('VelLocalDB', 2);
      seedReq.onupgradeneeded = () => {
        const seedDb = seedReq.result;
        seedDb.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
        seedDb.createObjectStore(STORE_IDENTITY, { keyPath: 'id' });
        seedDb.createObjectStore(STORE_CONFIG, { keyPath: 'key' });
        seedDb.createObjectStore(STORE_AUTHORIZATIONS, { keyPath: 'authorizationId' });
        seedDb.createObjectStore(STORE_LINKS, { keyPath: 'linkId' });
      };
      seedReq.onsuccess = () => {
        seedReq.result.close();
        resolve();
      };
      seedReq.onerror = () => reject(seedReq.error);
    });

    const dbV2 = new VelDatabase('VelLocalDB', 2);
    const rawV2 = await dbV2.open();
    assert(rawV2.version === 2, 'Base previa creada inicialmente en versión 2');
    assert(
      !rawV2.objectStoreNames.contains(STORE_VAULT_FILES) &&
        !rawV2.objectStoreNames.contains(STORE_VAULT_CHUNKS),
      'Versión 2 no contiene aún vault_files ni vault_chunks'
    );

    const legacyIdentity: LocalDeviceIdentityRecord = {
      id: 'current',
      deviceId: coreKeys.deviceId,
      role: 'CORE',
      fingerprint: coreKeys.fingerprint,
      publicKeySpkiBase64: coreKeys.publicKeySpkiBase64,
      signingPublicKeySpkiBase64: coreKeys.signingPublicKeySpkiBase64,
      privateEcdhKey: coreKeys.ecdhKeyPair.privateKey,
      privateSigningKey: coreKeys.signingKeyPair.privateKey,
      firebaseAuthUid: 'uid-core-persistido-1',
      registrationStatus: 'paired',
      activeLinkId: linkId,
      pairedPeerDeviceId: movKeys.deviceId,
      lastServerError: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    };
    await dbV2.saveIdentity(legacyIdentity);

    const legacyAuth: AuthorizationRecord = {
      authorizationId: `AUTH-${linkId}`,
      linkId,
      coreDeviceId: coreKeys.deviceId,
      terminalDeviceId: movKeys.deviceId,
      coreAuthUid: 'uid-core-persistido-1',
      terminalAuthUid: 'uid-mov-persistido-1',
      status: 'active',
      permissions: ['RELAY_CONNECT', 'E2EE_SESSION'],
      grantedAt: '2026-01-01T00:00:00.000Z',
      revokedAt: null,
      revokedByDeviceId: null,
      lastActivityAt: '2026-01-01T00:00:00.000Z'
    };
    await dbV2.saveAuthorization(legacyAuth);

    const legacyLink: DeviceLinkRecord = {
      linkId,
      coreDeviceId: coreKeys.deviceId,
      terminalDeviceId: movKeys.deviceId,
      coreAuthUid: 'uid-core-persistido-1',
      terminalAuthUid: 'uid-mov-persistido-1',
      coreFingerprint: coreKeys.fingerprint,
      terminalFingerprint: movKeys.fingerprint,
      status: 'active',
      sasVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      activatedAt: '2026-01-01T00:00:00.000Z',
      revokedAt: null,
      revokedByDeviceId: null,
      revocationReason: null
    };
    await dbV2.saveLink(legacyLink);

    // Guardar nota cifrada con velOfflineSync sobre v2 (genera también local_vault_aes_key en device_config)
    // Temporalmente abrimos velDb? No, usamos harness via dbV2 -> guardamos clave y nota usando velOfflineSync solo tras abrir velDb?
    // Guardemos nota previa directamente con offlineSync simulando estado v2 antes del upgrade:
    const v2Key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt'
    ]);
    await dbV2.setConfig(LOCAL_VAULT_KEY_CONFIG, v2Key);
    const v2NoteIv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const v2NotePlain = JSON.stringify({ title: 'Nota histórica v2', content: 'Soberanía intacta' });
    const v2NoteCipher = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: v2NoteIv },
      v2Key,
      new TextEncoder().encode(v2NotePlain)
    );
    await dbV2.save({
      id: 'nota-v2-1',
      encryptedData: Buffer.from(v2NoteCipher).toString('base64'),
      iv: Buffer.from(v2NoteIv).toString('base64'),
      updatedAt: 1700000000000
    });

    await dbV2.close();

    // 3b. Abrir velDb real (versión 3): ejecuta migración v2 -> v3
    resetLocalVaultKeyCache();
    const migratedDb = await velDb.open();
    assert(migratedDb.version === VEL_DB_VERSION && VEL_DB_VERSION === 3, 'VelLocalDB migrada a versión 3');
    for (const storeName of [
      STORE_RECORDS,
      STORE_IDENTITY,
      STORE_CONFIG,
      STORE_AUTHORIZATIONS,
      STORE_LINKS,
      STORE_VAULT_FILES,
      STORE_VAULT_CHUNKS
    ]) {
      assert(migratedDb.objectStoreNames.contains(storeName), `Almacén presente tras migración: ${storeName}`);
    }

    // Verificar conservación exacta de datos heredados de v2
    const keptIdentity = await velDb.getIdentity();
    const keptAuth = await velDb.getAuthorization(`AUTH-${linkId}`);
    const keptLink = await velDb.getLink(linkId);
    const keptNote = await velOfflineSync.getLocal<{ title: string; content: string }>('nota-v2-1');
    const keptVaultKey = await velDb.getConfig<CryptoKey>(LOCAL_VAULT_KEY_CONFIG);
    assert(keptIdentity?.deviceId === coreKeys.deviceId && keptIdentity.role === 'CORE', 'Identidad CORE conservada tras v2->v3');
    assert(
      isPrivateKeyProtected(keptIdentity?.privateEcdhKey) && isPrivateKeyProtected(keptIdentity?.privateSigningKey),
      'Claves privadas no exportables conservadas intactas tras migración'
    );
    const testSig = await signTechnicalChallenge(keptIdentity!.privateSigningKey, 'VERIFICACION-MIGRACION-V3');
    assert(testSig.length > 20, 'Clave privada ECDSA sigue operativa tras migración v2->v3');
    assert(keptVaultKey?.type === 'secret' && keptVaultKey.extractable === false, 'local_vault_aes_key conservada no exportable');
    assert(keptAuth?.status === 'active' && keptLink?.sasVerified === true, 'Autorizaciones y vínculos intactos');
    assert(keptNote?.title === 'Nota histórica v2' && keptNote.content === 'Soberanía intacta', 'Nota cifrada v2 descifrada intacta');

    // 3c. Probar offlineSync con >200 KB (prueba de regresión contra RangeError del spread)
    const largeNoteBody = 'X'.repeat(240 * 1024);
    await velOfflineSync.saveLocal('nota-grande-sin-spread', { body: largeNoteBody });
    const largeNoteRead = await velOfflineSync.getLocal<{ body: string }>('nota-grande-sin-spread');
    assert(largeNoteRead?.body.length === 240 * 1024, 'velOfflineSync maneja >240 KB sin stack overflow de ...spread');

    // ------------------------------------------------------------------
    // 4. Guardar y recuperar buffers binarios de diferentes tamaños en CORE
    // ------------------------------------------------------------------
    console.log('\n--- 4. Bóveda binaria CORE: guardado, recuperación e integridad ---');
    const coreVault = new CoreFileVaultManager(velDb);
    const savedSizes = [
      { name: 'vacio.bin', mime: 'application/octet-stream', size: 0 },
      { name: 'un-byte.bin', mime: 'application/octet-stream', size: 1 },
      { name: 'sesenta-cinco.txt', mime: 'text/plain', size: 65 },
      { name: 'bloque-128kb.jpg', mime: 'image/jpeg', size: 128 * 1024 },
      { name: 'desalineado.pdf', mime: 'application/pdf', size: 500 * 1024 + 137 },
      { name: 'video-2mb.mp4', mime: 'video/mp4', size: 2 * 1024 * 1024 }
    ];

    const savedSummaries: Array<{ fileId: string; expected: Uint8Array; sha256: string }> = [];
    for (const spec of savedSizes) {
      const data = makePatternBytes(spec.size, spec.size + 77);
      const summary = await coreVault.saveBinaryFile({
        fileName: spec.name,
        mimeType: spec.mime,
        bytes: data,
        sourceDeviceId: movKeys.deviceId
      });
      assert(summary.status === 'ready' && summary.sizeBytes === spec.size, `Archivo guardado en bóveda CORE: ${spec.name}`);

      // Comprobar que cada bloque almacenado en vault_chunks usa ArrayBuffer real (no base64)
      const storedChunks = await velDb.getVaultChunksByFileId(summary.fileId);
      assert(
        storedChunks.length >= 1 &&
          storedChunks.every((c) => c.ciphertext instanceof ArrayBuffer && c.iv instanceof ArrayBuffer),
        `Bloques de ${spec.name} almacenados como ArrayBuffer puro`
      );

      const readBack = await coreVault.readFileBytes(summary.fileId);
      assert(
        bytesEqual(readBack.bytes, data) && readBack.metadata.fileName === spec.name,
        `Archivo recuperado y descifrado exactamente: ${spec.name}`
      );
      savedSummaries.push({ fileId: summary.fileId, expected: data, sha256: summary.sha256 });
    }

    const listed = await coreVault.listFiles();
    assert(listed.length === savedSizes.length, `listFiles() lista exactamente los ${savedSizes.length} archivos protegidos`);

    // ------------------------------------------------------------------
    // 5. Bloque alterado en bóveda no se descifra correctamente
    // ------------------------------------------------------------------
    console.log('\n--- 5. Detección de manipulación de bloques en bóveda CORE ---');
    const targetFileId = savedSummaries[4].fileId; // desalineado.pdf (4 bloques)
    const rawChunk0 = await velDb.getVaultChunk(`${targetFileId}:0`);
    assert(rawChunk0 !== null, 'Bloque 0 existe en vault_chunks antes de alteración');
    const originalCopy = {
      ...rawChunk0!,
      ciphertext: rawChunk0!.ciphertext.slice(0)
    };
    const tamperedBytes = new Uint8Array(rawChunk0!.ciphertext.slice(0));
    tamperedBytes[10] ^= 0xff;
    await velDb.putVaultChunk({
      ...rawChunk0!,
      ciphertext: tamperedBytes.buffer
    });

    await assertRejects(
      () => coreVault.readAndDecryptChunk(targetFileId, 0),
      'readAndDecryptChunk falla ante 1 byte alterado en vault_chunks'
    );
    await assertRejects(
      () => coreVault.readFileBytes(targetFileId),
      'readFileBytes falla inmediatamente ante bloque alterado'
    );

    // Restaurar bloque original para pruebas posteriores de persistencia
    await velDb.putVaultChunk(originalCopy);
    const restoredRead = await coreVault.readFileBytes(targetFileId);
    assert(bytesEqual(restoredRead.bytes, savedSummaries[4].expected), 'Archivo íntegro tras restaurar bloque válido');

    // ------------------------------------------------------------------
    // 6. Identidad MÓVIL (TERMINAL) NO puede escribir en la bóveda CORE
    // ------------------------------------------------------------------
    console.log('\n--- 6. Bloqueo estricto de escritura para rol MÓVIL (TERMINAL) ---');
    const dbMobile = new VelDatabase('VelLocalDB_MobileCheck', 3);
    await dbMobile.open();
    await dbMobile.saveIdentity({
      ...legacyIdentity,
      deviceId: movKeys.deviceId,
      role: 'TERMINAL',
      fingerprint: movKeys.fingerprint,
      publicKeySpkiBase64: movKeys.publicKeySpkiBase64,
      signingPublicKeySpkiBase64: movKeys.signingPublicKeySpkiBase64,
      privateEcdhKey: movKeys.ecdhKeyPair.privateKey,
      privateSigningKey: movKeys.signingKeyPair.privateKey
    });
    const mobileVault = new CoreFileVaultManager(dbMobile);

    await assertRejects(
      () =>
        mobileVault.saveBinaryFile({
          fileName: 'prohibido-movil.pdf',
          mimeType: 'application/pdf',
          bytes: makePatternBytes(1024, 3)
        }),
      'TERMINAL/MÓVIL rechazado en saveBinaryFile'
    );
    await assertRejects(
      () =>
        mobileVault.beginStagingFile({
          fileId: 'FILE-MOVIL-NO-DEBE-ESCRIBIR',
          fileName: 'prohibido.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: 128
        }),
      'TERMINAL/MÓVIL rechazado en beginStagingFile'
    );
    const mobileFiles = await dbMobile.getAllVaultFiles();
    assert(mobileFiles.length === 0, 'TERMINAL dejó exactamente 0 registros en vault_files');
    await dbMobile.close();

    // ------------------------------------------------------------------
    // 7. Simulación de error de escritura en IndexedDB
    // ------------------------------------------------------------------
    console.log('\n--- 7. Simulación de error de escritura y estado staging seguro ---');
    harness.setWriteFailure(
      STORE_VAULT_CHUNKS,
      2,
      Object.assign(new Error('QuotaExceededError: espacio simulado agotado'), { name: 'QuotaExceededError' })
    );
    await assertRejects(
      () =>
        coreVault.saveBinaryFile({
          fileId: 'FILE-WRITE-FAIL-01',
          fileName: 'fallo-escritura.bin',
          mimeType: 'application/octet-stream',
          bytes: makePatternBytes(300 * 1024, 88)
        }),
      'saveBinaryFile rechaza al fallar escritura en bloque #2'
    );
    harness.clearWriteFailure();

    const failedRecord = await velDb.getVaultFile('FILE-WRITE-FAIL-01');
    assert(
      failedRecord !== null && failedRecord.status === 'staging',
      'Archivo interrumpido nunca se promueve a ready (queda en staging)'
    );
    await assertRejects(
      () => coreVault.commitStagingFile({ fileId: 'FILE-WRITE-FAIL-01' }),
      'commitStagingFile rechaza confirmar archivo con bloques faltantes'
    );

    // ------------------------------------------------------------------
    // 8. Staging activo vs abandonado (limpieza segura) + borrado con integridad
    // ------------------------------------------------------------------
    console.log('\n--- 8. Limpieza de staging (no borra activas) y borrado con control de integridad ---');
    // Crear archivo staging ACTIVO y otro ABANDONADO
    await coreVault.beginStagingFile({
      fileId: 'FILE-STAGING-ACTIVE',
      fileName: 'activa.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: 100,
      markActive: true
    });
    await coreVault.beginStagingFile({
      fileId: 'FILE-STAGING-ABANDONED',
      fileName: 'abandonada.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: 100,
      markActive: false
    });
    const abandonedMeta = await velDb.getVaultFile('FILE-STAGING-ABANDONED');
    await velDb.putVaultFile({
      ...abandonedMeta!,
      lastChunkAt: Date.now() - 60 * 60 * 1000 // hace 1 hora
    });

    const cleanupRes = await coreVault.cleanupAbandonedStaging(15 * 60 * 1000);
    assert(
      cleanupRes.deletedFileIds.includes('FILE-STAGING-ABANDONED') &&
        !cleanupRes.deletedFileIds.includes('FILE-STAGING-ACTIVE') &&
        cleanupRes.skippedActiveFileIds.includes('FILE-STAGING-ACTIVE') &&
        cleanupRes.deletedFileIds.includes('FILE-WRITE-FAIL-01') === false,
      'Limpieza staging elimina solo abandonadas y respeta transferencia activa y staging reciente'
    );
    assert((await velDb.getVaultFile('FILE-STAGING-ACTIVE')) !== null, 'Transferencia activa sigue intacta');
    assert((await velDb.getVaultFile('FILE-STAGING-ABANDONED')) === null, 'Transferencia abandonada eliminada');

    // Limpiar el staging de la prueba anterior y probar deleteFile con control de integridad
    coreVault.markTransferInactive('FILE-STAGING-ACTIVE');
    const delActive = await coreVault.deleteFile('FILE-STAGING-ACTIVE');
    const delWriteFail = await coreVault.deleteFile('FILE-WRITE-FAIL-01');
    assert(
      delActive.deleted && delActive.integrityVerified && delWriteFail.deleted && delWriteFail.integrityVerified,
      'deleteFile elimina metadatos y bloques verificando integridad post-borrado'
    );

    // ------------------------------------------------------------------
    // 9. Cerrar y reabrir la base de datos y comprobar persistencia total
    // ------------------------------------------------------------------
    console.log('\n--- 9. Cierre y reapertura de base de datos + verificación integridad total ---');
    await velDb.close();
    resetLocalVaultKeyCache();

    const reopenedDb = new VelDatabase('VelLocalDB', VEL_DB_VERSION);
    await reopenedDb.open();
    const reopenedVault = new CoreFileVaultManager(reopenedDb);

    // Verificar todos los archivos binarios tras cerrar y reabrir
    const reopenedFiles = await reopenedVault.listFiles();
    assert(reopenedFiles.length === savedSummaries.length, 'Todos los archivos persisten tras cerrar y reabrir DB');
    for (const saved of savedSummaries) {
      const readAfterReopen = await reopenedVault.readFileBytes(saved.fileId);
      assert(
        bytesEqual(readAfterReopen.bytes, saved.expected) && readAfterReopen.metadata.sha256 === saved.sha256,
        `Persistencia binaria e integridad SHA-256 intacta tras reopen (${readAfterReopen.metadata.fileName})`
      );
    }

    // Verificar notas, identidad, claves y autorización tras cerrar y reabrir
    const reopenedIdentity = await reopenedDb.getIdentity();
    const reopenedNote = await velOfflineSync.getLocal<{ title: string; content: string }>('nota-v2-1');
    const reopenedAuth = await reopenedDb.getAuthorization(`AUTH-${linkId}`);
    const reopenedLink = await reopenedDb.getLink(linkId);
    assert(reopenedIdentity?.deviceId === coreKeys.deviceId, 'Identidad CORE intacta tras close/reopen');
    assert(
      isPrivateKeyProtected(reopenedIdentity?.privateEcdhKey) &&
        isPrivateKeyProtected(reopenedIdentity?.privateSigningKey),
      'Claves privadas protegidas intactas tras close/reopen'
    );
    assert(reopenedNote?.title === 'Nota histórica v2', 'Notas cifradas previas intactas tras close/reopen');
    assert(reopenedAuth?.status === 'active' && reopenedLink?.status === 'active', 'Vínculo y autorización intactos');

    // Probar borrado limpio de uno de los archivos persistidos
    const deletedVideo = await reopenedVault.deleteFile(savedSummaries[5].fileId);
    assert(
      deletedVideo.deleted && deletedVideo.deletedChunks === 16 && deletedVideo.integrityVerified,
      'Eliminación íntegra de video de 2 MB (16 bloques de 128 KB) confirmada'
    );
    assert((await reopenedVault.listFiles()).length === savedSummaries.length - 1, 'Conteo actualizado tras borrado');

    // Probar helpers navigator.storage.persist() y estimate() sin asumir concesión
    const persistNoApi = await requestCorePersistentStorage();
    const estNoApi = await getCoreStorageEstimate();
    assert(persistNoApi.supported === false && persistNoApi.persisted === false, 'requestCorePersistentStorage maneja ausencia de navigator.storage');
    assert(estNoApi.supported === false && estNoApi.availableBytes === null, 'getCoreStorageEstimate maneja ausencia de navigator.storage');

    // Simular navigator.storage con persist=false y estimate insuficiente
    const prevNavigator = (globalThis as any).navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        storage: {
          persisted: async () => false,
          persist: async () => false,
          estimate: async () => ({ usage: 990_000, quota: 1_000_000 })
        }
      }
    });
    const persistDenied = await requestCorePersistentStorage();
    assert(persistDenied.supported === true && persistDenied.persisted === false, 'No asume que persist() fue concedida');
    await assertRejects(
      () =>
        reopenedVault.beginStagingFile({
          fileId: 'FILE-EXCEEDS-QUOTA',
          fileName: 'demasiado-grande.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: 50_000
        }),
      'beginStagingFile detecta cuota insuficiente vía navigator.storage.estimate()'
    );
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: prevNavigator });

    // Error de apertura / migración simulado (versión solicitada menor que existente)
    const downgradeDb = new VelDatabase('VelLocalDB', 1);
    await assertRejects(() => downgradeDb.open(), 'VelDatabase maneja y propaga error de apertura/versión');

    await reopenedDb.close();
  } finally {
    await velDb.close();
    (globalThis as any).indexedDB = prevIndexedDb;
    (globalThis as any).IDBKeyRange = prevIDBKeyRange;
  }

  console.log('\n========================================================================');
  console.log(`RESUMEN PRUEBAS ETAPA 1 (CORE BINARY VAULT): ${passed} PASS / ${failed} FAIL`);
  console.log('========================================================================');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

runTests().catch((err) => {
  console.error('Error fatal en test-stage1-core-vault:', err);
  process.exit(1);
});
