import { hashBlobIncremental } from '../crypto/fileHash';
import {
  CoreFileVaultManager,
  coreFileVault,
  DEFAULT_VAULT_CHUNK_SIZE,
  MAX_PRACTICAL_VAULT_FILE_BYTES
} from '../db/coreFileVault';
import {
  BinaryFileEnvelopeSendResult,
  IncomingBinaryFilePacket,
  VelRelayClient
} from './relayClient';

export const FILE_TRANSFER_CHUNK_SIZE = DEFAULT_VAULT_CHUNK_SIZE; // 128 KB
export const MAX_TRANSFER_FILE_BYTES = MAX_PRACTICAL_VAULT_FILE_BYTES; // 100 MB

export type FileTransferStatusCode =
  | 'SELECTED'
  | 'PREPARING'
  | 'ENCRYPTING'
  | 'SENDING'
  | 'RECEIVING_IN_CORE'
  | 'VERIFYING_INTEGRITY'
  | 'SAVING_IN_CORE_VAULT'
  | 'PROTECTED_IN_CORE'
  | 'INTERRUPTED'
  | 'FAILED';

export const FILE_TRANSFER_STATUS_LABELS: Record<FileTransferStatusCode, string> = {
  SELECTED: 'Listo para enviar',
  PREPARING: 'Preparando archivo',
  ENCRYPTING: 'Cifrando',
  SENDING: 'Enviando',
  RECEIVING_IN_CORE: 'Recibiendo en CORE',
  VERIFYING_INTEGRITY: 'Verificando integridad',
  SAVING_IN_CORE_VAULT: 'Guardando en bóveda CORE',
  PROTECTED_IN_CORE: 'Protegido en CORE',
  INTERRUPTED: 'Transferencia interrumpida',
  FAILED: 'Transferencia fallida'
};

export type FileTransferCategory = 'PHOTO' | 'VIDEO' | 'PDF' | 'OTHER';

export interface FileTransferItemState {
  localId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  category: FileTransferCategory;
  sizeBytes: number;
  chunkSize: number;
  totalChunks: number;
  chunksConfirmed: number;
  progressPercent: number;
  status: FileTransferStatusCode;
  statusLabel: string;
  sha256?: string;
  errorMessage?: string;
  canRetry: boolean;
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number;
}

export interface CoreIncomingTransferState {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  totalChunks: number;
  receivedChunks: number;
  progressPercent: number;
  status: FileTransferStatusCode;
  statusLabel: string;
  errorMessage?: string;
  updatedAt: number;
}

export interface FileTransferSnapshot {
  outgoing: FileTransferItemState[];
  incoming: CoreIncomingTransferState[];
  hasActiveTransfer: boolean;
}

type FileControlMessage =
  | {
      kind: 'FILE_OFFER';
      fileId: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      chunkSize: number;
      totalChunks: number;
      expectedSha256: string;
    }
  | {
      kind: 'FILE_COMMIT';
      fileId: string;
      expectedSha256: string;
      totalChunks: number;
      sizeBytes: number;
    }
  | {
      kind: 'FILE_ABORT';
      fileId: string;
      reason: string;
    }
  | {
      kind: 'FILE_COMMIT_ACK';
      fileId: string;
      sha256: string;
      sizeBytes: number;
      confirmedAt: number;
    }
  | {
      kind: 'FILE_ERROR';
      fileId: string;
      code: string;
      message: string;
    };

interface OutgoingRecordInternal {
  state: FileTransferItemState;
  sourceBlob: Blob | null;
}

interface CoreIncomingSession {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  chunkSize: number;
  totalChunks: number;
  expectedSha256: string;
  expectedNextChunkIndex: number;
  totalReceivedBytes: number;
  failed: boolean;
}

export interface SelectableFileInput {
  name: string;
  type?: string;
  size: number;
  blob: Blob;
}

const INTERRUPT_REASONS = new Set([
  'RELAY_DISCONNECTED',
  'MANUAL_DISCONNECT',
  'RECIPIENT_OFFLINE',
  'WS_SEND_FAILED',
  'OFFLINE_OR_UNLINKED',
  'ACK_TIMEOUT',
  'DEVICE_REVOKED'
]);

function generateId(prefix: string): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0').toUpperCase();
  }
  return `${prefix}-${hex}`;
}

export function classifyFileCategory(fileName: string, mimeType: string): FileTransferCategory {
  const lowerMime = (mimeType || '').toLowerCase();
  const lowerName = (fileName || '').toLowerCase();
  if (lowerMime.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|heic|heif|bmp)$/.test(lowerName)) {
    return 'PHOTO';
  }
  if (lowerMime.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v)$/.test(lowerName)) {
    return 'VIDEO';
  }
  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) {
    return 'PDF';
  }
  return 'OTHER';
}

export function formatFileSizeHuman(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function isStorageQuotaError(err: unknown): boolean {
  const msg = String((err as any)?.message || '').toLowerCase();
  const name = String((err as any)?.name || '').toLowerCase();
  return (
    name.includes('quotaexceeded') ||
    msg.includes('quota') ||
    msg.includes('espacio local insuficiente')
  );
}

export class FileTransferService {
  private relayClient: VelRelayClient;
  private coreVault: CoreFileVaultManager;
  private onCoreVaultUpdated?: () => void;

  private outgoing = new Map<string, OutgoingRecordInternal>();
  private outgoingOrder: string[] = [];
  private activeOutgoingLocalId: string | null = null;
  private abortedOutgoingLocalIds = new Set<string>();

  private incomingSessions = new Map<string, CoreIncomingSession>();
  private incomingUi = new Map<string, CoreIncomingTransferState>();
  private incomingLocks = new Map<string, Promise<boolean>>();

  private remoteErrorsByFileId = new Map<string, { code: string; message: string }>();
  private commitAckWaiters = new Map<
    string,
    {
      resolve: (ack: { ok: boolean; sha256?: string; confirmedAt?: number; error?: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private listeners = new Set<(snapshot: FileTransferSnapshot) => void>();
  private unsubscribeConnectionLost: (() => void) | null = null;
  private isDisposed = false;

  constructor(options: {
    relayClient: VelRelayClient;
    coreVault?: CoreFileVaultManager;
    onCoreVaultUpdated?: () => void;
  }) {
    this.relayClient = options.relayClient;
    this.coreVault = options.coreVault || coreFileVault;
    this.onCoreVaultUpdated = options.onCoreVaultUpdated;

    this.relayClient.setFilePacketHandler((packet) => this.handleIncomingPacket(packet));
    this.unsubscribeConnectionLost = this.relayClient.onConnectionLost((reason) => {
      this.handleConnectionLost(reason);
    });
  }

  public dispose(): void {
    this.isDisposed = true;
    this.relayClient.setFilePacketHandler(null);
    if (this.unsubscribeConnectionLost) {
      this.unsubscribeConnectionLost();
      this.unsubscribeConnectionLost = null;
    }
    for (const waiter of this.commitAckWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, error: 'Servicio cerrado.' });
    }
    this.commitAckWaiters.clear();
    for (const entry of this.outgoing.values()) {
      entry.sourceBlob = null;
    }
    for (const fileId of this.incomingSessions.keys()) {
      this.coreVault.markTransferInactive(fileId);
    }
    this.incomingSessions.clear();
    this.listeners.clear();
  }

  public getSnapshot(): FileTransferSnapshot {
    const outgoing = this.outgoingOrder
      .map((id) => this.outgoing.get(id)?.state)
      .filter((s): s is FileTransferItemState => Boolean(s))
      .map((s) => ({ ...s }));
    const incoming = Array.from(this.incomingUi.values())
      .map((s) => ({ ...s }))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const hasActiveTransfer =
      this.activeOutgoingLocalId !== null || this.incomingSessions.size > 0;

    return { outgoing, incoming, hasActiveTransfer };
  }

  public subscribe(listener: (snapshot: FileTransferSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    if (this.isDisposed) return;
    const snap = this.getSnapshot();
    for (const l of this.listeners) {
      l(snap);
    }
  }

  private updateOutgoingState(
    localId: string,
    patch: Partial<FileTransferItemState>,
    releaseBlob = false
  ): void {
    const entry = this.outgoing.get(localId);
    if (!entry) return;
    const nextStatus = patch.status ?? entry.state.status;
    entry.state = {
      ...entry.state,
      ...patch,
      status: nextStatus,
      statusLabel: patch.statusLabel ?? FILE_TRANSFER_STATUS_LABELS[nextStatus],
      updatedAt: Date.now()
    };
    if (releaseBlob) {
      entry.sourceBlob = null;
    }
    this.emit();
  }

  private updateIncomingUi(fileId: string, patch: Partial<CoreIncomingTransferState> & { fileName?: string; mimeType?: string; sizeBytes?: number; totalChunks?: number }): void {
    const current = this.incomingUi.get(fileId);
    const nextStatus = patch.status ?? current?.status ?? 'RECEIVING_IN_CORE';
    const next: CoreIncomingTransferState = {
      fileId,
      fileName: patch.fileName ?? current?.fileName ?? 'Archivo entrante',
      mimeType: patch.mimeType ?? current?.mimeType ?? 'application/octet-stream',
      sizeBytes: patch.sizeBytes ?? current?.sizeBytes ?? 0,
      totalChunks: patch.totalChunks ?? current?.totalChunks ?? 1,
      receivedChunks: patch.receivedChunks ?? current?.receivedChunks ?? 0,
      progressPercent: patch.progressPercent ?? current?.progressPercent ?? 0,
      status: nextStatus,
      statusLabel: patch.statusLabel ?? FILE_TRANSFER_STATUS_LABELS[nextStatus],
      errorMessage: patch.errorMessage,
      updatedAt: Date.now()
    };
    this.incomingUi.set(fileId, next);
    this.emit();
  }

  /**
   * Añade archivos seleccionados en MÓVIL usando referencias volátiles en RAM (nunca IndexedDB en MÓVIL).
   */
  public selectFiles(inputs: File[] | SelectableFileInput[]): FileTransferItemState[] {
    const added: FileTransferItemState[] = [];
    const now = Date.now();

    for (const item of inputs) {
      const blob = item instanceof Blob ? item : item.blob;
      const fileName = (item.name || 'archivo-sin-nombre').trim();
      const mimeType = item.type || 'application/octet-stream';
      const sizeBytes = Number.isFinite(item.size) ? item.size : blob.size;
      const totalChunks = Math.max(1, Math.ceil(sizeBytes / FILE_TRANSFER_CHUNK_SIZE));
      const localId = generateId('TX');
      const fileId = generateId('FILE');
      const category = classifyFileCategory(fileName, mimeType);

      if (sizeBytes > MAX_TRANSFER_FILE_BYTES) {
        const oversizedState: FileTransferItemState = {
          localId,
          fileId,
          fileName,
          mimeType,
          category,
          sizeBytes,
          chunkSize: FILE_TRANSFER_CHUNK_SIZE,
          totalChunks,
          chunksConfirmed: 0,
          progressPercent: 0,
          status: 'FAILED',
          statusLabel: FILE_TRANSFER_STATUS_LABELS.FAILED,
          errorMessage: `El archivo (${formatFileSizeHuman(sizeBytes)}) supera el límite práctico inicial de 100 MB.`,
          canRetry: false,
          createdAt: now,
          updatedAt: now
        };
        this.outgoing.set(localId, { state: oversizedState, sourceBlob: null });
        this.outgoingOrder.unshift(localId);
        added.push({ ...oversizedState });
        continue;
      }

      const initialState: FileTransferItemState = {
        localId,
        fileId,
        fileName,
        mimeType,
        category,
        sizeBytes,
        chunkSize: FILE_TRANSFER_CHUNK_SIZE,
        totalChunks,
        chunksConfirmed: 0,
        progressPercent: 0,
        status: 'SELECTED',
        statusLabel: FILE_TRANSFER_STATUS_LABELS.SELECTED,
        canRetry: false,
        createdAt: now,
        updatedAt: now
      };
      this.outgoing.set(localId, { state: initialState, sourceBlob: blob });
      this.outgoingOrder.unshift(localId);
      added.push({ ...initialState });
    }

    this.emit();
    return added;
  }

  public removeOutgoingItem(localId: string): void {
    if (this.activeOutgoingLocalId === localId) {
      this.cancelOutgoingTransfer(localId);
    }
    const entry = this.outgoing.get(localId);
    if (entry) {
      entry.sourceBlob = null;
      this.outgoing.delete(localId);
    }
    this.outgoingOrder = this.outgoingOrder.filter((id) => id !== localId);
    this.emit();
  }

  public clearCompletedOutgoing(): void {
    for (const id of [...this.outgoingOrder]) {
      const entry = this.outgoing.get(id);
      if (entry && entry.state.status === 'PROTECTED_IN_CORE') {
        entry.sourceBlob = null;
        this.outgoing.delete(id);
        this.outgoingOrder = this.outgoingOrder.filter((item) => item !== id);
      }
    }
    this.emit();
  }

  public clearFinishedIncoming(): void {
    for (const [fileId, item] of this.incomingUi.entries()) {
      if (item.status === 'PROTECTED_IN_CORE' || item.status === 'INTERRUPTED' || item.status === 'FAILED') {
        this.incomingUi.delete(fileId);
      }
    }
    this.emit();
  }

  public cancelOutgoingTransfer(localId: string): void {
    if (this.activeOutgoingLocalId === localId) {
      this.abortedOutgoingLocalIds.add(localId);
      const entry = this.outgoing.get(localId);
      if (entry) {
        const fileId = entry.state.fileId;
        void this.sendControlMessageToPeer(fileId, {
          kind: 'FILE_ABORT',
          fileId,
          reason: 'CANCELLED_BY_USER'
        });
        this.updateOutgoingState(localId, {
          status: 'INTERRUPTED',
          errorMessage: 'Transferencia detenida por el usuario. Puedes reintentar manualmente.',
          canRetry: Boolean(entry.sourceBlob)
        });
      }
    }
  }

  /**
   * Envía un archivo desde VEL MÓVIL hacia VEL CORE por bloques de 128 KB cifrados E2EE.
   * No mantiene colas persistentes ni reintentos automáticos en segundo plano.
   */
  public async sendFile(localId: string): Promise<FileTransferItemState> {
    const entry = this.outgoing.get(localId);
    if (!entry) {
      throw new Error(`No existe transferencia seleccionada para localId=${localId}.`);
    }

    if (entry.state.sizeBytes > MAX_TRANSFER_FILE_BYTES) {
      this.updateOutgoingState(
        localId,
        {
          status: 'FAILED',
          errorMessage: 'El archivo supera el límite práctico inicial de 100 MB.',
          canRetry: false
        },
        true
      );
      return { ...this.outgoing.get(localId)!.state };
    }

    if (!entry.sourceBlob) {
      this.updateOutgoingState(localId, {
        status: 'FAILED',
        errorMessage: 'El archivo temporal ya no está en memoria. Vuelve a seleccionarlo.',
        canRetry: false
      });
      return { ...this.outgoing.get(localId)!.state };
    }

    const snap = this.relayClient.getSnapshot();
    if (snap.identity?.role !== 'TERMINAL') {
      this.updateOutgoingState(localId, {
        status: 'FAILED',
        errorMessage: 'Solo VEL MÓVIL puede enviar archivos hacia VEL CORE.',
        canRetry: false
      });
      return { ...this.outgoing.get(localId)!.state };
    }

    if (this.activeOutgoingLocalId && this.activeOutgoingLocalId !== localId) {
      throw new Error('Ya hay una transferencia activa en curso en este dispositivo.');
    }

    if (snap.connectionState !== 'LINKED' || !snap.peerOnline) {
      this.updateOutgoingState(localId, {
        status: 'INTERRUPTED',
        errorMessage:
          snap.connectionState !== 'LINKED'
            ? 'Sin sesión cifrada activa con VEL CORE. Conecta ambos teléfonos y pulsa Reintentar.'
            : 'VEL CORE está desconectado. Cuando vuelva a estar en línea, pulsa Reintentar.',
        canRetry: true
      });
      return { ...this.outgoing.get(localId)!.state };
    }

    // Cada intento o reintento manual usa un fileId limpio para evitar mezclar staging previo
    const attemptFileId = generateId('FILE');
    entry.state.fileId = attemptFileId;
    this.abortedOutgoingLocalIds.delete(localId);
    this.remoteErrorsByFileId.delete(attemptFileId);
    this.activeOutgoingLocalId = localId;

    const blob = entry.sourceBlob;
    const { fileName, mimeType, sizeBytes, chunkSize, totalChunks } = entry.state;

    try {
      // 1. Preparar archivo: calcular SHA-256 incrementalmente sin cargar todo en RAM
      this.updateOutgoingState(localId, {
        fileId: attemptFileId,
        status: 'PREPARING',
        chunksConfirmed: 0,
        progressPercent: 0,
        errorMessage: undefined,
        canRetry: false
      });

      const expectedSha256 = await hashBlobIncremental(blob, 512 * 1024);

      if (this.abortedOutgoingLocalIds.has(localId) || this.isDisposed) {
        return { ...this.outgoing.get(localId)!.state };
      }

      this.updateOutgoingState(localId, { sha256: expectedSha256 });

      // 2. Enviar oferta/manifiesto E2EE a CORE y esperar que CORE cree staging real en IndexedDB
      const offerRes = await this.sendControlMessageToPeer(attemptFileId, {
        kind: 'FILE_OFFER',
        fileId: attemptFileId,
        fileName,
        mimeType,
        sizeBytes,
        chunkSize,
        totalChunks,
        expectedSha256
      });

      if (!offerRes.confirmed) {
        this.applyOutgoingFailureFromResult(localId, attemptFileId, offerRes, 'No se pudo iniciar la recepción en VEL CORE.');
        return { ...this.outgoing.get(localId)!.state };
      }

      // 3. Leer, cifrar y enviar secuencialmente cada bloque de 128 KB esperando confirmación real de CORE
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        if (this.abortedOutgoingLocalIds.has(localId) || this.isDisposed) {
          return { ...this.outgoing.get(localId)!.state };
        }

        if (this.relayClient.getState() !== 'LINKED') {
          this.updateOutgoingState(localId, {
            status: 'INTERRUPTED',
            errorMessage: 'Se perdió la conexión cifrada durante el envío. Pulsa Reintentar.',
            canRetry: true
          });
          return { ...this.outgoing.get(localId)!.state };
        }

        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, sizeBytes);
        const sliceBuffer = sizeBytes === 0 ? new ArrayBuffer(0) : await blob.slice(start, end).arrayBuffer();

        this.updateOutgoingState(localId, {
          status: 'ENCRYPTING'
        });

        // Enviar bloque cifrado con encryptE2EEBytes y esperar CONFIRMATION tras IndexedDB.oncomplete en CORE
        this.updateOutgoingState(localId, {
          status: chunkIndex === 0 ? 'SENDING' : 'RECEIVING_IN_CORE'
        });

        const chunkRes = await this.relayClient.sendBinaryFileEnvelope({
          fileId: attemptFileId,
          chunkIndex,
          totalChunks,
          purpose: 'FILE_CHUNK',
          payloadBytes: sliceBuffer
        });

        if (!chunkRes.confirmed) {
          if (!INTERRUPT_REASONS.has(chunkRes.reason || '')) {
            void this.sendControlMessageToPeer(attemptFileId, {
              kind: 'FILE_ABORT',
              fileId: attemptFileId,
              reason: chunkRes.reason || 'CHUNK_FAILED'
            });
          }
          this.applyOutgoingFailureFromResult(
            localId,
            attemptFileId,
            chunkRes,
            `Error enviando bloque ${chunkIndex + 1}/${totalChunks}.`
          );
          return { ...this.outgoing.get(localId)!.state };
        }

        const confirmedCount = chunkIndex + 1;
        const pct = Math.min(95, Math.round((confirmedCount / totalChunks) * 95));
        this.updateOutgoingState(localId, {
          status: 'RECEIVING_IN_CORE',
          chunksConfirmed: confirmedCount,
          progressPercent: pct
        });
      }

      // 4. Solicitar verificación de integridad y persistencia definitiva en bóveda CORE
      this.updateOutgoingState(localId, {
        status: 'VERIFYING_INTEGRITY',
        progressPercent: 97
      });

      const commitAckPromise = this.waitForCommitAck(attemptFileId, 20_000);

      this.updateOutgoingState(localId, {
        status: 'SAVING_IN_CORE_VAULT',
        progressPercent: 99
      });

      const commitRes = await this.sendControlMessageToPeer(attemptFileId, {
        kind: 'FILE_COMMIT',
        fileId: attemptFileId,
        expectedSha256,
        totalChunks,
        sizeBytes
      });

      if (!commitRes.confirmed) {
        this.cancelCommitAckWaiter(attemptFileId);
        this.applyOutgoingFailureFromResult(
          localId,
          attemptFileId,
          commitRes,
          'VEL CORE no pudo verificar o guardar el archivo en su bóveda.'
        );
        return { ...this.outgoing.get(localId)!.state };
      }

      const commitAck = await commitAckPromise;
      if (!commitAck.ok || commitAck.sha256 !== expectedSha256) {
        this.updateOutgoingState(localId, {
          status: 'FAILED',
          errorMessage:
            commitAck.error ||
            'Falta confirmación verificada de SHA-256 desde la bóveda de VEL CORE.',
          canRetry: Boolean(entry.sourceBlob)
        });
        return { ...this.outgoing.get(localId)!.state };
      }

      // 5. Confirmación real recibida: marcar Protegido en CORE y liberar copia temporal de RAM en MÓVIL
      this.updateOutgoingState(
        localId,
        {
          status: 'PROTECTED_IN_CORE',
          chunksConfirmed: totalChunks,
          progressPercent: 100,
          confirmedAt: commitAck.confirmedAt || Date.now(),
          errorMessage: undefined,
          canRetry: false
        },
        true
      );

      return { ...this.outgoing.get(localId)!.state };
    } catch (err: any) {
      this.cancelCommitAckWaiter(attemptFileId);
      const isConnLoss = this.relayClient.getState() !== 'LINKED';
      this.updateOutgoingState(localId, {
        status: isConnLoss ? 'INTERRUPTED' : 'FAILED',
        errorMessage: err?.message || 'Error inesperado durante la transferencia.',
        canRetry: Boolean(this.outgoing.get(localId)?.sourceBlob)
      });
      return { ...this.outgoing.get(localId)!.state };
    } finally {
      if (this.activeOutgoingLocalId === localId) {
        this.activeOutgoingLocalId = null;
      }
      this.abortedOutgoingLocalIds.delete(localId);
    }
  }

  public async retryFile(localId: string): Promise<FileTransferItemState> {
    const entry = this.outgoing.get(localId);
    if (!entry) {
      throw new Error('No se encontró la transferencia para reintentar.');
    }
    if (!entry.sourceBlob) {
      this.updateOutgoingState(localId, {
        status: 'FAILED',
        errorMessage: 'El archivo ya no está en memoria del navegador. Selecciónalo de nuevo.',
        canRetry: false
      });
      return { ...entry.state };
    }
    return this.sendFile(localId);
  }

  public async sendPendingFiles(): Promise<FileTransferItemState[]> {
    const ids = [...this.outgoingOrder]
      .reverse()
      .filter((id) => this.outgoing.get(id)?.state.status === 'SELECTED');
    const results: FileTransferItemState[] = [];
    for (const id of ids) {
      if (this.isDisposed) break;
      const res = await this.sendFile(id);
      results.push(res);
      if (res.status === 'INTERRUPTED') {
        // Si cayó la conexión, detener el resto para evitar fallos en cascada; el usuario decide reintentar
        break;
      }
    }
    return results;
  }

  private applyOutgoingFailureFromResult(
    localId: string,
    fileId: string,
    res: BinaryFileEnvelopeSendResult,
    fallbackMsg: string
  ): void {
    const remoteErr = this.remoteErrorsByFileId.get(fileId);
    this.remoteErrorsByFileId.delete(fileId);

    const isInterrupted = !remoteErr && INTERRUPT_REASONS.has(res.reason || '');
    const message = remoteErr?.message || res.error || fallbackMsg;

    this.updateOutgoingState(localId, {
      status: isInterrupted ? 'INTERRUPTED' : 'FAILED',
      errorMessage: message,
      canRetry: Boolean(this.outgoing.get(localId)?.sourceBlob)
    });
  }

  private waitForCommitAck(
    fileId: string,
    timeoutMs: number
  ): Promise<{ ok: boolean; sha256?: string; confirmedAt?: number; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.commitAckWaiters.delete(fileId);
        resolve({
          ok: false,
          error: 'No se recibió la confirmación final de guardado persistente en CORE.'
        });
      }, timeoutMs);
      this.commitAckWaiters.set(fileId, { resolve, timer });
    });
  }

  private cancelCommitAckWaiter(fileId: string): void {
    const w = this.commitAckWaiters.get(fileId);
    if (w) {
      clearTimeout(w.timer);
      this.commitAckWaiters.delete(fileId);
    }
  }

  private handleConnectionLost(reason: string): void {
    if (this.activeOutgoingLocalId) {
      const activeId = this.activeOutgoingLocalId;
      this.abortedOutgoingLocalIds.add(activeId);
      const entry = this.outgoing.get(activeId);
      if (entry && entry.state.status !== 'PROTECTED_IN_CORE' && entry.state.status !== 'FAILED') {
        this.updateOutgoingState(activeId, {
          status: 'INTERRUPTED',
          errorMessage:
            reason === 'DEVICE_REVOKED'
              ? 'Sesión revocada por VEL CORE.'
              : 'Conexión interrumpida antes de confirmar guardado en CORE. Pulsa Reintentar cuando vuelva a estar conectado.',
          canRetry: reason !== 'DEVICE_REVOKED' && Boolean(entry.sourceBlob)
        });
      }
    }

    for (const [fileId, waiter] of this.commitAckWaiters.entries()) {
      clearTimeout(waiter.timer);
      this.commitAckWaiters.delete(fileId);
      waiter.resolve({ ok: false, error: `Conexión interrumpida (${reason}).` });
    }

    // En lado receptor CORE: marcar transferencias en curso como interrumpidas sin marcar ready
    for (const [fileId, session] of this.incomingSessions.entries()) {
      session.failed = true;
      this.coreVault.markTransferInactive(fileId);
      this.updateIncomingUi(fileId, {
        status: 'INTERRUPTED',
        errorMessage: 'Conexión interrumpida antes de completar el archivo.'
      });
    }
    this.incomingSessions.clear();
  }

  private async sendControlMessageToPeer(
    fileId: string,
    payload: FileControlMessage
  ): Promise<BinaryFileEnvelopeSendResult> {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const purpose =
      payload.kind === 'FILE_COMMIT_ACK' || payload.kind === 'FILE_ERROR'
        ? 'FILE_CONTROL'
        : 'FILE_MANIFEST';
    return this.relayClient.sendBinaryFileEnvelope({
      fileId,
      chunkIndex: 0,
      totalChunks: 1,
      purpose,
      payloadBytes: bytes
    });
  }

  private async sendErrorToPeerBestEffort(fileId: string, code: string, message: string): Promise<void> {
    try {
      await Promise.race([
        this.sendControlMessageToPeer(fileId, {
          kind: 'FILE_ERROR',
          fileId,
          code,
          message
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 400))
      ]);
    } catch {
      // Ignorar fallo secundario al notificar error
    }
  }

  private async handleIncomingPacket(packet: IncomingBinaryFilePacket): Promise<boolean> {
    // Serializar todo procesamiento por fileId para impedir carreras de bloques o commits
    const previous = this.incomingLocks.get(packet.fileId) || Promise.resolve(true);
    const task = previous.then(
      () => this.processIncomingPacketSerialized(packet),
      () => this.processIncomingPacketSerialized(packet)
    );
    this.incomingLocks.set(packet.fileId, task);
    try {
      return await task;
    } finally {
      if (this.incomingLocks.get(packet.fileId) === task) {
        this.incomingLocks.delete(packet.fileId);
      }
    }
  }

  private async processIncomingPacketSerialized(packet: IncomingBinaryFilePacket): Promise<boolean> {
    const snap = this.relayClient.getSnapshot();
    const role = snap.identity?.role;

    if (packet.purpose === 'FILE_CONTROL') {
      let msg: FileControlMessage;
      try {
        msg = JSON.parse(new TextDecoder().decode(packet.plaintextBytes)) as FileControlMessage;
      } catch {
        return false;
      }

      if (msg.kind === 'FILE_COMMIT_ACK') {
        const waiter = this.commitAckWaiters.get(msg.fileId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.commitAckWaiters.delete(msg.fileId);
          waiter.resolve({
            ok: true,
            sha256: msg.sha256,
            confirmedAt: msg.confirmedAt
          });
        }
        return true;
      }

      if (msg.kind === 'FILE_ERROR') {
        this.remoteErrorsByFileId.set(msg.fileId, {
          code: msg.code,
          message: msg.message
        });
        const waiter = this.commitAckWaiters.get(msg.fileId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.commitAckWaiters.delete(msg.fileId);
          waiter.resolve({ ok: false, error: msg.message });
        }
        return true;
      }

      return false;
    }

    // Cualquier recepción de archivos o bloques corresponde EXCLUSIVAMENTE a VEL CORE
    if (role !== 'CORE') {
      void this.sendControlMessageToPeer(packet.fileId, {
        kind: 'FILE_ERROR',
        fileId: packet.fileId,
        code: 'INVALID_ROLE',
        message: 'Solo VEL CORE puede recibir y almacenar archivos.'
      });
      return false;
    }

    if (packet.purpose === 'FILE_MANIFEST') {
      let msg: FileControlMessage;
      try {
        msg = JSON.parse(new TextDecoder().decode(packet.plaintextBytes)) as FileControlMessage;
      } catch {
        return false;
      }

      if (msg.kind === 'FILE_OFFER') {
        return await this.handleCoreFileOffer(msg, packet.senderId);
      }
      if (msg.kind === 'FILE_COMMIT') {
        return await this.handleCoreFileCommit(msg);
      }
      if (msg.kind === 'FILE_ABORT') {
        return await this.handleCoreFileAbort(msg.fileId);
      }
      return false;
    }

    if (packet.purpose === 'FILE_CHUNK') {
      return await this.handleCoreFileChunk(packet);
    }

    return false;
  }

  private async handleCoreFileOffer(
    offer: Extract<FileControlMessage, { kind: 'FILE_OFFER' }>,
    senderDeviceId: string
  ): Promise<boolean> {
    if (
      !offer.fileId ||
      !offer.fileName ||
      !Number.isFinite(offer.sizeBytes) ||
      offer.sizeBytes < 0 ||
      offer.sizeBytes > MAX_TRANSFER_FILE_BYTES ||
      !Number.isInteger(offer.totalChunks) ||
      offer.totalChunks < 1 ||
      !Number.isInteger(offer.chunkSize) ||
      offer.chunkSize <= 0 ||
      offer.chunkSize > FILE_TRANSFER_CHUNK_SIZE ||
      !/^[a-f0-9]{64}$/i.test(offer.expectedSha256 || '')
    ) {
      void this.sendControlMessageToPeer(offer.fileId, {
        kind: 'FILE_ERROR',
        fileId: offer.fileId,
        code: 'INVALID_OFFER',
        message: 'Metadatos de archivo inválidos o exceden el límite de 100 MB.'
      });
      return false;
    }

    try {
      await this.coreVault.beginStagingFile({
        fileId: offer.fileId,
        fileName: offer.fileName,
        mimeType: offer.mimeType || 'application/octet-stream',
        sizeBytes: offer.sizeBytes,
        chunkSize: offer.chunkSize,
        totalChunks: offer.totalChunks,
        expectedSha256: offer.expectedSha256,
        sourceDeviceId: senderDeviceId,
        markActive: true
      });

      this.incomingSessions.set(offer.fileId, {
        fileId: offer.fileId,
        fileName: offer.fileName,
        mimeType: offer.mimeType || 'application/octet-stream',
        sizeBytes: offer.sizeBytes,
        chunkSize: offer.chunkSize,
        totalChunks: offer.totalChunks,
        expectedSha256: offer.expectedSha256.toLowerCase(),
        expectedNextChunkIndex: 0,
        totalReceivedBytes: 0,
        failed: false
      });

      this.updateIncomingUi(offer.fileId, {
        fileName: offer.fileName,
        mimeType: offer.mimeType || 'application/octet-stream',
        sizeBytes: offer.sizeBytes,
        totalChunks: offer.totalChunks,
        receivedChunks: 0,
        progressPercent: 0,
        status: 'RECEIVING_IN_CORE'
      });

      return true;
    } catch (err: any) {
      const code = isStorageQuotaError(err) ? 'QUOTA_EXCEEDED' : 'CORE_WRITE_ERROR';
      const message =
        code === 'QUOTA_EXCEEDED'
          ? 'No hay espacio suficiente en la bóveda local de VEL CORE.'
          : err?.message || 'Error iniciando recepción en bóveda CORE.';

      this.updateIncomingUi(offer.fileId, {
        fileName: offer.fileName,
        mimeType: offer.mimeType || 'application/octet-stream',
        sizeBytes: offer.sizeBytes,
        totalChunks: offer.totalChunks,
        status: 'FAILED',
        errorMessage: message
      });

      await this.sendErrorToPeerBestEffort(offer.fileId, code, message);
      return false;
    }
  }

  private async handleCoreFileChunk(packet: IncomingBinaryFilePacket): Promise<boolean> {
    const session = this.incomingSessions.get(packet.fileId);
    if (!session || session.failed) {
      void this.sendControlMessageToPeer(packet.fileId, {
        kind: 'FILE_ERROR',
        fileId: packet.fileId,
        code: 'NO_ACTIVE_STAGING',
        message: 'No existe recepción staging activa para este bloque en VEL CORE.'
      });
      return false;
    }

    if (packet.totalChunks !== session.totalChunks) {
      await this.failCoreIncoming(session, 'TOTAL_CHUNKS_MISMATCH', 'Conteo de bloques inconsistente.');
      return false;
    }

    if (packet.chunkIndex < session.expectedNextChunkIndex) {
      await this.failCoreIncoming(
        session,
        'DUPLICATE_CHUNK',
        `Bloque duplicado detectado (${packet.chunkIndex}); transferencia abortada por seguridad.`
      );
      return false;
    }

    if (packet.chunkIndex > session.expectedNextChunkIndex) {
      await this.failCoreIncoming(
        session,
        'OUT_OF_ORDER_CHUNK',
        `Bloque fuera de orden (${packet.chunkIndex}, esperado ${session.expectedNextChunkIndex}); transferencia abortada.`
      );
      return false;
    }

    if (session.totalReceivedBytes + packet.plaintextBytes.byteLength > session.sizeBytes) {
      await this.failCoreIncoming(
        session,
        'SIZE_OVERFLOW',
        'El tamaño acumulado de bloques supera el tamaño declarado del archivo.'
      );
      return false;
    }

    try {
      await this.coreVault.writeEncryptedChunk({
        fileId: packet.fileId,
        chunkIndex: packet.chunkIndex,
        plainBytes: packet.plaintextBytes
      });

      session.expectedNextChunkIndex += 1;
      session.totalReceivedBytes += packet.plaintextBytes.byteLength;

      const pct = Math.min(95, Math.round((session.expectedNextChunkIndex / session.totalChunks) * 95));
      this.updateIncomingUi(packet.fileId, {
        receivedChunks: session.expectedNextChunkIndex,
        progressPercent: pct,
        status: 'RECEIVING_IN_CORE'
      });

      return true;
    } catch (err: any) {
      const code = isStorageQuotaError(err) ? 'QUOTA_EXCEEDED' : 'CORE_WRITE_ERROR';
      const msg =
        code === 'QUOTA_EXCEEDED'
          ? 'Espacio local agotado en VEL CORE al guardar bloque cifrado.'
          : err?.message || 'Error al cifrar o escribir bloque en IndexedDB de VEL CORE.';
      await this.failCoreIncoming(session, code, msg);
      return false;
    }
  }

  private async handleCoreFileCommit(
    commit: Extract<FileControlMessage, { kind: 'FILE_COMMIT' }>
  ): Promise<boolean> {
    const session = this.incomingSessions.get(commit.fileId);
    if (!session || session.failed) {
      void this.sendControlMessageToPeer(commit.fileId, {
        kind: 'FILE_ERROR',
        fileId: commit.fileId,
        code: 'NO_ACTIVE_STAGING',
        message: 'No existe recepción activa para confirmar en VEL CORE.'
      });
      return false;
    }

    if (session.expectedNextChunkIndex !== session.totalChunks || session.totalReceivedBytes !== session.sizeBytes) {
      await this.failCoreIncoming(
        session,
        'INCOMPLETE_FILE',
        `Faltan bloques por recibir en VEL CORE (${session.expectedNextChunkIndex}/${session.totalChunks}).`
      );
      return false;
    }

    try {
      this.updateIncomingUi(commit.fileId, {
        status: 'VERIFYING_INTEGRITY',
        progressPercent: 97
      });

      this.updateIncomingUi(commit.fileId, {
        status: 'SAVING_IN_CORE_VAULT',
        progressPercent: 99
      });

      const summary = await this.coreVault.commitStagingFile({
        fileId: commit.fileId,
        expectedSha256: commit.expectedSha256
      });

      this.incomingSessions.delete(commit.fileId);
      this.updateIncomingUi(commit.fileId, {
        receivedChunks: summary.totalChunks,
        progressPercent: 100,
        status: 'PROTECTED_IN_CORE'
      });

      if (this.onCoreVaultUpdated) {
        this.onCoreVaultUpdated();
      }

      // Enviar ACK cifrado con SHA-256 verificado después de persistir y releer en IndexedDB
      queueMicrotask(() => {
        void this.sendControlMessageToPeer(commit.fileId, {
          kind: 'FILE_COMMIT_ACK',
          fileId: commit.fileId,
          sha256: summary.sha256,
          sizeBytes: summary.sizeBytes,
          confirmedAt: summary.confirmedAt || Date.now()
        });
      });

      return true;
    } catch (err: any) {
      const code = String(err?.message || '').toLowerCase().includes('sha-256')
        ? 'INTEGRITY_FAILED'
        : isStorageQuotaError(err)
        ? 'QUOTA_EXCEEDED'
        : 'CORE_WRITE_ERROR';
      await this.failCoreIncoming(
        session,
        code,
        err?.message || 'Fallo verificando o guardando el archivo en la bóveda CORE.'
      );
      return false;
    }
  }

  private async handleCoreFileAbort(fileId: string): Promise<boolean> {
    const session = this.incomingSessions.get(fileId);
    if (session) {
      session.failed = true;
      this.incomingSessions.delete(fileId);
    }
    this.coreVault.markTransferInactive(fileId);
    try {
      await this.coreVault.deleteFile(fileId);
    } catch {
      // Ignorar limpieza secundaria
    }
    if (this.incomingUi.has(fileId)) {
      this.updateIncomingUi(fileId, {
        status: 'INTERRUPTED',
        errorMessage: 'Transferencia cancelada o interrumpida desde VEL MÓVIL.'
      });
    }
    return true;
  }

  private async failCoreIncoming(session: CoreIncomingSession, code: string, message: string): Promise<void> {
    session.failed = true;
    this.incomingSessions.delete(session.fileId);
    this.coreVault.markTransferInactive(session.fileId);
    try {
      await this.coreVault.deleteFile(session.fileId);
    } catch {
      // No bloquear notificación de error si la limpieza falla
    }
    this.updateIncomingUi(session.fileId, {
      status: 'FAILED',
      errorMessage: message
    });
    await this.sendErrorToPeerBestEffort(session.fileId, code, message);
  }
}
