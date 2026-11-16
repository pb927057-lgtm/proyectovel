import { LocalDeviceIdentityRecord } from '../contracts/velContracts';
import { IncrementalSha256, toExactArrayBuffer, toUint8Array } from '../crypto/fileHash';
import {
  VaultChunkRecord,
  VaultFileRecord,
  VaultFileStatus,
  VelCoreVaultStorageAdapter,
  velDb
} from './db';
import { getOrCreateLocalVaultKey } from './offlineSync';

export const DEFAULT_VAULT_CHUNK_SIZE = 128 * 1024; // 128 KB
export const DEFAULT_STAGING_ABANDON_MS = 15 * 60 * 1000; // 15 minutos sin actividad
export const MAX_PRACTICAL_VAULT_FILE_BYTES = 100 * 1024 * 1024; // 100 MB límite práctico inicial

export interface CoreVaultFileMetadataPlain {
  fileName: string;
  mimeType: string;
}

export interface CoreVaultFileSummary {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number;
  sha256: string;
  status: VaultFileStatus;
  sourceDeviceId?: string;
  isActiveTransfer: boolean;
  lastChunkAt: number;
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number;
}

export interface StoragePersistenceReport {
  supported: boolean;
  alreadyPersisted: boolean;
  persisted: boolean;
}

export interface StorageEstimateReport {
  supported: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
  availableBytes: number | null;
}

export interface BeginStagingFileInput {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  chunkSize?: number;
  totalChunks?: number;
  expectedSha256?: string;
  sourceDeviceId?: string;
  markActive?: boolean;
}

export interface SaveBinaryFileInput {
  fileId?: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array | ArrayBuffer;
  chunkSize?: number;
  sourceDeviceId?: string;
  cleanupStagingOnFailure?: boolean;
}

export interface DeleteVaultFileResult {
  deleted: boolean;
  deletedChunks: number;
  integrityVerified: boolean;
}

export interface CleanupStagingResult {
  inspectedStagingCount: number;
  deletedFileIds: string[];
  skippedActiveFileIds: string[];
  deletedChunksCount: number;
}

function getWebCryptoSubtle(): SubtleCrypto {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || !cryptoObj.subtle || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('Web Crypto API (SubtleCrypto) no está disponible en este entorno.');
  }
  return cryptoObj.subtle;
}

function generateVaultFileId(): string {
  const randomBytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(randomBytes);
  let hex = '';
  for (let i = 0; i < randomBytes.length; i++) {
    hex += randomBytes[i].toString(16).padStart(2, '0').toUpperCase();
  }
  return `FILE-${hex}`;
}

function buildVaultChunkAad(fileId: string, chunkIndex: number): ArrayBuffer {
  const encoded = new TextEncoder().encode(`VEL-CORE-VAULT-CHUNK-v1|${fileId}|${chunkIndex}`);
  return toExactArrayBuffer(encoded);
}

function buildVaultMetaAad(fileId: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(`VEL-CORE-VAULT-META-v1|${fileId}`);
  return toExactArrayBuffer(encoded);
}

export function buildVaultChunkKey(fileId: string, chunkIndex: number): string {
  return `${fileId}:${chunkIndex}`;
}

export async function requestCorePersistentStorage(): Promise<StoragePersistenceReport> {
  const storageApi = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storageApi || typeof storageApi.persist !== 'function') {
    return { supported: false, alreadyPersisted: false, persisted: false };
  }

  let alreadyPersisted = false;
  try {
    if (typeof storageApi.persisted === 'function') {
      alreadyPersisted = await storageApi.persisted();
    }
  } catch {
    alreadyPersisted = false;
  }

  if (alreadyPersisted) {
    return { supported: true, alreadyPersisted: true, persisted: true };
  }

  try {
    const granted = await storageApi.persist();
    return { supported: true, alreadyPersisted: false, persisted: Boolean(granted) };
  } catch {
    return { supported: true, alreadyPersisted: false, persisted: false };
  }
}

export async function getCoreStorageEstimate(): Promise<StorageEstimateReport> {
  const storageApi = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storageApi || typeof storageApi.estimate !== 'function') {
    return { supported: false, usageBytes: null, quotaBytes: null, availableBytes: null };
  }

  try {
    const estimate = await storageApi.estimate();
    const usageBytes = typeof estimate.usage === 'number' ? estimate.usage : null;
    const quotaBytes = typeof estimate.quota === 'number' ? estimate.quota : null;
    const availableBytes =
      usageBytes !== null && quotaBytes !== null ? Math.max(0, quotaBytes - usageBytes) : null;
    return {
      supported: true,
      usageBytes,
      quotaBytes,
      availableBytes
    };
  } catch {
    return { supported: false, usageBytes: null, quotaBytes: null, availableBytes: null };
  }
}

export class CoreFileVaultManager {
  private storage: VelCoreVaultStorageAdapter;
  private activeTransfers = new Set<string>();
  private writeLocks = new Map<string, Promise<unknown>>();

  constructor(storage: VelCoreVaultStorageAdapter = velDb) {
    this.storage = storage;
  }

  private async runSerializedForFile<T>(fileId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(fileId) || Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.writeLocks.set(fileId, tail);
    try {
      return await run;
    } finally {
      if (this.writeLocks.get(fileId) === tail) {
        this.writeLocks.delete(fileId);
      }
    }
  }

  markTransferActive(fileId: string): void {
    if (fileId?.trim()) {
      this.activeTransfers.add(fileId);
    }
  }

  markTransferInactive(fileId: string): void {
    this.activeTransfers.delete(fileId);
  }

  isTransferActive(fileId: string): boolean {
    return this.activeTransfers.has(fileId);
  }

  private async assertCoreRoleForWrite(): Promise<LocalDeviceIdentityRecord> {
    const identity = await this.storage.getIdentity();
    if (!identity) {
      throw new Error(
        'Acceso denegado a la bóveda binaria: no existe identidad local registrada en el dispositivo.'
      );
    }
    if (identity.role !== 'CORE') {
      throw new Error(
        `Acceso denegado: solo VEL CORE puede escribir en la bóveda binaria local (rol actual: ${identity.role}).`
      );
    }
    if (identity.registrationStatus === 'revoked') {
      throw new Error('Acceso denegado: la identidad CORE local figura revocada.');
    }
    return identity;
  }

  private async assertCoreRoleForRead(): Promise<LocalDeviceIdentityRecord> {
    const identity = await this.storage.getIdentity();
    if (!identity) {
      throw new Error(
        'Acceso denegado a la bóveda binaria: no existe identidad local registrada en el dispositivo.'
      );
    }
    if (identity.role !== 'CORE') {
      throw new Error(
        `Acceso denegado: la bóveda binaria local pertenece exclusivamente a VEL CORE (rol actual: ${identity.role}).`
      );
    }
    return identity;
  }

  private async encryptMetadata(
    key: CryptoKey,
    fileId: string,
    meta: CoreVaultFileMetadataPlain
  ): Promise<{ encryptedMeta: ArrayBuffer; metaIv: ArrayBuffer }> {
    const subtle = getWebCryptoSubtle();
    const metaIvBytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(meta));
    const encryptedMeta = await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: metaIvBytes as BufferSource,
        additionalData: buildVaultMetaAad(fileId),
        tagLength: 128
      },
      key,
      toExactArrayBuffer(encoded)
    );
    return {
      encryptedMeta,
      metaIv: toExactArrayBuffer(metaIvBytes)
    };
  }

  private async decryptMetadata(
    key: CryptoKey,
    record: VaultFileRecord
  ): Promise<CoreVaultFileMetadataPlain> {
    const subtle = getWebCryptoSubtle();
    const decrypted = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: record.metaIv,
        additionalData: buildVaultMetaAad(record.fileId),
        tagLength: 128
      },
      key,
      record.encryptedMeta
    );
    const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as Partial<CoreVaultFileMetadataPlain>;
    if (!parsed || typeof parsed.fileName !== 'string' || typeof parsed.mimeType !== 'string') {
      throw new Error(`Metadatos descifrados inválidos para el archivo ${record.fileId}.`);
    }
    return {
      fileName: parsed.fileName,
      mimeType: parsed.mimeType
    };
  }

  private async encryptChunkPayload(
    key: CryptoKey,
    fileId: string,
    chunkIndex: number,
    plainBytes: Uint8Array | ArrayBuffer
  ): Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer; plainByteLength: number }> {
    const subtle = getWebCryptoSubtle();
    const view = toUint8Array(plainBytes);
    const ivBytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes as BufferSource,
        additionalData: buildVaultChunkAad(fileId, chunkIndex),
        tagLength: 128
      },
      key,
      toExactArrayBuffer(view)
    );

    return {
      iv: toExactArrayBuffer(ivBytes),
      ciphertext,
      plainByteLength: view.byteLength
    };
  }

  private async decryptChunkPayload(
    key: CryptoKey,
    record: VaultChunkRecord
  ): Promise<Uint8Array> {
    const subtle = getWebCryptoSubtle();
    const decrypted = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: record.iv,
        additionalData: buildVaultChunkAad(record.fileId, record.chunkIndex),
        tagLength: 128
      },
      key,
      record.ciphertext
    );
    return new Uint8Array(decrypted);
  }

  /**
   * Inicia el registro staging para un archivo entrante o importado localmente en CORE.
   * No mantiene transacciones abiertas durante cifrado ni solicitudes de cuota/persistencia.
   */
  async beginStagingFile(input: BeginStagingFileInput): Promise<{
    record: VaultFileRecord;
    persistence: StoragePersistenceReport;
    estimate: StorageEstimateReport;
  }> {
    await this.assertCoreRoleForWrite();

    const fileId = input.fileId?.trim();
    if (!fileId) {
      throw new Error('fileId es obligatorio para registrar un archivo en la bóveda.');
    }
    if (!input.fileName?.trim()) {
      throw new Error('fileName es obligatorio.');
    }
    if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0) {
      throw new Error(`sizeBytes inválido: ${input.sizeBytes}`);
    }

    const chunkSize = input.chunkSize ?? DEFAULT_VAULT_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new Error(`chunkSize inválido: ${chunkSize}`);
    }

    const totalChunks = input.totalChunks ?? Math.max(1, Math.ceil(input.sizeBytes / chunkSize));
    if (!Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new Error(`totalChunks inválido: ${totalChunks}`);
    }

    // Consultar almacenamiento y solicitar persistencia fuera de toda transacción IDB
    const [persistence, estimate] = await Promise.all([
      requestCorePersistentStorage(),
      getCoreStorageEstimate()
    ]);

    if (
      estimate.supported &&
      estimate.availableBytes !== null &&
      input.sizeBytes > 0 &&
      estimate.availableBytes < Math.ceil(input.sizeBytes * 1.05)
    ) {
      throw new Error(
        `Espacio local insuficiente en CORE (disponible: ${estimate.availableBytes} bytes, requerido aprox.: ${Math.ceil(
          input.sizeBytes * 1.05
        )} bytes).`
      );
    }

    // Preparar clave y cifrado de metadatos ANTES de abrir transacción IndexedDB
    const vaultKey = await getOrCreateLocalVaultKey(this.storage);
    const { encryptedMeta, metaIv } = await this.encryptMetadata(vaultKey, fileId, {
      fileName: input.fileName,
      mimeType: input.mimeType || 'application/octet-stream'
    });

    const now = Date.now();
    const record: VaultFileRecord = {
      fileId,
      encryptedMeta,
      metaIv,
      sizeBytes: input.sizeBytes,
      chunkSize,
      totalChunks,
      receivedChunks: 0,
      sha256: (input.expectedSha256 || '').toLowerCase(),
      status: 'staging',
      sourceDeviceId: input.sourceDeviceId,
      lastChunkAt: now,
      createdAt: now,
      updatedAt: now
    };

    if (input.markActive !== false) {
      this.markTransferActive(fileId);
    }

    await this.storage.putVaultFile(record);
    return { record, persistence, estimate };
  }

  /**
   * Cifra un bloque binario con local_vault_aes_key ANTES de abrir la transacción
   * y lo guarda como ArrayBuffer puro en vault_chunks verificando oncomplete.
   */
  async writeEncryptedChunk(params: {
    fileId: string;
    chunkIndex: number;
    plainBytes: Uint8Array | ArrayBuffer;
  }): Promise<VaultChunkRecord> {
    return this.runSerializedForFile(params.fileId, async () => {
      await this.assertCoreRoleForWrite();

      const { fileId, chunkIndex, plainBytes } = params;
      if (!fileId?.trim()) {
        throw new Error('fileId es obligatorio al escribir un bloque.');
      }

      const fileRecord = await this.storage.getVaultFile(fileId);
      if (!fileRecord) {
        throw new Error(`No existe registro staging para fileId=${fileId}.`);
      }
      if (fileRecord.status !== 'staging') {
        throw new Error(`No se pueden escribir bloques sobre un archivo en estado ${fileRecord.status}.`);
      }
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= fileRecord.totalChunks) {
        throw new Error(`chunkIndex fuera de rango (${chunkIndex}/${fileRecord.totalChunks}).`);
      }

      const chunkKey = buildVaultChunkKey(fileId, chunkIndex);
      const existingChunk = await this.storage.getVaultChunk(chunkKey);

      // 1. Cifrado asíncrono completo ANTES de iniciar transacción de escritura
      const vaultKey = await getOrCreateLocalVaultKey(this.storage);
      const encrypted = await this.encryptChunkPayload(vaultKey, fileId, chunkIndex, plainBytes);

      if (!(encrypted.ciphertext instanceof ArrayBuffer) || !(encrypted.iv instanceof ArrayBuffer)) {
        throw new Error('El bloque cifrado debe serializarse como ArrayBuffer.');
      }

      const now = Date.now();
      const chunkRecord: VaultChunkRecord = {
        chunkKey,
        fileId,
        chunkIndex,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        plainByteLength: encrypted.plainByteLength,
        updatedAt: now
      };

      // 2. Transacción exclusiva de escritura (await oncomplete)
      await this.storage.putVaultChunk(chunkRecord);

      // 3. Actualizar progreso del registro staging de forma serializada
      const nextReceived = existingChunk ? fileRecord.receivedChunks : fileRecord.receivedChunks + 1;
      await this.storage.putVaultFile({
        ...fileRecord,
        receivedChunks: nextReceived,
        lastChunkAt: now,
        updatedAt: now
      });

      return chunkRecord;
    });
  }

  /**
   * Lee y descifra un bloque individual desde vault_chunks verificando integridad AEAD+AAD.
   */
  async readAndDecryptChunk(fileId: string, chunkIndex: number): Promise<Uint8Array> {
    await this.assertCoreRoleForRead();

    const chunkRecord = await this.storage.getVaultChunk(buildVaultChunkKey(fileId, chunkIndex));
    if (!chunkRecord) {
      throw new Error(`Bloque no encontrado en bóveda CORE: ${fileId}#${chunkIndex}.`);
    }

    const vaultKey = await getOrCreateLocalVaultKey(this.storage);
    return this.decryptChunkPayload(vaultKey, chunkRecord);
  }

  /**
   * Confirma un archivo únicamente después de:
   * 1. Verificar que existen todos los bloques 0..totalChunks-1.
   * 2. Descifrar cada bloque y verificar tamaño exacto + SHA-256 incremental acumulado.
   * 3. Guardar estado 'ready' esperando oncomplete y releer la persistencia real.
   */
  async commitStagingFile(params: {
    fileId: string;
    expectedSha256?: string;
  }): Promise<CoreVaultFileSummary> {
    await this.assertCoreRoleForWrite();

    const fileRecord = await this.storage.getVaultFile(params.fileId);
    if (!fileRecord) {
      throw new Error(`No existe registro de archivo para confirmar (${params.fileId}).`);
    }

    const chunks = await this.storage.getVaultChunksByFileId(params.fileId);
    if (chunks.length !== fileRecord.totalChunks) {
      throw new Error(
        `Archivo incompleto (${chunks.length}/${fileRecord.totalChunks} bloques presentes); no se puede confirmar.`
      );
    }

    const vaultKey = await getOrCreateLocalVaultKey(this.storage);
    const hasher = new IncrementalSha256();
    let totalPlainBytes = 0;

    for (let expectedIdx = 0; expectedIdx < fileRecord.totalChunks; expectedIdx++) {
      const chunk = chunks[expectedIdx];
      if (!chunk || chunk.chunkIndex !== expectedIdx) {
        throw new Error(
          `Secuencia de bloques corrupta o faltante en índice ${expectedIdx} para ${params.fileId}.`
        );
      }
      const decryptedBytes = await this.decryptChunkPayload(vaultKey, chunk);
      totalPlainBytes += decryptedBytes.byteLength;
      hasher.update(decryptedBytes);
    }

    if (totalPlainBytes !== fileRecord.sizeBytes) {
      throw new Error(
        `Tamaño descifrado inconsistente para ${params.fileId}: esperado=${fileRecord.sizeBytes}, real=${totalPlainBytes}.`
      );
    }

    const actualSha256 = hasher.digestHex();
    const expectedHash = (params.expectedSha256 || fileRecord.sha256 || '').trim().toLowerCase();
    if (expectedHash && actualSha256 !== expectedHash) {
      throw new Error(
        `Fallo de integridad SHA-256 al confirmar ${params.fileId}: esperado=${expectedHash}, calculado=${actualSha256}.`
      );
    }

    const plainMeta = await this.decryptMetadata(vaultKey, fileRecord);
    const now = Date.now();
    const readyRecord: VaultFileRecord = {
      ...fileRecord,
      receivedChunks: chunks.length,
      sha256: actualSha256,
      status: 'ready',
      lastChunkAt: now,
      updatedAt: now,
      confirmedAt: now
    };

    await this.storage.putVaultFile(readyRecord);

    // Verificar persistencia real releyendo desde IndexedDB tras oncomplete
    const persisted = await this.storage.getVaultFile(params.fileId);
    if (!persisted || persisted.status !== 'ready' || persisted.sha256 !== actualSha256) {
      throw new Error(`No se pudo verificar la persistencia confirmada de ${params.fileId} en IndexedDB.`);
    }

    this.markTransferInactive(params.fileId);

    return {
      fileId: persisted.fileId,
      fileName: plainMeta.fileName,
      mimeType: plainMeta.mimeType,
      sizeBytes: persisted.sizeBytes,
      chunkSize: persisted.chunkSize,
      totalChunks: persisted.totalChunks,
      receivedChunks: persisted.receivedChunks,
      sha256: persisted.sha256,
      status: persisted.status,
      sourceDeviceId: persisted.sourceDeviceId,
      isActiveTransfer: false,
      lastChunkAt: persisted.lastChunkAt,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      confirmedAt: persisted.confirmedAt
    };
  }

  /**
   * Guarda un archivo completo por bloques cifrados y confirma su escritura e integridad.
   */
  async saveBinaryFile(input: SaveBinaryFileInput): Promise<CoreVaultFileSummary> {
    await this.assertCoreRoleForWrite();

    const fileId = input.fileId?.trim() || generateVaultFileId();
    const bytes = toUint8Array(input.bytes);
    const chunkSize = input.chunkSize ?? DEFAULT_VAULT_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new Error(`chunkSize inválido: ${chunkSize}`);
    }

    const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / chunkSize));
    const hasher = new IncrementalSha256();
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      hasher.update(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
    }
    const expectedSha256 = hasher.digestHex();

    await this.beginStagingFile({
      fileId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: bytes.byteLength,
      chunkSize,
      totalChunks,
      expectedSha256,
      sourceDeviceId: input.sourceDeviceId,
      markActive: true
    });

    try {
      if (bytes.byteLength === 0) {
        await this.writeEncryptedChunk({
          fileId,
          chunkIndex: 0,
          plainBytes: new Uint8Array(0)
        });
      } else {
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          const start = chunkIndex * chunkSize;
          const end = Math.min(start + chunkSize, bytes.byteLength);
          await this.writeEncryptedChunk({
            fileId,
            chunkIndex,
            plainBytes: bytes.subarray(start, end)
          });
        }
      }

      return await this.commitStagingFile({
        fileId,
        expectedSha256
      });
    } catch (err) {
      this.markTransferInactive(fileId);
      if (input.cleanupStagingOnFailure) {
        try {
          await this.storage.deleteVaultFileAndChunks(fileId);
        } catch {
          // Conservar error original de escritura/commit
        }
      }
      throw err;
    }
  }

  /**
   * Lista los archivos protegidos de la bóveda CORE (por defecto solo estado 'ready').
   */
  async listFiles(options?: { includeStaging?: boolean }): Promise<CoreVaultFileSummary[]> {
    await this.assertCoreRoleForRead();

    const includeStaging = Boolean(options?.includeStaging);
    const records = await this.storage.getAllVaultFiles();
    const vaultKey = await getOrCreateLocalVaultKey(this.storage);
    const summaries: CoreVaultFileSummary[] = [];

    for (const record of records) {
      if (!includeStaging && record.status !== 'ready') {
        continue;
      }
      const meta = await this.decryptMetadata(vaultKey, record);
      summaries.push({
        fileId: record.fileId,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        sizeBytes: record.sizeBytes,
        chunkSize: record.chunkSize,
        totalChunks: record.totalChunks,
        receivedChunks: record.receivedChunks,
        sha256: record.sha256,
        status: record.status,
        sourceDeviceId: record.sourceDeviceId,
        isActiveTransfer: this.isTransferActive(record.fileId),
        lastChunkAt: record.lastChunkAt,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        confirmedAt: record.confirmedAt
      });
    }

    summaries.sort((a, b) => b.createdAt - a.createdAt);
    return summaries;
  }

  /**
   * Descifra y entrega un archivo protegido bloque por bloque verificando SHA-256 sin concatenar
   * todo el archivo en un único buffer en memoria.
   */
  async streamProtectedFileChunks(
    fileId: string,
    onChunk: (chunk: Uint8Array, chunkIndex: number, totalChunks: number) => Promise<void> | void
  ): Promise<CoreVaultFileSummary> {
    await this.assertCoreRoleForRead();

    const record = await this.storage.getVaultFile(fileId);
    if (!record) {
      throw new Error(`Archivo no encontrado en bóveda CORE: ${fileId}.`);
    }
    if (record.status !== 'ready') {
      throw new Error(`El archivo ${fileId} todavía está en estado ${record.status} y no fue confirmado.`);
    }

    const vaultKey = await getOrCreateLocalVaultKey(this.storage);
    const meta = await this.decryptMetadata(vaultKey, record);
    const chunks = await this.storage.getVaultChunksByFileId(fileId);
    if (chunks.length !== record.totalChunks) {
      throw new Error(
        `Integridad comprometida en ${fileId}: bloques esperados=${record.totalChunks}, presentes=${chunks.length}.`
      );
    }

    const hasher = new IncrementalSha256();
    let totalBytesRead = 0;

    for (let idx = 0; idx < record.totalChunks; idx++) {
      const chunk = chunks[idx];
      if (!chunk || chunk.chunkIndex !== idx) {
        throw new Error(`Bloque faltante o desordenado (${idx}) al leer ${fileId}.`);
      }
      const decrypted = await this.decryptChunkPayload(vaultKey, chunk);
      totalBytesRead += decrypted.byteLength;
      if (totalBytesRead > record.sizeBytes) {
        throw new Error(`Desbordamiento de tamaño al leer ${fileId}.`);
      }
      hasher.update(decrypted);
      await onChunk(decrypted, idx, record.totalChunks);
    }

    if (totalBytesRead !== record.sizeBytes) {
      throw new Error(`Longitud reconstruida inconsistente para ${fileId}: ${totalBytesRead}/${record.sizeBytes}.`);
    }

    const actualSha256 = hasher.digestHex();
    if (actualSha256 !== record.sha256) {
      throw new Error(
        `Fallo de integridad SHA-256 al leer ${fileId}: esperado=${record.sha256}, calculado=${actualSha256}.`
      );
    }

    return {
      fileId: record.fileId,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      sizeBytes: record.sizeBytes,
      chunkSize: record.chunkSize,
      totalChunks: record.totalChunks,
      receivedChunks: record.receivedChunks,
      sha256: record.sha256,
      status: record.status,
      sourceDeviceId: record.sourceDeviceId,
      isActiveTransfer: this.isTransferActive(record.fileId),
      lastChunkAt: record.lastChunkAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      confirmedAt: record.confirmedAt
    };
  }

  /**
   * Construye un Blob verificando integridad por bloques (evita un Uint8Array contiguo gigante en JS).
   */
  async openProtectedFileAsBlob(fileId: string): Promise<{
    metadata: CoreVaultFileSummary;
    blob: Blob;
  }> {
    const parts: BlobPart[] = [];
    const metadata = await this.streamProtectedFileChunks(fileId, (chunk) => {
      parts.push(toExactArrayBuffer(chunk));
    });
    const blob = new Blob(parts, { type: metadata.mimeType || 'application/octet-stream' });
    return { metadata, blob };
  }

  /**
   * Recupera y descifra secuencialmente un archivo en buffer único (recomendado solo para archivos pequeños o pruebas).
   */
  async readFileBytes(fileId: string): Promise<{
    metadata: CoreVaultFileSummary;
    bytes: Uint8Array;
  }> {
    await this.assertCoreRoleForRead();

    const record = await this.storage.getVaultFile(fileId);
    if (!record) {
      throw new Error(`Archivo no encontrado en bóveda CORE: ${fileId}.`);
    }
    if (record.status !== 'ready') {
      throw new Error(`El archivo ${fileId} todavía está en estado ${record.status} y no fue confirmado.`);
    }

    const output = new Uint8Array(record.sizeBytes);
    let offset = 0;
    const metadata = await this.streamProtectedFileChunks(fileId, (decrypted) => {
      if (offset + decrypted.byteLength > output.byteLength) {
        throw new Error(`Desbordamiento de tamaño al reconstruir ${fileId}.`);
      }
      output.set(decrypted, offset);
      offset += decrypted.byteLength;
    });

    return { metadata, bytes: output };
  }

  /**
   * Elimina un archivo y todos sus bloques en una transacción atómica y verifica posteriormente
   * que no queden metadatos ni bloques huérfanos.
   */
  async deleteFile(fileId: string): Promise<DeleteVaultFileResult> {
    await this.assertCoreRoleForWrite();

    if (!fileId?.trim()) {
      throw new Error('fileId es obligatorio para eliminar un archivo.');
    }

    const existing = await this.storage.getVaultFile(fileId);
    const existingChunks = await this.storage.getVaultChunksByFileId(fileId);
    if (!existing && existingChunks.length === 0) {
      return {
        deleted: false,
        deletedChunks: 0,
        integrityVerified: true
      };
    }

    this.markTransferInactive(fileId);
    const deletedChunks = await this.storage.deleteVaultFileAndChunks(fileId);

    const remainingFile = await this.storage.getVaultFile(fileId);
    const remainingChunks = await this.storage.getVaultChunksByFileId(fileId);
    const integrityVerified = remainingFile === null && remainingChunks.length === 0;

    if (!integrityVerified) {
      throw new Error(`Control de integridad fallido al eliminar ${fileId}: quedaron restos en IndexedDB.`);
    }

    return {
      deleted: true,
      deletedChunks,
      integrityVerified: true
    };
  }

  /**
   * Limpia únicamente registros staging abandonados, preservando siempre transferencias activas
   * o con actividad reciente dentro de maxIdleMs.
   */
  async cleanupAbandonedStaging(
    maxIdleMs = DEFAULT_STAGING_ABANDON_MS,
    now = Date.now()
  ): Promise<CleanupStagingResult> {
    await this.assertCoreRoleForWrite();

    const allFiles = await this.storage.getAllVaultFiles();
    const stagingFiles = allFiles.filter((f) => f.status === 'staging');
    const deletedFileIds: string[] = [];
    const skippedActiveFileIds: string[] = [];
    let deletedChunksCount = 0;

    for (const file of stagingFiles) {
      const idleDuration = now - file.lastChunkAt;
      const isMarkedActive = this.isTransferActive(file.fileId);
      const isRecentlyActive = idleDuration < maxIdleMs;

      if (isMarkedActive || isRecentlyActive) {
        skippedActiveFileIds.push(file.fileId);
        continue;
      }

      const deletedChunks = await this.storage.deleteVaultFileAndChunks(file.fileId);
      deletedChunksCount += deletedChunks;
      deletedFileIds.push(file.fileId);
    }

    return {
      inspectedStagingCount: stagingFiles.length,
      deletedFileIds,
      skippedActiveFileIds,
      deletedChunksCount
    };
  }
}

export const coreFileVault = new CoreFileVaultManager(velDb);
