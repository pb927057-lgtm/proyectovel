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

const STORE_RECORDS = 'records';
const STORE_IDENTITY = 'device_identity';
const STORE_CONFIG = 'device_config';
const STORE_AUTHORIZATIONS = 'authorizations_cache';
const STORE_LINKS = 'links_cache';

class VelDatabase implements VelStorageAdapter {
  private dbName = 'VelLocalDB';
  private storeName = STORE_RECORDS;
  private dbVersion = 2;

  async open(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB no está disponible en este entorno.');
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
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
      };
    });
  }

  private async putInStore(storeName: string, value: unknown): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || request.error);
      request.onerror = () => reject(request.error);
    });
  }

  private async getFromStore<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve((request.result as T) ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  private async deleteFromStore(storeName: string, key: IDBValidKey): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || request.error);
      request.onerror = () => reject(request.error);
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
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
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
}

export const velDb = new VelDatabase();
