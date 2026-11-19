import {
  DeviceRole,
  RelayDataPayload,
  VelItemKind,
  VelVaultItemSummary
} from '../contracts/velContracts';
import { arrayBufferToBase64, base64ToUint8Array } from '../crypto/deviceCrypto';
import { toExactArrayBuffer } from '../crypto/fileHash';
import {
  LocalStorageStats,
  VEL_CHUNK_SIZE_BYTES,
  velLocalStore,
  VelLocalStore
} from '../db/velLocalStore';
import { VelRelayClient } from './relayClient';

export interface IncomingProgressItem {
  itemId: string;
  title: string;
  fileKind: Exclude<VelItemKind, 'note'>;
  receivedChunks: number;
  totalChunks: number;
  progressPercent: number;
}

export interface TransferManagerSnapshot {
  items: VelVaultItemSummary[];
  incomingProgress: IncomingProgressItem[];
  stats: LocalStorageStats;
  isSyncing: boolean;
}

interface IncomingFileSession {
  itemId: string;
  title: string;
  fileKind: Exclude<VelItemKind, 'note'>;
  mimeType: string;
  sizeBytes: number;
  totalChunks: number;
  receivedChunks: number;
  sourceDeviceId: string;
  createdAt: number;
}

export class VelTransferManager {
  private relayClient: VelRelayClient;
  private store: VelLocalStore;
  private role: DeviceRole;

  private items: VelVaultItemSummary[] = [];
  private stats: LocalStorageStats = {
    itemCount: 0,
    totalBytes: 0,
    quotaSupported: false,
    usageBytes: null,
    quotaBytes: null
  };
  private incomingSessions = new Map<string, IncomingFileSession>();
  private incomingQueue = new Map<string, Promise<void>>();
  private itemAckWaiters = new Map<
    string,
    { resolve: (res: { ok: boolean; confirmedAt?: number; error?: string }) => void; timer: ReturnType<typeof setTimeout> }
  >();

  private isFlushing = false;
  private flushRequested = false;
  private isDisposed = false;
  private listeners = new Set<(snap: TransferManagerSnapshot) => void>();
  private unsubscribeRelay: (() => void) | null = null;
  private unsubscribeLost: (() => void) | null = null;

  constructor(options: {
    relayClient: VelRelayClient;
    role: DeviceRole;
    store?: VelLocalStore;
  }) {
    this.relayClient = options.relayClient;
    this.role = options.role;
    this.store = options.store || velLocalStore;

    this.relayClient.setDataHandler(async (msg) => {
      await this.handleIncomingRelayData(msg.senderId, msg.payload);
    });

    this.unsubscribeRelay = this.relayClient.subscribe((snap) => {
      const subPaused = Boolean(snap.subscriptionStatus?.linked && !snap.subscriptionStatus.active);
      if (
        this.role === 'TERMINAL' &&
        snap.connectionState === 'LINKED' &&
        snap.peerOnline &&
        !subPaused
      ) {
        void this.flushPendingQueue();
      }
    });

    this.unsubscribeLost = this.relayClient.onConnectionLost((reason) => {
      for (const [itemId, waiter] of this.itemAckWaiters.entries()) {
        clearTimeout(waiter.timer);
        this.itemAckWaiters.delete(itemId);
        waiter.resolve({ ok: false, error: `Conexión interrumpida (${reason}).` });
      }
    });

    void this.refresh();
  }

  public setRole(role: DeviceRole) {
    this.role = role;
    if (role === 'TERMINAL') {
      const snap = this.relayClient.getSnapshot();
      if (snap.connectionState === 'LINKED' && snap.peerOnline) {
        void this.flushPendingQueue();
      }
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    this.relayClient.setDataHandler(null);
    if (this.unsubscribeRelay) {
      this.unsubscribeRelay();
      this.unsubscribeRelay = null;
    }
    if (this.unsubscribeLost) {
      this.unsubscribeLost();
      this.unsubscribeLost = null;
    }
    for (const waiter of this.itemAckWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, error: 'Servicio cerrado.' });
    }
    this.itemAckWaiters.clear();
    this.listeners.clear();
  }

  public getSnapshot(): TransferManagerSnapshot {
    const incomingProgress: IncomingProgressItem[] = Array.from(this.incomingSessions.values()).map(
      (s) => ({
        itemId: s.itemId,
        title: s.title,
        fileKind: s.fileKind,
        receivedChunks: s.receivedChunks,
        totalChunks: s.totalChunks,
        progressPercent:
          s.totalChunks > 0 ? Math.min(99, Math.round((s.receivedChunks / s.totalChunks) * 100)) : 0
      })
    );
    return {
      items: this.items,
      incomingProgress,
      stats: this.stats,
      isSyncing: this.isFlushing
    };
  }

  public subscribe(listener: (snap: TransferManagerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  private emit() {
    const snap = this.getSnapshot();
    for (const l of this.listeners) l(snap);
  }

  public async refresh(): Promise<void> {
    if (this.isDisposed) return;
    const [items, stats] = await Promise.all([
      this.store.listItems(),
      this.store.getStats()
    ]);
    this.items = items;
    this.stats = stats;
    this.emit();
  }

  public async addNote(title: string, textContent: string): Promise<void> {
    await this.store.saveNote(this.role, title, textContent);
    await this.refresh();
    if (this.role === 'TERMINAL') {
      void this.flushPendingQueue();
    }
  }

  public async addFiles(
    files: Array<{ name: string; type?: string; size: number; blob: Blob }>
  ): Promise<{ saved: number; errors: string[] }> {
    let saved = 0;
    const errors: string[] = [];
    for (const file of files) {
      try {
        await this.store.saveLocalFile(this.role, file);
        saved++;
      } catch (err: any) {
        errors.push(err?.message || `No se pudo guardar ${file.name}`);
      }
    }
    await this.refresh();
    if (this.role === 'TERMINAL' && saved > 0) {
      void this.flushPendingQueue();
    }
    return { saved, errors };
  }

  public async retryItem(itemId: string): Promise<void> {
    await this.store.updateItemStatus(itemId, {
      syncStatus: 'pending',
      progressPercent: 0,
      errorMessage: undefined
    });
    await this.refresh();
    void this.flushPendingQueue();
  }

  /**
   * Elimina el elemento únicamente de este teléfono (en MÓVIL no borra la copia guardada en CORE).
   */
  public async deleteFromThisPhone(itemId: string): Promise<void> {
    await this.store.deleteItem(itemId);
    await this.refresh();
  }

  public async getItemWithBlob(itemId: string) {
    return this.store.getItem(itemId);
  }

  public async flushPendingQueue(): Promise<void> {
    if (this.isDisposed || this.role !== 'TERMINAL') return;

    if (this.isFlushing) {
      this.flushRequested = true;
      return;
    }

    const snap = this.relayClient.getSnapshot();
    const initialSubPaused = Boolean(snap.subscriptionStatus?.linked && !snap.subscriptionStatus.active);
    if (snap.connectionState !== 'LINKED' || !snap.peerOnline || initialSubPaused) {
      return;
    }

    this.isFlushing = true;
    this.emit();

    try {
      do {
        this.flushRequested = false;
        const all = await this.store.listItems();
        const pending = all
          .filter((item) => item.syncStatus === 'pending' || item.syncStatus === 'sending')
          .sort((a, b) => a.createdAt - b.createdAt);

        for (const summary of pending) {
          if (this.isDisposed) break;
          const live = this.relayClient.getSnapshot();
          const liveSubPaused = Boolean(live.subscriptionStatus?.linked && !live.subscriptionStatus.active);
          if (live.connectionState !== 'LINKED' || !live.peerOnline || liveSubPaused) {
            break;
          }
          await this.sendSingleItemToCore(summary.id);
        }
      } while (this.flushRequested && !this.isDisposed);
    } finally {
      this.isFlushing = false;
      await this.refresh();
    }
  }

  private waitForItemAck(itemId: string, timeoutMs = 20_000) {
    return new Promise<{ ok: boolean; confirmedAt?: number; error?: string }>((resolve) => {
      const existing = this.itemAckWaiters.get(itemId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve({ ok: false, error: 'Reemplazado por nuevo intento.' });
      }
      const timer = setTimeout(() => {
        this.itemAckWaiters.delete(itemId);
        resolve({ ok: false, error: 'VEL CORE no confirmó a tiempo. Se reintentará al conectar.' });
      }, timeoutMs);
      this.itemAckWaiters.set(itemId, { resolve, timer });
    });
  }

  private async sendSingleItemToCore(itemId: string): Promise<void> {
    const record = await this.store.getItem(itemId);
    if (!record) return;

    await this.store.updateItemStatus(itemId, {
      syncStatus: 'sending',
      progressPercent: 5,
      errorMessage: undefined
    });
    await this.refresh();

    if (record.kind === 'note') {
      const ackPromise = this.waitForItemAck(itemId, 15_000);
      const route = await this.relayClient.sendRelayPayload({
        kind: 'note',
        itemId: record.id,
        title: record.title,
        textContent: record.textContent || '',
        createdAt: record.createdAt
      });

      if (!route.routed) {
        const waiter = this.itemAckWaiters.get(itemId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.itemAckWaiters.delete(itemId);
        }
        await this.store.updateItemStatus(itemId, {
          syncStatus: 'pending',
          progressPercent: 0,
          errorMessage: route.error
        });
        return;
      }

      const ack = await ackPromise;
      if (ack.ok) {
        await this.store.updateItemStatus(itemId, {
          syncStatus: 'synced',
          progressPercent: 100,
          syncedAt: ack.confirmedAt || Date.now(),
          errorMessage: undefined
        });
      } else {
        await this.store.updateItemStatus(itemId, {
          syncStatus: 'pending',
          progressPercent: 0,
          errorMessage: ack.error
        });
      }
      return;
    }

    // Envío de archivo binario en bloques de 128 KB
    const blob = record.blob;
    if (!blob) {
      await this.store.updateItemStatus(itemId, {
        syncStatus: 'error',
        errorMessage: 'No se encontró el archivo local en este teléfono.'
      });
      return;
    }

    const totalChunks = Math.max(1, Math.ceil(blob.size / VEL_CHUNK_SIZE_BYTES));

    const startRes = await this.relayClient.sendRelayPayload({
      kind: 'file_start',
      itemId: record.id,
      fileKind: record.kind,
      title: record.title,
      mimeType: record.mimeType,
      sizeBytes: blob.size,
      totalChunks,
      createdAt: record.createdAt
    });

    if (!startRes.routed) {
      await this.store.updateItemStatus(itemId, {
        syncStatus: 'pending',
        progressPercent: 0,
        errorMessage: startRes.error
      });
      return;
    }

    for (let i = 0; i < totalChunks; i++) {
      const start = i * VEL_CHUNK_SIZE_BYTES;
      const end = Math.min(start + VEL_CHUNK_SIZE_BYTES, blob.size);
      const buf = await blob.slice(start, end).arrayBuffer();
      const dataBase64 = arrayBufferToBase64(buf);

      const chunkRes = await this.relayClient.sendRelayPayload(
        {
          kind: 'file_chunk',
          itemId: record.id,
          chunkIndex: i,
          totalChunks,
          dataBase64
        },
        20_000
      );

      if (!chunkRes.routed) {
        await this.store.updateItemStatus(itemId, {
          syncStatus: 'pending',
          progressPercent: 0,
          errorMessage: chunkRes.error
        });
        return;
      }

      const pct = Math.min(95, Math.round(((i + 1) / totalChunks) * 90) + 5);
      await this.store.updateItemStatus(itemId, {
        syncStatus: 'sending',
        progressPercent: pct
      });
      this.items = this.items.map((item) =>
        item.id === itemId ? { ...item, syncStatus: 'sending', progressPercent: pct } : item
      );
      this.emit();
    }

    const ackPromise = this.waitForItemAck(itemId, 25_000);
    const endRes = await this.relayClient.sendRelayPayload({
      kind: 'file_end',
      itemId: record.id,
      totalChunks,
      sizeBytes: blob.size
    });

    if (!endRes.routed) {
      const waiter = this.itemAckWaiters.get(itemId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.itemAckWaiters.delete(itemId);
      }
      await this.store.updateItemStatus(itemId, {
        syncStatus: 'pending',
        progressPercent: 0,
        errorMessage: endRes.error
      });
      return;
    }

    const ack = await ackPromise;
    if (ack.ok) {
      await this.store.updateItemStatus(itemId, {
        syncStatus: 'synced',
        progressPercent: 100,
        syncedAt: ack.confirmedAt || Date.now(),
        errorMessage: undefined
      });
    } else {
      await this.store.updateItemStatus(itemId, {
        syncStatus: 'pending',
        progressPercent: 0,
        errorMessage: ack.error
      });
    }
  }

  private async handleIncomingRelayData(senderId: string, payload: RelayDataPayload): Promise<void> {
    if (payload.kind === 'item_ack') {
      const waiter = this.itemAckWaiters.get(payload.itemId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.itemAckWaiters.delete(payload.itemId);
        waiter.resolve({
          ok: payload.ok,
          confirmedAt: payload.confirmedAt,
          error: payload.error
        });
      }
      return;
    }

    // Serializar paquetes por itemId en CORE para que los fragmentos lleguen en orden exacto
    const itemId = payload.itemId;
    const prev = this.incomingQueue.get(itemId) || Promise.resolve();
    const next = prev
      .then(() => this.processCoreIncomingPayload(senderId, payload))
      .catch(() => {});
    this.incomingQueue.set(itemId, next);
    await next;
  }

  private async processCoreIncomingPayload(senderId: string, payload: RelayDataPayload): Promise<void> {
    if (this.isDisposed) return;

    if (payload.kind === 'note') {
      try {
        await this.store.saveNote('CORE', payload.title, payload.textContent, {
          id: payload.itemId,
          sourceDeviceId: senderId,
          syncStatus: 'synced',
          createdAt: payload.createdAt
        });
        await this.refresh();
        await this.relayClient.sendRelayPayload({
          kind: 'item_ack',
          itemId: payload.itemId,
          ok: true,
          confirmedAt: Date.now()
        });
      } catch (err: any) {
        await this.relayClient.sendRelayPayload({
          kind: 'item_ack',
          itemId: payload.itemId,
          ok: false,
          confirmedAt: Date.now(),
          error: err?.message || 'No se pudo guardar la nota en VEL CORE.'
        });
      }
      return;
    }

    if (payload.kind === 'file_start') {
      await this.store.cleanupIncomingChunks(payload.itemId);
      this.incomingSessions.set(payload.itemId, {
        itemId: payload.itemId,
        title: payload.title,
        fileKind: payload.fileKind,
        mimeType: payload.mimeType,
        sizeBytes: payload.sizeBytes,
        totalChunks: payload.totalChunks,
        receivedChunks: 0,
        sourceDeviceId: senderId,
        createdAt: payload.createdAt
      });
      this.emit();
      return;
    }

    if (payload.kind === 'file_chunk') {
      const session = this.incomingSessions.get(payload.itemId);
      if (!session) return;
      const bytes = base64ToUint8Array(payload.dataBase64);
      await this.store.stageIncomingChunk(payload.itemId, payload.chunkIndex, toExactArrayBuffer(bytes));
      session.receivedChunks += 1;
      this.emit();
      return;
    }

    if (payload.kind === 'file_end') {
      const session = this.incomingSessions.get(payload.itemId);
      try {
        if (!session) {
          // Si ya existía completo de un intento previo idempotente
          const existing = await this.store.getItem(payload.itemId);
          if (existing) {
            await this.relayClient.sendRelayPayload({
              kind: 'item_ack',
              itemId: payload.itemId,
              ok: true,
              confirmedAt: Date.now()
            });
          }
          return;
        }

        await this.store.finalizeIncomingFile({
          itemId: session.itemId,
          title: session.title,
          fileKind: session.fileKind,
          mimeType: session.mimeType,
          sizeBytes: payload.sizeBytes,
          totalChunks: payload.totalChunks,
          sourceDeviceId: session.sourceDeviceId,
          createdAt: session.createdAt
        });

        this.incomingSessions.delete(payload.itemId);
        await this.refresh();

        await this.relayClient.sendRelayPayload({
          kind: 'item_ack',
          itemId: payload.itemId,
          ok: true,
          confirmedAt: Date.now()
        });
      } catch (err: any) {
        this.incomingSessions.delete(payload.itemId);
        await this.store.cleanupIncomingChunks(payload.itemId);
        this.emit();
        await this.relayClient.sendRelayPayload({
          kind: 'item_ack',
          itemId: payload.itemId,
          ok: false,
          confirmedAt: Date.now(),
          error: err?.message || 'Error guardando el archivo en VEL CORE.'
        });
      }
    }
  }
}
