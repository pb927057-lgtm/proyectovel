// src/db/offlineSync.ts
import { velDb, VelLocalRecord } from './db';

/**
 * Gestor de almacenamiento local cifrado en reposo para VEL CORE.
 * Garantiza la soberanía local de los datos sin utilizar localStorage para claves ni datos personales.
 */

const LOCAL_VAULT_KEY_CONFIG = 'local_vault_aes_key';
let cachedCryptoKey: CryptoKey | null = null;

async function getOrCreateLocalKey(): Promise<CryptoKey> {
  if (cachedCryptoKey) return cachedCryptoKey;

  const existingKey = await velDb.getConfig<CryptoKey>(LOCAL_VAULT_KEY_CONFIG);
  if (existingKey && existingKey.type === 'secret') {
    cachedCryptoKey = existingKey;
    return existingKey;
  }

  // Clave AES-256-GCM generada con Web Crypto API como CryptoKey NO exportable
  // y persistida directamente en IndexedDB (sin localStorage).
  const generatedKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  await velDb.setConfig(LOCAL_VAULT_KEY_CONFIG, generatedKey);
  cachedCryptoKey = generatedKey;
  return generatedKey;
}

export class VelOfflineSyncManager {
  /**
   * Guarda un registro cifrado localmente en IndexedDB respetando la soberanía de datos.
   */
  async saveLocal(id: string, data: object | string): Promise<VelLocalRecord> {
    const key = await getOrCreateLocalKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      encoded as BufferSource
    );

    const ciphertextBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer)));
    const ivBase64 = btoa(String.fromCharCode(...iv));

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
      const key = await getOrCreateLocalKey();
      const iv = Uint8Array.from(atob(record.iv), c => c.charCodeAt(0));
      const ciphertext = Uint8Array.from(atob(record.encryptedData), c => c.charCodeAt(0));

      const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        ciphertext as BufferSource
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
