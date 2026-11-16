// src/db/db.ts
import {
  AuthorizationRecord,
  DeviceLinkRecord,
  LocalDeviceIdentityRecord
} from '../contracts/velContracts';

export interface VelLocalRecord {
  id: string;
  encryptedData: string; // Datos cifrados (Soberanía local)
  iv: string;            // Vector de inicialización para AES
  updatedAt: number;
}

export interface VelDeviceConfigEntry {
  key: string;
  value: unknown;
  updatedAt: number;
}

export type VaultFileStatus = 'staging' | 'ready';

export interface VaultFileRecord {
  fileId: string;
  encryptedMeta: ArrayBuffer;
  metaIv: ArrayBuffer;
  sizeBytes: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number;
  sha256: string;
  status: VaultFileStatus;
  sourceDeviceId?: string;
  lastChunkAt: number;
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number;
}

export interface VaultChunkRecord {
  chunkKey: string; // `${fileId}:${chunkIndex}`
  fileId: string;
  chunkIndex: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  plainByteLength: number;
  updatedAt: number;
}

export interface VelStorageAdapter {
  getIdentity(): Promise<LocalDeviceIdentityRecord | null>;
  saveIdentity(identity: LocalDeviceIdentityRecord): Promise<void>;
  clearIdentity(): Promise<void>;
  getConfig<T = unknown>(key: string): Promise<T | null>;
  setConfig(key: string, value: unknown): Promise<void>;
  deleteConfig(key: string): Promise<void>;
  getAuthorization(authorizationId: string): Promise<AuthorizationRecord | null>;
  saveAuthorization(record: AuthorizationRecord): Promise<void>;
  getLink(linkId: string): Promise<DeviceLinkRecord | null>;
  saveLink(record: DeviceLinkRecord): Promise<void>;
}

export interface VelCoreVaultStorageAdapter extends VelStorageAdapter {
  putVaultFile(record: VaultFileRecord): Promise<void>;
  getVaultFile(fileId: string): Promise<VaultFileRecord | null>;
  getAllVaultFiles(): Promise<VaultFileRecord[]>;
  deleteVaultFile(fileId: string): Promise<void>;
  putVaultChunk(record: VaultChunkRecord): Promise<void>;
  getVaultChunk(chunkKey: string): Promise<VaultChunkRecord | null>;
  getVaultChunksByFileId(fileId: string): Promise<VaultChunkRecord[]>;
  deleteVaultFileAndChunks(fileId: string): Promise<number>;
  close(): Promise<void>;
}

export const STORE_RECORDS = 'records';
export const STORE_IDENTITY = 'device_identity';
export const STORE_CONFIG = 'device_config';
export const STORE_AUTHORIZATIONS = 'authorizations_cache';
export const STORE_LINKS = 'links_cache';
export const STORE_VAULT_FILES = 'vault_files';
export const STORE_VAULT_CHUNKS = 'vault_chunks';
export const VEL_DB_VERSION = 3;

export class VelDatabase implements VelCoreVaultStorageAdapter {
  private dbName: string;
  private storeName = STORE_RECORDS;
  private dbVersion: number;
  private activeDb: IDBDatabase | null = null;
  private openingPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName = 'VelLocalDB', dbVersion = VEL_DB_VERSION) {
    this.dbName = dbName;
    this.dbVersion = dbVersion;
  }

  getDbName(): string {
    return this.dbName;
  }

  getDbVersion(): number {
    return this.dbVersion;
  }

  async open(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB no está disponible en este entorno.');
    }

    if (this.activeDb) {
      return this.activeDb;
    }

    if (this.openingPromise) {
      return this.openingPromise;
    }

    this.openingPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      let blockedTimer: ReturnType<typeof setTimeout> | null = null;

      const clearTimers = () => {
        if (blockedTimer !== null) {
          clearTimeout(blockedTimer);
          blockedTimer = null;
        }
      };

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimers();
        this.openingPromise = null;
        reject(err instanceof Error ? err : new Error(String(err || 'Error al abrir IndexedDB.')));
      };

      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(this.dbName, this.dbVersion);
      } catch (err) {
        fail(err);
        return;
      }

      request.onerror = () => {
        fail(request.error || new Error(`No se pudo abrir ${this.dbName} v${this.dbVersion}.`));
      };

      request.onblocked = () => {
        if (this.activeDb) {
          try {
            this.activeDb.close();
          } catch {
            // Ignorar cierre defensivo
          }
          this.activeDb = null;
        }
        if (blockedTimer === null) {
          blockedTimer = setTimeout(() => {
            fail(
              new Error(
                `La apertura/migración de ${this.dbName} v${this.dbVersion} fue bloqueada por otra conexión abierta.`
              )
            );
          }, 750);
        }
      };

      request.onupgradeneeded = (event) => {
        const upgradeRequest = event.target as IDBOpenDBRequest;
        const db = upgradeRequest.result;
        const upgradeTx = upgradeRequest.transaction;

        if (upgradeTx) {
          upgradeTx.onerror = () => {
            fail(upgradeTx.error || new Error(`Error durante la migración de ${this.dbName}.`));
          };
          upgradeTx.onabort = () => {
            fail(upgradeTx.error || new Error(`Migración de ${this.dbName} abortada.`));
          };
        }

        try {
          // Conservar íntegramente los 5 almacenes existentes (v1/v2) sin borrar ni recrear
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
            db.createObjectStore(STORE_IDENTITY, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_CONFIG)) {
            db.createObjectStore(STORE_CONFIG, { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains(STORE_AUTHORIZATIONS)) {
            db.createObjectStore(STORE_AUTHORIZATIONS, { keyPath: 'authorizationId' });
          }
          if (!db.objectStoreNames.contains(STORE_LINKS)) {
            db.createObjectStore(STORE_LINKS, { keyPath: 'linkId' });
          }

          // Migración v2 -> v3: almacenes exclusivos para bóveda binaria cifrada CORE
          if (!db.objectStoreNames.contains(STORE_VAULT_FILES)) {
            const filesStore = db.createObjectStore(STORE_VAULT_FILES, { keyPath: 'fileId' });
            filesStore.createIndex('by_status', 'status', { unique: false });
            filesStore.createIndex('by_createdAt', 'createdAt', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_VAULT_CHUNKS)) {
            const chunksStore = db.createObjectStore(STORE_VAULT_CHUNKS, { keyPath: 'chunkKey' });
            chunksStore.createIndex('by_fileId', 'fileId', { unique: false });
          }
        } catch (upgradeErr) {
          try {
            upgradeTx?.abort();
          } catch {
            // Ignorar abort secundario
          }
          fail(upgradeErr);
        }
      };

      request.onsuccess = () => {
        if (settled) {
          try {
            request.result.close();
          } catch {
            // Ignorar
          }
          return;
        }
        settled = true;
        clearTimers();

        const db = request.result;
        this.activeDb = db;
        this.openingPromise = null;

        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            // Ignorar
          }
          if (this.activeDb === db) {
            this.activeDb = null;
          }
        };

        db.onclose = () => {
          if (this.activeDb === db) {
            this.activeDb = null;
          }
        };

        resolve(db);
      };
    });

    return this.openingPromise;
  }

  async close(): Promise<void> {
    if (this.openingPromise) {
      try {
        await this.openingPromise;
      } catch {
        // Ignorar si falló la apertura
      }
    }
    if (this.activeDb) {
      const db = this.activeDb;
      this.activeDb = null;
      try {
        db.close();
      } catch {
        // Ignorar cierre defensivo
      }
    }
  }

  private async putInStore(storeName: string, value: unknown): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err || 'Error en escritura IndexedDB.')));
      };

      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(value);

      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      transaction.onerror = () => fail(transaction.error || request.error);
      transaction.onabort = () => fail(transaction.error || request.error || new Error('Transacción abortada.'));
      request.onerror = () => fail(request.error);
    });
  }

  private async getFromStore<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err || 'Error en lectura IndexedDB.')));
      };

      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        resolve((request.result as T) ?? null);
      };
      request.onerror = () => fail(request.error);
      transaction.onerror = () => fail(transaction.error || request.error);
      transaction.onabort = () => fail(transaction.error || new Error('Transacción de lectura abortada.'));
    });
  }

  private async getAllFromStore<T>(storeName: string): Promise<T[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err || 'Error al listar IndexedDB.')));
      };

      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        resolve((request.result as T[]) || []);
      };
      request.onerror = () => fail(request.error);
      transaction.onerror = () => fail(transaction.error || request.error);
      transaction.onabort = () => fail(transaction.error || new Error('Transacción de lectura abortada.'));
    });
  }

  private async deleteFromStore(storeName: string, key: IDBValidKey): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err || 'Error al eliminar en IndexedDB.')));
      };

      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);

      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      transaction.onerror = () => fail(transaction.error || request.error);
      transaction.onabort = () => fail(transaction.error || request.error || new Error('Transacción abortada.'));
      request.onerror = () => fail(request.error);
    });
  }

  // --- Operaciones de registros cifrados (Soberanía CORE) ---

  async save(record: VelLocalRecord): Promise<void> {
    await this.putInStore(this.storeName, record);
  }

  async get(id: string): Promise<VelLocalRecord | undefined> {
    const res = await this.getFromStore<VelLocalRecord>(this.storeName, id);
    return res ?? undefined;
  }

  async remove(id: string): Promise<void> {
    await this.deleteFromStore(this.storeName, id);
  }

  async getAll(): Promise<VelLocalRecord[]> {
    return this.getAllFromStore<VelLocalRecord>(this.storeName);
  }

  async count(): Promise<number> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.count();

      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => reject(request.error);
    });
  }

  // --- Persistencia técnica local del dispositivo (Identidad + Claves CryptoKey no exportables) ---

  async getIdentity(): Promise<LocalDeviceIdentityRecord | null> {
    return this.getFromStore<LocalDeviceIdentityRecord>(STORE_IDENTITY, 'current');
  }

  async saveIdentity(identity: LocalDeviceIdentityRecord): Promise<void> {
    await this.putInStore(STORE_IDENTITY, identity);
  }

  async clearIdentity(): Promise<void> {
    await this.deleteFromStore(STORE_IDENTITY, 'current');
  }

  async getConfig<T = unknown>(key: string): Promise<T | null> {
    const entry = await this.getFromStore<VelDeviceConfigEntry>(STORE_CONFIG, key);
    return entry ? (entry.value as T) : null;
  }

  async setConfig(key: string, value: unknown): Promise<void> {
    await this.putInStore(STORE_CONFIG, {
      key,
      value,
      updatedAt: Date.now()
    } satisfies VelDeviceConfigEntry);
  }

  async deleteConfig(key: string): Promise<void> {
    await this.deleteFromStore(STORE_CONFIG, key);
  }

  async getAuthorization(authorizationId: string): Promise<AuthorizationRecord | null> {
    return this.getFromStore<AuthorizationRecord>(STORE_AUTHORIZATIONS, authorizationId);
  }

  async saveAuthorization(record: AuthorizationRecord): Promise<void> {
    await this.putInStore(STORE_AUTHORIZATIONS, record);
  }

  async getLink(linkId: string): Promise<DeviceLinkRecord | null> {
    return this.getFromStore<DeviceLinkRecord>(STORE_LINKS, linkId);
  }

  async saveLink(record: DeviceLinkRecord): Promise<void> {
    await this.putInStore(STORE_LINKS, record);
  }

  // --- Operaciones de bóveda binaria CORE (IndexedDB v3: vault_files y vault_chunks) ---

  async putVaultFile(record: VaultFileRecord): Promise<void> {
    await this.putInStore(STORE_VAULT_FILES, record);
  }

  async getVaultFile(fileId: string): Promise<VaultFileRecord | null> {
    return this.getFromStore<VaultFileRecord>(STORE_VAULT_FILES, fileId);
  }

  async getAllVaultFiles(): Promise<VaultFileRecord[]> {
    return this.getAllFromStore<VaultFileRecord>(STORE_VAULT_FILES);
  }

  async deleteVaultFile(fileId: string): Promise<void> {
    await this.deleteFromStore(STORE_VAULT_FILES, fileId);
  }

  async putVaultChunk(record: VaultChunkRecord): Promise<void> {
    await this.putInStore(STORE_VAULT_CHUNKS, record);
  }

  async getVaultChunk(chunkKey: string): Promise<VaultChunkRecord | null> {
    return this.getFromStore<VaultChunkRecord>(STORE_VAULT_CHUNKS, chunkKey);
  }

  async getVaultChunksByFileId(fileId: string): Promise<VaultChunkRecord[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err || 'Error al leer bloques de bóveda.')));
      };

      const transaction = db.transaction(STORE_VAULT_CHUNKS, 'readonly');
      const store = transaction.objectStore(STORE_VAULT_CHUNKS);
      const index = store.index('by_fileId');
      const request = index.getAll(IDBKeyRange.only(fileId));

      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        const rows = ((request.result as VaultChunkRecord[]) || []).slice();
        rows.sort((a, b) => a.chunkIndex - b.chunkIndex);
        resolve(rows);
      };
      request.onerror = () => fail(request.error);
      transaction.onerror = () => fail(transaction.error || request.error);
      transaction.onabort = () => fail(transaction.error || new Error('Transacción de lectura abortada.'));
    });
  }

  async deleteVaultFileAndChunks(fileId: string): Promise<number> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let deletedChunks = 0;

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err || 'Error al eliminar archivo de bóveda.')));
      };

      const transaction = db.transaction([STORE_VAULT_FILES, STORE_VAULT_CHUNKS], 'readwrite');
      const filesStore = transaction.objectStore(STORE_VAULT_FILES);
      const chunksStore = transaction.objectStore(STORE_VAULT_CHUNKS);
      const byFileIndex = chunksStore.index('by_fileId');

      const fileDeleteReq = filesStore.delete(fileId);
      fileDeleteReq.onerror = () => fail(fileDeleteReq.error);

      const cursorReq = byFileIndex.openCursor(IDBKeyRange.only(fileId));
      cursorReq.onerror = () => fail(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          return;
        }
        const delReq = cursor.delete();
        delReq.onerror = () => fail(delReq.error);
        deletedChunks++;
        cursor.continue();
      };

      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(deletedChunks);
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => fail(transaction.error || new Error('Transacción de borrado abortada.'));
    });
  }
}

export const velDb = new VelDatabase();
