// src/db/offlineSync.ts
import { arrayBufferToBase64, base64ToUint8Array } from '../crypto/deviceCrypto';
import { toExactArrayBuffer } from '../crypto/fileHash';
import { velDb, VelLocalRecord, VelStorageAdapter } from './db';

/**
 * Gestor de almacenamiento local cifrado en reposo para VEL CORE.
 * Garantiza la soberanía local de los datos sin utilizar localStorage para claves ni datos personales.
 */

export const LOCAL_VAULT_KEY_CONFIG = 'local_vault_aes_key';
let cachedCryptoKey: CryptoKey | null = null;

export function resetLocalVaultKeyCache(): void {
  cachedCryptoKey = null;
}

export async function getOrCreateLocalVaultKey(
  storage: Pick<VelStorageAdapter, 'getConfig' | 'setConfig'> = velDb
): Promise<CryptoKey> {
  const useSharedCache = storage === velDb;
  if (useSharedCache && cachedCryptoKey) {
    return cachedCryptoKey;
  }

  const existingKey = await storage.getConfig<CryptoKey>(LOCAL_VAULT_KEY_CONFIG);
  if (existingKey && existingKey.type === 'secret') {
    if (useSharedCache) {
      cachedCryptoKey = existingKey;
    }
    return existingKey;
  }

  // Clave AES-256-GCM generada con Web Crypto API como CryptoKey NO exportable
  // y persistida directamente en IndexedDB (sin localStorage).
  const generatedKey = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  await storage.setConfig(LOCAL_VAULT_KEY_CONFIG, generatedKey);
  if (useSharedCache) {
    cachedCryptoKey = generatedKey;
  }
  return generatedKey;
}

export class VelOfflineSyncManager {
  /**
   * Guarda un registro cifrado localmente en IndexedDB respetando la soberanía de datos.
   */
  async saveLocal(id: string, data: object | string): Promise<VelLocalRecord> {
    const key = await getOrCreateLocalVaultKey(velDb);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertextBuffer = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      encoded as BufferSource
    );

    const ciphertextBase64 = arrayBufferToBase64(ciphertextBuffer);
    const ivBase64 = arrayBufferToBase64(toExactArrayBuffer(iv));

    const record: VelLocalRecord = {
      id,
      encryptedData: ciphertextBase64,
      iv: ivBase64,
      updatedAt: Date.now()
    };

    await velDb.save(record);
    return record;
  }

  /**
   * Lee y descifra un registro de la base de datos local.
   */
  async getLocal<T = any>(id: string): Promise<T | null> {
    const record = await velDb.get(id);
    if (!record) return null;

    try {
      const key = await getOrCreateLocalVaultKey(velDb);
      const iv = base64ToUint8Array(record.iv);
      const ciphertext = base64ToUint8Array(record.encryptedData);

      const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toExactArrayBuffer(iv) as BufferSource },
        key,
        toExactArrayBuffer(ciphertext) as BufferSource
      );

      const text = new TextDecoder().decode(decryptedBuffer);
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } catch (err) {
      console.error('Error al descifrar registro local:', err);
      return null;
    }
  }

  /**
   * Obtiene todos los registros locales (metadatos cifrados).
   */
  async getAllRecords(): Promise<VelLocalRecord[]> {
    return await velDb.getAll();
  }

  /**
   * Elimina un registro local.
   */
  async removeRecord(id: string): Promise<void> {
    await velDb.remove(id);
  }

  /**
   * Cuenta total de registros locales.
   */
  async count(): Promise<number> {
    return await velDb.count();
  }
}

export const velOfflineSync = new VelOfflineSyncManager();
