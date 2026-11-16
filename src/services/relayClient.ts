import {
  AuthorizationRecord,
  DeviceIdentitySummary,
  DeviceLinkRecord,
  OperationTrackingRecord,
  PairingSessionContract,
  RelayClientContract,
  RelayConfirmationEnvelope,
  RelayConnectionState,
  RelayEncryptedEnvelope,
  RevocationStatus
} from '../contracts/velContracts';
import {
  computePairingSasCode,
  decryptE2EEBytes,
  decryptE2EEPayload,
  deriveSharedE2EESessionKey,
  E2EEBinaryAadMetadata,
  encryptE2EEBytes,
  encryptE2EEPayload,
  generateEphemeralPairingCode,
  signRelayAuthChallenge
} from '../crypto/e2eeSession';
import { velDb, VelStorageAdapter } from '../db/db';
import { getFreshDeviceAuthToken } from './firebase';

export interface DecryptedIncomingMessage {
  operationId: string;
  senderId: string;
  text: string;
  timestamp: number;
  integrityVerified: boolean;
}

export interface RelayClientSnapshot {
  connectionState: RelayConnectionState;
  peerOnline: boolean;
  identity: DeviceIdentitySummary | null;
  pairingSession: PairingSessionContract | null;
  operations: OperationTrackingRecord[];
  receivedMessages: DecryptedIncomingMessage[];
  lastError: string | null;
  lastRevocationMessage: string | null;
  revocationStatus: RevocationStatus;
  revocationDetail: string | null;
}

export interface VelRelayClientOptions {
  storage?: VelStorageAdapter;
  getFirebaseIdToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  WebSocketImpl?: any;
  operationAckTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

export interface SendMessageOutcome {
  accepted: boolean;
  operationId: string;
  error?: string;
}

export interface RevokeOutcome {
  success: boolean;
  persistedInFirestore: boolean;
  disconnectedLive: boolean;
  error?: string;
}

export type BinaryFileEnvelopePurpose = NonNullable<E2EEBinaryAadMetadata['purpose']>;

export interface IncomingBinaryFilePacket {
  operationId: string;
  senderId: string;
  recipientId: string;
  sessionId: string;
  timestamp: number;
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
  purpose: BinaryFileEnvelopePurpose;
  plaintextBytes: Uint8Array;
}

export type BinaryFilePacketHandler = (packet: IncomingBinaryFilePacket) => Promise<boolean>;

export interface BinaryFileEnvelopeSendResult {
  confirmed: boolean;
  operationId: string;
  reason?: string;
  error?: string;
}

const FILE_CHANNEL_OP_PREFIX = 'VELF|';
const MAX_SEEN_INCOMING_OP_IDS = 4000;

export function buildBinaryFileOperationId(
  purpose: BinaryFileEnvelopePurpose,
  fileId: string,
  chunkIndex: number,
  totalChunks: number
): string {
  const code = purpose === 'FILE_CHUNK' ? 'C' : purpose === 'FILE_MANIFEST' ? 'M' : 'K';
  const nonce = createRandomUuid().replace(/-/g, '').slice(0, 12);
  return `${FILE_CHANNEL_OP_PREFIX}${code}|${fileId}|${chunkIndex}|${totalChunks}|${nonce}`;
}

export function parseBinaryFileOperationId(operationId: string): {
  purpose: BinaryFileEnvelopePurpose;
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
} | null {
  if (!operationId.startsWith(FILE_CHANNEL_OP_PREFIX)) {
    return null;
  }
  const parts = operationId.split('|');
  if (parts.length !== 6) {
    return null;
  }
  const [, code, fileId, idxStr, totalStr, nonce] = parts;
  if (!fileId || !nonce) return null;
  const purpose: BinaryFileEnvelopePurpose | null =
    code === 'C' ? 'FILE_CHUNK' : code === 'M' ? 'FILE_MANIFEST' : code === 'K' ? 'FILE_CONTROL' : null;
  if (!purpose) return null;
  const chunkIndex = Number(idxStr);
  const totalChunks = Number(totalStr);
  if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) || totalChunks < 1 || chunkIndex < 0 || chunkIndex >= totalChunks) {
    return null;
  }
  return { purpose, fileId, chunkIndex, totalChunks };
}

function createRandomUuid(): string {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function resolveBoundFetch(customFetch?: typeof fetch): typeof fetch {
  if (!customFetch || (typeof globalThis !== 'undefined' && customFetch === globalThis.fetch)) {
    return (...args: Parameters<typeof fetch>) => globalThis.fetch(...args);
  }
  return (...args: Parameters<typeof fetch>) => customFetch(...args);
}

export class VelRelayClient implements RelayClientContract {
  private storage: VelStorageAdapter;
  private tokenProvider: () => Promise<string | null>;
  private fetchFn: typeof fetch;
  private WebSocketCtor: any;
  private operationAckTimeoutMs: number;
  private reconnectBaseDelayMs: number;
  private reconnectMaxDelayMs: number;

  private ws: any = null;
  private wssUrl: string | null = null;
  private state: RelayConnectionState = 'DISCONNECTED';
  private peerOnline = false;
  private manualDisconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private currentIdentity: DeviceIdentitySummary | null = null;
  private sessionKey: CryptoKey | null = null;
  private pairingSession: PairingSessionContract | null = null;
  private operations: OperationTrackingRecord[] = [];
  private receivedMessages: DecryptedIncomingMessage[] = [];
  private seenIncomingOperationIds = new Set<string>();
  private ackTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private lastError: string | null = null;
  private lastRevocationMessage: string | null = null;
  private revocationStatus: RevocationStatus = 'NONE';
  private revocationDetail: string | null = null;
  private isConnectingGuard = false;
  private pendingRevokeResolver: ((res: RevokeOutcome) => void) | null = null;
  private filePacketHandler: BinaryFilePacketHandler | null = null;
  private pendingFileAckWaiters = new Map<
    string,
    { resolve: (res: BinaryFileEnvelopeSendResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private connectionLostListeners = new Set<(reason: string) => void>();

  private stateListeners = new Set<(state: RelayConnectionState) => void>();
  private snapshotListeners = new Set<(snapshot: RelayClientSnapshot) => void>();

  constructor(options: VelRelayClientOptions = {}) {
    this.storage = options.storage || velDb;
    this.tokenProvider = options.getFirebaseIdToken || getFreshDeviceAuthToken;
    this.fetchFn = resolveBoundFetch(options.fetchFn);
    this.WebSocketCtor = options.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.operationAckTimeoutMs = options.operationAckTimeoutMs ?? 10_000;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
  }

  public getState(): RelayConnectionState {
    return this.state;
  }

  public getSnapshot(): RelayClientSnapshot {
    return {
      connectionState: this.state,
      peerOnline: this.peerOnline,
      identity: this.currentIdentity ? { ...this.currentIdentity } : null,
      pairingSession: this.pairingSession ? { ...this.pairingSession } : null,
      operations: this.operations.map((o) => ({ ...o })),
      receivedMessages: this.receivedMessages.map((m) => ({ ...m })),
      lastError: this.lastError,
      lastRevocationMessage: this.lastRevocationMessage,
      revocationStatus: this.revocationStatus,
      revocationDetail: this.revocationDetail
    };
  }

  public clearReceivedMessages(): void {
    this.receivedMessages = [];
    this.emit();
  }

  public onStateChange(listener: (state: RelayConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  public subscribe(listener: (snapshot: RelayClientSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    listener(this.getSnapshot());
    return () => this.snapshotListeners.delete(listener);
  }

  private emit() {
    const snap = this.getSnapshot();
    for (const l of this.stateListeners) {
      l(this.state);
    }
    for (const l of this.snapshotListeners) {
      l(snap);
    }
  }

  private setState(next: RelayConnectionState) {
    this.state = next;
    this.emit();
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearAllAckTimers() {
    for (const timer of this.ackTimers.values()) {
      clearTimeout(timer);
    }
    this.ackTimers.clear();
  }

  private recordSeenIncomingOperationId(operationId: string): void {
    this.seenIncomingOperationIds.add(operationId);
    if (this.seenIncomingOperationIds.size > MAX_SEEN_INCOMING_OP_IDS) {
      const excess = this.seenIncomingOperationIds.size - MAX_SEEN_INCOMING_OP_IDS;
      let removed = 0;
      for (const key of this.seenIncomingOperationIds) {
        this.seenIncomingOperationIds.delete(key);
        removed++;
        if (removed >= excess) break;
      }
    }
  }

  private abortPendingFileTransfers(reason: string): void {
    for (const [opId, waiter] of this.pendingFileAckWaiters.entries()) {
      clearTimeout(waiter.timer);
      this.pendingFileAckWaiters.delete(opId);
      waiter.resolve({
        confirmed: false,
        operationId: opId,
        reason,
        error: `Transferencia interrumpida (${reason}).`
      });
    }
    for (const listener of this.connectionLostListeners) {
      try {
        listener(reason);
      } catch {
        // Ignorar errores de listeners
      }
    }
  }

  public setFilePacketHandler(handler: BinaryFilePacketHandler | null): void {
    this.filePacketHandler = handler;
  }

  public onConnectionLost(listener: (reason: string) => void): () => void {
    this.connectionLostListeners.add(listener);
    return () => this.connectionLostListeners.delete(listener);
  }

  public connect(wssUrl: string, firebaseIdTokenProvider?: () => Promise<string | null>): void {
    const cleanUrl = wssUrl.trim();
    if (firebaseIdTokenProvider) {
      this.tokenProvider = firebaseIdTokenProvider;
    }
    if (
      this.wssUrl === cleanUrl &&
      (this.isConnectingGuard ||
        (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)))
    ) {
      // Evita duplicar conexiones WebSocket activas o en curso hacia el mismo Relay
      return;
    }
    this.wssUrl = cleanUrl;
    this.manualDisconnect = false;
    this.clearReconnectTimer();
    void this.openConnection();
  }

  private async openConnection() {
    if (this.isConnectingGuard) return;
    this.isConnectingGuard = true;
    try {
      if (!this.wssUrl) {
        this.lastError = 'No hay URL WSS configurada para el servidor Relay.';
        this.setState('ERROR');
        return;
      }

      if (!this.WebSocketCtor) {
        this.lastError = 'WebSocket no disponible en este entorno.';
        this.setState('ERROR');
        return;
      }

      const local = await this.storage.getIdentity();
      if (!local) {
        this.lastError = 'Identidad técnica local no inicializada.';
        this.setState('DISCONNECTED');
        return;
      }

      this.currentIdentity = {
        deviceId: local.deviceId,
        role: local.role,
        fingerprint: local.fingerprint,
        publicKeySpkiBase64: local.publicKeySpkiBase64,
        signingPublicKeySpkiBase64: local.signingPublicKeySpkiBase64,
        firebaseAuthUid: local.firebaseAuthUid,
        registrationStatus: local.registrationStatus,
        activeLinkId: local.activeLinkId,
        pairedPeerDeviceId: local.pairedPeerDeviceId,
        lastServerError: local.lastServerError,
        createdAt: local.createdAt,
        updatedAt: local.updatedAt
      };

      if (local.registrationStatus === 'revoked') {
        this.sessionKey = null;
        this.receivedMessages = [];
        this.lastRevocationMessage = 'Esta identidad técnica fue revocada.';
        this.setState('REVOKED');
        return;
      }

      if (local.registrationStatus === 'pending_local') {
        this.lastError = 'El dispositivo aún no completó su registro en Firestore.';
        this.setState('DISCONNECTED');
        return;
      }

      this.closeActiveSocketSilently();
      this.lastError = null;
      this.setState(this.reconnectAttempts > 0 ? 'RECONNECTING' : 'CONNECTING');

      const socket = new this.WebSocketCtor(this.wssUrl);
      this.ws = socket;

      const attachHandler = (eventName: string, fn: (...args: any[]) => void) => {
        if (typeof socket.addEventListener === 'function') {
          socket.addEventListener(eventName, fn);
        } else if (typeof socket.on === 'function') {
          socket.on(eventName, fn);
        }
      };

      attachHandler('open', () => {
        if (this.ws !== socket) return;
        this.setState('CONNECTED_UNAUTHENTICATED');
      });

      attachHandler('message', (evtOrData: any) => {
        if (this.ws !== socket) return;
        const raw =
          evtOrData && typeof evtOrData === 'object' && 'data' in evtOrData
            ? evtOrData.data
            : evtOrData;
        const text = typeof raw === 'string' ? raw : raw?.toString?.('utf8') || '';
        if (!text) return;
        try {
          const msg = JSON.parse(text);
          void this.handleServerMessage(msg);
        } catch {
          this.lastError = 'Mensaje JSON inválido recibido desde el Relay.';
          this.emit();
        }
      });

      attachHandler('error', () => {
        if (this.ws !== socket) return;
        if (this.state !== 'REVOKED') {
          this.lastError = 'Error de transporte WebSocket con el servidor Relay.';
          this.emit();
        }
      });

      attachHandler('close', (evtOrCode: any) => {
        if (this.ws !== socket) return;
        const code =
          typeof evtOrCode === 'number'
            ? evtOrCode
            : typeof evtOrCode?.code === 'number'
            ? evtOrCode.code
            : 1000;

        this.ws = null;
        this.peerOnline = false;
        this.abortPendingFileTransfers(code === 4003 ? 'DEVICE_REVOKED' : 'RELAY_DISCONNECTED');

        if (this.manualDisconnect) {
          this.setState('DISCONNECTED');
          return;
        }

        if (this.state === 'REVOKED') {
          this.receivedMessages = [];
          return;
        }

        if (code === 4003 && this.state !== 'ERROR') {
          this.receivedMessages = [];
          this.setState('REVOKED');
          return;
        }

        if (code === 4503 || code === 4001 || (code === 4003 && this.state === 'ERROR')) {
          this.setState('ERROR');
          return;
        }

        if (code === 4009) {
          this.lastError = 'Sesión reemplazada por una nueva conexión activa de este mismo dispositivo.';
          this.setState('DISCONNECTED');
          return;
        }

        this.scheduleReconnect();
      });
    } finally {
      this.isConnectingGuard = false;
    }
  }

  private scheduleReconnect() {
    this.clearReconnectTimer();
    if (this.manualDisconnect || !this.wssUrl || this.state === 'REVOKED') {
      return;
    }

    const delay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * Math.pow(2, Math.min(this.reconnectAttempts, 5))
    );
    this.reconnectAttempts += 1;
    this.setState('RECONNECTING');

    this.reconnectTimer = setTimeout(() => {
      void this.openConnection();
    }, delay);
  }

  private closeActiveSocketSilently() {
    if (!this.ws) return;
    const oldWs = this.ws;
    this.ws = null;
    try {
      oldWs.close(1000, 'Reconnecting');
    } catch {}
  }

  public disconnect(): void {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.clearAllAckTimers();
    this.abortPendingFileTransfers('MANUAL_DISCONNECT');
    this.peerOnline = false;
    this.sessionKey = null;
    this.receivedMessages = [];
    if (this.ws) {
      const target = this.ws;
      this.ws = null;
      try {
        target.close(1000, 'Client disconnect');
      } catch {}
    }
    this.setState('DISCONNECTED');
  }

  private sendRaw(payload: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== 1) {
      return false;
    }
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  private async handleServerMessage(msg: Record<string, any>) {
    switch (msg.type) {
      case 'AUTH_CHALLENGE': {
        this.setState('AUTHENTICATING');
        const local = await this.storage.getIdentity();
        if (!local) {
          this.lastError = 'Identidad local ausente durante autenticación.';
          this.setState('ERROR');
          return;
        }
        let firebaseIdToken: string | null = null;
        try {
          firebaseIdToken = await this.tokenProvider();
        } catch (err: any) {
          this.lastError = err?.message || 'Error obteniendo el ID Token de Firebase para autenticar el Relay.';
          this.setState('ERROR');
          return;
        }
        if (!firebaseIdToken) {
          this.lastError = 'No se pudo obtener el ID Token de Firebase para autenticar el Relay.';
          this.setState('ERROR');
          return;
        }
        const timestamp = Date.now();
        const challenge = String(msg.challenge || '');
        const signatureBase64 = await signRelayAuthChallenge(
          local.privateSigningKey,
          challenge,
          local.deviceId,
          timestamp
        );

        this.sendRaw({
          type: 'AUTH',
          deviceId: local.deviceId,
          role: local.role,
          fingerprint: local.fingerprint,
          pairedCoreId: local.role === 'TERMINAL' ? local.pairedPeerDeviceId : null,
          firebaseIdToken,
          challenge,
          signatureBase64,
          timestamp
        });
        return;
      }

      case 'AUTH_SUCCESS': {
        this.reconnectAttempts = 0;
        this.lastError = null;
        this.peerOnline = Boolean(msg.peerOnline);

        const local = await this.storage.getIdentity();
        if (!local) return;

        const nextLinkId = (msg.activeLinkId as string | null) ?? null;
        const nextPeerId = (msg.pairedPeerDeviceId as string | null) ?? null;

        const updatedLocal = {
          ...local,
          registrationStatus: nextLinkId ? ('paired' as const) : ('registered' as const),
          activeLinkId: nextLinkId,
          pairedPeerDeviceId: nextPeerId,
          updatedAt: new Date().toISOString()
        };
        await this.storage.saveIdentity(updatedLocal);
        this.syncSummaryFromLocal(updatedLocal);

        if (nextLinkId && nextPeerId) {
          let linkRecord: DeviceLinkRecord | null = await this.storage.getLink(nextLinkId);
          if (msg.link && msg.link.corePublicKeySpkiBase64 && msg.link.terminalPublicKeySpkiBase64) {
            linkRecord = {
              linkId: nextLinkId,
              coreDeviceId: msg.link.coreDeviceId,
              terminalDeviceId: msg.link.terminalDeviceId,
              coreAuthUid: local.role === 'CORE' ? (local.firebaseAuthUid || '') : '',
              terminalAuthUid: local.role === 'TERMINAL' ? (local.firebaseAuthUid || '') : '',
              coreFingerprint: msg.link.coreFingerprint,
              terminalFingerprint: msg.link.terminalFingerprint,
              corePublicKeySpkiBase64: msg.link.corePublicKeySpkiBase64,
              terminalPublicKeySpkiBase64: msg.link.terminalPublicKeySpkiBase64,
              status: 'active',
              sasVerified: true,
              createdAt: linkRecord?.createdAt || new Date().toISOString(),
              activatedAt: linkRecord?.activatedAt || new Date().toISOString(),
              revokedAt: null,
              revokedByDeviceId: null,
              revocationReason: null
            };
            await this.storage.saveLink(linkRecord);
          }

          const peerSpki =
            local.role === 'CORE'
              ? linkRecord?.terminalPublicKeySpkiBase64
              : linkRecord?.corePublicKeySpkiBase64;

          if (peerSpki && linkRecord) {
            this.sessionKey = await deriveSharedE2EESessionKey({
              localPrivateEcdhKey: local.privateEcdhKey,
              peerPublicKeySpkiBase64: peerSpki,
              linkId: linkRecord.linkId,
              coreDeviceId: linkRecord.coreDeviceId,
              terminalDeviceId: linkRecord.terminalDeviceId
            });
            this.setState('LINKED');
            return;
          }
        }

        this.sessionKey = null;
        this.setState('AUTHENTICATED');
        return;
      }

      case 'AUTH_ERROR': {
        const errCode = String(msg.error || '');
        this.lastError = String(msg.message || errCode || 'Error de autenticación en Relay.');
        if (errCode === 'DEVICE_REVOKED') {
          this.sessionKey = null;
          this.lastRevocationMessage = this.lastError;
          const local = await this.storage.getIdentity();
          if (local) {
            await this.storage.saveIdentity({
              ...local,
              registrationStatus: 'revoked',
              activeLinkId: null,
              pairedPeerDeviceId: null,
              updatedAt: new Date().toISOString()
            });
            this.syncSummaryFromLocal({
              ...local,
              registrationStatus: 'revoked',
              activeLinkId: null,
              pairedPeerDeviceId: null
            });
          }
          this.setState('REVOKED');
          return;
        }
        this.setState('ERROR');
        return;
      }

      case 'PEER_STATUS': {
        if (
          this.currentIdentity?.pairedPeerDeviceId &&
          msg.peerDeviceId === this.currentIdentity.pairedPeerDeviceId
        ) {
          this.peerOnline = Boolean(msg.online);
          if (!this.peerOnline) {
            this.abortPendingFileTransfers('RECIPIENT_OFFLINE');
          }
          this.emit();
        }
        return;
      }

      case 'PAIRING_OFFER_REGISTERED': {
        if (this.pairingSession && this.pairingSession.code === msg.code) {
          this.pairingSession = {
            ...this.pairingSession,
            linkId: msg.linkId,
            expiresAt: msg.expiresAt,
            stage: 'OFFERING'
          };
          this.emit();
        }
        return;
      }

      case 'PAIRING_OFFER_FOUND':
      case 'PAIRING_CLAIM_RECEIVED': {
        const local = await this.storage.getIdentity();
        if (!local) return;

        const isCore = local.role === 'CORE';
        const coreDeviceId = isCore ? local.deviceId : String(msg.peerDeviceId);
        const terminalDeviceId = isCore ? String(msg.peerDeviceId) : local.deviceId;
        const corePub = isCore ? local.publicKeySpkiBase64 : String(msg.peerPublicKeyBase64);
        const termPub = isCore ? String(msg.peerPublicKeyBase64) : local.publicKeySpkiBase64;
        const cleanCode = String(msg.code || this.pairingSession?.code || '').toUpperCase();

        const sasCode = await computePairingSasCode({
          pairingCode: cleanCode,
          coreDeviceId,
          terminalDeviceId,
          corePublicKeySpkiBase64: corePub,
          terminalPublicKeySpkiBase64: termPub
        });

        this.pairingSession = {
          code: cleanCode,
          linkId: String(msg.linkId || ''),
          initiatorDeviceId: coreDeviceId,
          initiatorRole: 'CORE',
          initiatorFingerprint: isCore ? local.fingerprint : String(msg.peerFingerprint || ''),
          initiatorPublicKeyBase64: corePub,
          peerDeviceId: String(msg.peerDeviceId),
          peerRole: msg.peerRole,
          peerFingerprint: String(msg.peerFingerprint || ''),
          peerPublicKeyBase64: String(msg.peerPublicKeyBase64 || ''),
          sasCode,
          localConfirmedSas: false,
          peerConfirmedSas: false,
          stage: 'SAS_PENDING',
          expiresAt: Number(msg.expiresAt || Date.now() + 300_000)
        };
        this.emit();
        return;
      }

      case 'PAIRING_AWAITING_PEER': {
        if (this.pairingSession && this.pairingSession.code === String(msg.code || '').toUpperCase()) {
          const localRole = this.currentIdentity?.role;
          const localDone =
            localRole === 'CORE' ? Boolean(msg.coreConfirmed) : Boolean(msg.terminalConfirmed);
          const peerDone =
            localRole === 'CORE' ? Boolean(msg.terminalConfirmed) : Boolean(msg.coreConfirmed);
          this.pairingSession = {
            ...this.pairingSession,
            localConfirmedSas: localDone,
            peerConfirmedSas: peerDone,
            stage: localDone ? 'SAS_AWAITING_PEER' : 'SAS_PENDING'
          };
          this.emit();
        }
        return;
      }

      case 'PAIRING_CONFIRMED': {
        const local = await this.storage.getIdentity();
        if (!local) return;
        const link = msg.link as DeviceLinkRecord;
        const authorization = msg.authorization as AuthorizationRecord;
        if (!link) return;

        await this.storage.saveLink(link);
        if (authorization) {
          await this.storage.saveAuthorization(authorization);
        }

        const peerId = local.role === 'CORE' ? link.terminalDeviceId : link.coreDeviceId;
        const peerPub =
          local.role === 'CORE'
            ? link.terminalPublicKeySpkiBase64
            : link.corePublicKeySpkiBase64;

        const updatedLocal = {
          ...local,
          registrationStatus: 'paired' as const,
          activeLinkId: link.linkId,
          pairedPeerDeviceId: peerId,
          updatedAt: new Date().toISOString()
        };
        await this.storage.saveIdentity(updatedLocal);
        this.syncSummaryFromLocal(updatedLocal);

        if (peerPub) {
          this.sessionKey = await deriveSharedE2EESessionKey({
            localPrivateEcdhKey: local.privateEcdhKey,
            peerPublicKeySpkiBase64: peerPub,
            linkId: link.linkId,
            coreDeviceId: link.coreDeviceId,
            terminalDeviceId: link.terminalDeviceId
          });
        }

        if (this.pairingSession) {
          this.pairingSession = {
            ...this.pairingSession,
            localConfirmedSas: true,
            peerConfirmedSas: true,
            stage: 'CONFIRMED'
          };
        }
        this.revocationStatus = 'NONE';
        this.revocationDetail = null;
        this.peerOnline = true;
        this.lastError = null;
        this.setState('LINKED');
        return;
      }

      case 'PAIRING_CANCELLED':
      case 'PAIRING_ERROR': {
        this.lastError = String(msg.message || msg.error || 'Emparejamiento cancelado o fallido.');
        if (this.pairingSession) {
          this.pairingSession = {
            ...this.pairingSession,
            stage: msg.error === 'OFFER_EXPIRED' ? 'EXPIRED' : 'CANCELLED'
          };
        }
        this.emit();
        return;
      }

      case 'MESSAGE_ROUTED': {
        const opId = String(msg.operationId || '');
        const op = this.operations.find((o) => o.operationId === opId);
        if (op && op.status === 'SENDING') {
          op.status = 'ROUTED_AWAITING_ACK';
          op.statusDetail = 'Enrutado por Relay (esperando descifrado y confirmación del destinatario)';
          op.updatedAt = Date.now();
          this.emit();
        }
        return;
      }

      case 'DELIVERY_FAILED': {
        const opId = String(msg.operationId || '');
        this.clearAckTimer(opId);
        const fileWaiter = this.pendingFileAckWaiters.get(opId);
        if (fileWaiter) {
          clearTimeout(fileWaiter.timer);
          this.pendingFileAckWaiters.delete(opId);
          if (msg.reason === 'RECIPIENT_OFFLINE') {
            this.peerOnline = false;
          }
          fileWaiter.resolve({
            confirmed: false,
            operationId: opId,
            reason: String(msg.reason || 'DELIVERY_FAILED'),
            error: String(msg.message || 'Entrega fallida: destinatario sin conexión.')
          });
          this.emit();
          return;
        }
        const op = this.operations.find((o) => o.operationId === opId);
        if (op) {
          op.status = 'FAILED';
          op.errorReason = String(msg.reason || 'DELIVERY_FAILED');
          op.statusDetail = String(msg.message || 'Entrega fallida: destinatario sin conexión.');
          op.updatedAt = Date.now();
          if (msg.reason === 'RECIPIENT_OFFLINE') {
            this.peerOnline = false;
          }
          this.emit();
        }
        return;
      }

      case 'ENCRYPTED_MESSAGE': {
        const senderId = String(msg.senderId || '');
        const recipientId = String(msg.recipientId || '');
        const sessionId = String(msg.sessionId || '');
        const operationId = String(msg.operationId || '');
        const iv = String(msg.iv || '');
        const ciphertext = String(msg.ciphertext || '');
        const timestamp = Number(msg.timestamp || 0);

        if (!operationId || this.seenIncomingOperationIds.has(operationId)) {
          // Protección anti-replay: ignorar duplicado
          return;
        }
        this.recordSeenIncomingOperationId(operationId);

        if (
          !this.sessionKey ||
          !this.currentIdentity ||
          recipientId !== this.currentIdentity.deviceId ||
          senderId !== this.currentIdentity.pairedPeerDeviceId ||
          sessionId !== this.currentIdentity.activeLinkId
        ) {
          this.sendConfirmation({
            type: 'CONFIRMATION',
            senderId: this.currentIdentity?.deviceId || recipientId,
            recipientId: senderId,
            operationId,
            status: 'REJECTED',
            timestamp: Date.now()
          });
          return;
        }

        // Canal binario cifrado de archivos (Etapa 2): NO contamina receivedMessages ni confirma antes de persistir
        const fileOpMeta = parseBinaryFileOperationId(operationId);
        if (fileOpMeta) {
          try {
            const plaintextBytes = await decryptE2EEBytes(this.sessionKey, iv, ciphertext, {
              sessionId,
              senderId,
              recipientId,
              operationId,
              timestamp,
              fileId: fileOpMeta.fileId,
              chunkIndex: fileOpMeta.chunkIndex,
              totalChunks: fileOpMeta.totalChunks,
              purpose: fileOpMeta.purpose
            });

            if (!this.filePacketHandler) {
              this.sendConfirmation({
                type: 'CONFIRMATION',
                senderId: this.currentIdentity.deviceId,
                recipientId: senderId,
                operationId,
                status: 'REJECTED',
                timestamp: Date.now()
              });
              return;
            }

            const accepted = await this.filePacketHandler({
              operationId,
              senderId,
              recipientId,
              sessionId,
              timestamp,
              fileId: fileOpMeta.fileId,
              chunkIndex: fileOpMeta.chunkIndex,
              totalChunks: fileOpMeta.totalChunks,
              purpose: fileOpMeta.purpose,
              plaintextBytes
            });

            this.sendConfirmation({
              type: 'CONFIRMATION',
              senderId: this.currentIdentity.deviceId,
              recipientId: senderId,
              operationId,
              status: accepted ? 'CONFIRMED' : 'REJECTED',
              timestamp: Date.now()
            });
          } catch {
            this.sendConfirmation({
              type: 'CONFIRMATION',
              senderId: this.currentIdentity.deviceId,
              recipientId: senderId,
              operationId,
              status: 'REJECTED',
              timestamp: Date.now()
            });
          }
          return;
        }

        try {
          const plaintext = await decryptE2EEPayload(this.sessionKey, iv, ciphertext, {
            sessionId,
            senderId,
            recipientId,
            operationId,
            timestamp
          });

          this.receivedMessages.unshift({
            operationId,
            senderId,
            text: plaintext,
            timestamp,
            integrityVerified: true
          });
          if (this.receivedMessages.length > 25) {
            this.receivedMessages.length = 25;
          }

          this.operations.unshift({
            operationId,
            direction: 'INCOMING',
            senderId,
            previewLabel: 'Mensaje E2EE descifrado y verificado',
            status: 'CONFIRMED',
            statusDetail: 'Integridad AEAD validada; confirmación enviada al remitente.',
            createdAt: timestamp || Date.now(),
            updatedAt: Date.now(),
            confirmedAt: Date.now()
          });
          if (this.operations.length > 30) {
            this.operations.length = 30;
          }

          this.sendConfirmation({
            type: 'CONFIRMATION',
            senderId: this.currentIdentity.deviceId,
            recipientId: senderId,
            operationId,
            status: 'CONFIRMED',
            timestamp: Date.now()
          });
          this.emit();
        } catch {
          this.operations.unshift({
            operationId,
            direction: 'INCOMING',
            senderId,
            previewLabel: 'Sobre cifrado rechazado por fallo de integridad',
            status: 'FAILED',
            statusDetail: 'Fallo de etiqueta AEAD o metadatos alterados (descartado).',
            createdAt: timestamp || Date.now(),
            updatedAt: Date.now(),
            errorReason: 'INTEGRITY_FAILED'
          });

          this.sendConfirmation({
            type: 'CONFIRMATION',
            senderId: this.currentIdentity.deviceId,
            recipientId: senderId,
            operationId,
            status: 'REJECTED',
            timestamp: Date.now()
          });
          this.emit();
        }
        return;
      }

      case 'CONFIRMATION': {
        const opId = String(msg.operationId || '');
        this.clearAckTimer(opId);
        const fileWaiter = this.pendingFileAckWaiters.get(opId);
        if (fileWaiter) {
          clearTimeout(fileWaiter.timer);
          this.pendingFileAckWaiters.delete(opId);
          if (msg.status === 'REJECTED') {
            fileWaiter.resolve({
              confirmed: false,
              operationId: opId,
              reason: 'RECIPIENT_REJECTED',
              error: 'El dispositivo destinatario rechazó el bloque o su integridad.'
            });
          } else {
            fileWaiter.resolve({
              confirmed: true,
              operationId: opId
            });
          }
          return;
        }
        const op = this.operations.find((o) => o.operationId === opId && o.direction === 'OUTGOING');
        if (op) {
          if (msg.status === 'REJECTED') {
            op.status = 'FAILED';
            op.errorReason = 'RECIPIENT_REJECTED';
            op.statusDetail = 'El destinatario rechazó el sobre por integridad inválida.';
          } else {
            op.status = 'CONFIRMED';
            op.confirmedAt = Date.now();
            op.statusDetail = 'Recibido, descifrado y confirmado por el destinatario.';
          }
          op.updatedAt = Date.now();
          this.emit();
        }
        return;
      }

      case 'REVOCATION_NOTICE': {
        this.sessionKey = null;
        this.receivedMessages = [];
        this.peerOnline = false;
        this.clearReconnectTimer();
        this.abortPendingFileTransfers('DEVICE_REVOKED');
        this.lastRevocationMessage = String(
          msg.message || 'Tu autorización fue revocada permanentemente por VEL CORE.'
        );
        const local = await this.storage.getIdentity();
        if (local) {
          const updated = {
            ...local,
            registrationStatus: 'revoked' as const,
            activeLinkId: null,
            pairedPeerDeviceId: null,
            updatedAt: new Date().toISOString()
          };
          await this.storage.saveIdentity(updated);
          this.syncSummaryFromLocal(updated);
        }
        this.setState('REVOKED');
        return;
      }

      case 'REVOCATION_CONFIRMED': {
        this.sessionKey = null;
        this.peerOnline = false;
        const persistedInFirestore = Boolean(msg.persistedInFirestore);
        const disconnectedLive = Boolean(msg.disconnectedLive);

        const local = await this.storage.getIdentity();
        if (local) {
          const updated = {
            ...local,
            registrationStatus: 'registered' as const,
            activeLinkId: null,
            pairedPeerDeviceId: null,
            updatedAt: new Date().toISOString()
          };
          await this.storage.saveIdentity(updated);
          this.syncSummaryFromLocal(updated);
        }

        if (persistedInFirestore && disconnectedLive) {
          this.revocationStatus = 'CONFIRMED';
          this.revocationDetail =
            'Revocación confirmada: autorización invalidada en Firestore y sesión del VEL MÓVIL cerrada en vivo.';
        } else if (persistedInFirestore) {
          this.revocationStatus = 'PERSISTED_PEER_OFFLINE';
          this.revocationDetail =
            'Revocación pendiente de notificación en vivo: autorización invalidada en Firestore, pero el VEL MÓVIL estaba desconectado y será rechazado al intentar reconectar.';
        } else {
          this.revocationStatus = 'UNKNOWN';
          this.revocationDetail = 'Estado desconocido: no se recibió confirmación de persistencia del servidor.';
        }

        if (this.pendingRevokeResolver) {
          const resolve = this.pendingRevokeResolver;
          this.pendingRevokeResolver = null;
          resolve({
            success: persistedInFirestore,
            persistedInFirestore,
            disconnectedLive
          });
        }
        this.setState('AUTHENTICATED');
        return;
      }

      case 'ERROR': {
        const opId = msg.operationId ? String(msg.operationId) : null;
        if (opId) {
          this.clearAckTimer(opId);
          const fileWaiter = this.pendingFileAckWaiters.get(opId);
          if (fileWaiter) {
            clearTimeout(fileWaiter.timer);
            this.pendingFileAckWaiters.delete(opId);
            fileWaiter.resolve({
              confirmed: false,
              operationId: opId,
              reason: String(msg.error || 'RELAY_ERROR'),
              error: String(msg.message || msg.error || 'Error reportado por el Relay.')
            });
            return;
          }
          const op = this.operations.find((o) => o.operationId === opId);
          if (op) {
            op.status = 'FAILED';
            op.errorReason = String(msg.error || 'RELAY_ERROR');
            op.statusDetail = String(msg.message || msg.error || 'Error reportado por el Relay.');
            op.updatedAt = Date.now();
          }
        }
        this.lastError = String(msg.message || msg.error || 'Error en el servidor Relay.');
        this.emit();
        return;
      }
    }
  }

  private clearAckTimer(operationId: string) {
    const t = this.ackTimers.get(operationId);
    if (t) {
      clearTimeout(t);
      this.ackTimers.delete(operationId);
    }
  }

  private syncSummaryFromLocal(local: {
    deviceId: string;
    role: 'CORE' | 'TERMINAL';
    fingerprint: string;
    publicKeySpkiBase64: string;
    signingPublicKeySpkiBase64: string;
    firebaseAuthUid: string | null;
    registrationStatus: 'pending_local' | 'registered' | 'paired' | 'revoked';
    activeLinkId: string | null;
    pairedPeerDeviceId: string | null;
    lastServerError: string | null;
    createdAt: string;
    updatedAt: string;
  }) {
    this.currentIdentity = {
      deviceId: local.deviceId,
      role: local.role,
      fingerprint: local.fingerprint,
      publicKeySpkiBase64: local.publicKeySpkiBase64,
      signingPublicKeySpkiBase64: local.signingPublicKeySpkiBase64,
      firebaseAuthUid: local.firebaseAuthUid,
      registrationStatus: local.registrationStatus,
      activeLinkId: local.activeLinkId,
      pairedPeerDeviceId: local.pairedPeerDeviceId,
      lastServerError: local.lastServerError,
      createdAt: local.createdAt,
      updatedAt: local.updatedAt
    };
  }

  public async createPairingOffer(): Promise<{ success: boolean; code?: string; error?: string }> {
    const local = await this.storage.getIdentity();
    if (!local || local.role !== 'CORE') {
      return { success: false, error: 'Solo VEL CORE puede iniciar una invitación.' };
    }
    if (!this.ws || this.ws.readyState !== 1 || (this.state !== 'AUTHENTICATED' && this.state !== 'LINKED')) {
      return { success: false, error: 'Conéctate y autentica VEL CORE en el Relay antes de generar un código.' };
    }

    const code = generateEphemeralPairingCode();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    this.lastError = null;
    this.pairingSession = {
      code,
      initiatorDeviceId: local.deviceId,
      initiatorRole: 'CORE',
      initiatorFingerprint: local.fingerprint,
      initiatorPublicKeyBase64: local.publicKeySpkiBase64,
      stage: 'OFFERING',
      expiresAt
    };

    const sent = this.sendRaw({
      type: 'PAIRING_OFFER',
      code,
      initiatorDeviceId: local.deviceId,
      initiatorRole: 'CORE',
      initiatorFingerprint: local.fingerprint,
      initiatorPublicKeyBase64: local.publicKeySpkiBase64,
      expiresAt
    });

    this.emit();
    return sent ? { success: true, code } : { success: false, error: 'Socket no abierto.' };
  }

  public async claimPairingOffer(rawCode: string): Promise<{ success: boolean; error?: string }> {
    const cleanCode = rawCode.trim().toUpperCase();
    if (!cleanCode) {
      return { success: false, error: 'Ingresa el código temporal generado por VEL CORE.' };
    }
    const local = await this.storage.getIdentity();
    if (!local || local.role !== 'TERMINAL') {
      return { success: false, error: 'Solo VEL MÓVIL puede reclamar una invitación.' };
    }
    if (!this.ws || this.ws.readyState !== 1 || (this.state !== 'AUTHENTICATED' && this.state !== 'LINKED')) {
      return { success: false, error: 'VEL MÓVIL debe estar autenticado en el Relay antes de vincular.' };
    }

    this.lastError = null;
    this.pairingSession = {
      code: cleanCode,
      initiatorDeviceId: '',
      initiatorRole: 'CORE',
      initiatorFingerprint: '',
      initiatorPublicKeyBase64: '',
      stage: 'CLAIMING',
      expiresAt: Date.now() + 5 * 60 * 1000
    };

    const sent = this.sendRaw({
      type: 'PAIRING_CLAIM',
      code: cleanCode,
      claimerDeviceId: local.deviceId,
      claimerRole: 'TERMINAL',
      claimerFingerprint: local.fingerprint,
      claimerPublicKeyBase64: local.publicKeySpkiBase64
    });

    this.emit();
    return sent ? { success: true } : { success: false, error: 'Socket no abierto.' };
  }

  public confirmPairingSas(): boolean {
    if (
      !this.pairingSession ||
      (this.pairingSession.stage !== 'SAS_PENDING' && this.pairingSession.stage !== 'SAS_AWAITING_PEER')
    ) {
      return false;
    }
    const sent = this.sendRaw({
      type: 'PAIRING_CONFIRM',
      code: this.pairingSession.code,
      linkId: this.pairingSession.linkId,
      terminalDeviceId:
        this.currentIdentity?.role === 'CORE'
          ? this.pairingSession.peerDeviceId
          : this.currentIdentity?.deviceId,
      sasVerified: true
    });
    if (sent) {
      this.pairingSession = {
        ...this.pairingSession,
        localConfirmedSas: true,
        stage: 'SAS_AWAITING_PEER'
      };
      this.emit();
    }
    return sent;
  }

  public cancelPairing(reason = 'CANCELLED_BY_USER'): void {
    if (this.pairingSession?.code) {
      this.sendRaw({
        type: 'PAIRING_CANCEL',
        code: this.pairingSession.code,
        reason
      });
    }
    this.pairingSession = null;
    this.emit();
  }

  public sendEncryptedEnvelope(envelope: RelayEncryptedEnvelope): boolean {
    return this.sendRaw({
      ...envelope,
      type: 'ENCRYPTED_MESSAGE'
    });
  }

  public sendConfirmation(confirmation: RelayConfirmationEnvelope): boolean {
    return this.sendRaw({
      ...confirmation,
      type: 'CONFIRMATION'
    });
  }

  /**
   * Cifra un mensaje en memoria con AES-256-GCM + AAD y lo envía por WebSocket.
   * Si no hay conexión activa, NO encola ni almacena contenido personal offline.
   */
  public async sendEncryptedMessage(
    plaintext: string,
    previewLabel = 'Prueba técnica E2EE'
  ): Promise<SendMessageOutcome> {
    const operationId = createRandomUuid();
    const now = Date.now();

    if (
      this.state !== 'LINKED' ||
      !this.sessionKey ||
      !this.currentIdentity?.activeLinkId ||
      !this.currentIdentity?.pairedPeerDeviceId ||
      !this.ws ||
      this.ws.readyState !== 1
    ) {
      this.operations.unshift({
        operationId,
        direction: 'OUTGOING',
        recipientId: this.currentIdentity?.pairedPeerDeviceId || undefined,
        previewLabel,
        status: 'FAILED',
        statusDetail: 'Sin conexión cifrada activa. Operación no encolada para proteger la privacidad.',
        createdAt: now,
        updatedAt: now,
        errorReason: 'OFFLINE_OR_UNLINKED'
      });
      this.emit();
      return {
        accepted: false,
        operationId,
        error: 'Sin conexión cifrada activa con el dispositivo par.'
      };
    }

    const senderId = this.currentIdentity.deviceId;
    const recipientId = this.currentIdentity.pairedPeerDeviceId;
    const sessionId = this.currentIdentity.activeLinkId;

    this.operations.unshift({
      operationId,
      direction: 'OUTGOING',
      recipientId,
      previewLabel,
      status: 'SENDING',
      statusDetail: 'Cifrando con AES-256-GCM y enviando por Relay...',
      createdAt: now,
      updatedAt: now
    });
    if (this.operations.length > 30) {
      this.operations.length = 30;
    }
    this.emit();

    try {
      const { ivBase64, ciphertextBase64 } = await encryptE2EEPayload(this.sessionKey, plaintext, {
        sessionId,
        senderId,
        recipientId,
        operationId,
        timestamp: now
      });

      const envelope: RelayEncryptedEnvelope = {
        type: 'ENCRYPTED_MESSAGE',
        senderId,
        recipientId,
        sessionId,
        operationId,
        iv: ivBase64,
        ciphertext: ciphertextBase64,
        timestamp: now
      };

      const sent = this.sendEncryptedEnvelope(envelope);
      if (!sent) {
        const op = this.operations.find((o) => o.operationId === operationId);
        if (op) {
          op.status = 'FAILED';
          op.errorReason = 'WS_SEND_FAILED';
          op.statusDetail = 'El canal WebSocket se cerró antes de transmitir.';
          op.updatedAt = Date.now();
        }
        this.emit();
        return { accepted: false, operationId, error: 'WebSocket cerrado durante envío.' };
      }

      const timer = setTimeout(() => {
        const op = this.operations.find((o) => o.operationId === operationId);
        if (op && (op.status === 'SENDING' || op.status === 'ROUTED_AWAITING_ACK')) {
          op.status = 'UNKNOWN';
          op.statusDetail = 'Sin confirmación del destinatario dentro del tiempo límite (estado desconocido).';
          op.updatedAt = Date.now();
          this.ackTimers.delete(operationId);
          this.emit();
        }
      }, this.operationAckTimeoutMs);
      this.ackTimers.set(operationId, timer);

      return { accepted: true, operationId };
    } catch (err: any) {
      const op = this.operations.find((o) => o.operationId === operationId);
      if (op) {
        op.status = 'FAILED';
        op.errorReason = 'ENCRYPT_ERROR';
        op.statusDetail = err?.message || 'Error cifrando el paquete E2EE.';
        op.updatedAt = Date.now();
      }
      this.emit();
      return { accepted: false, operationId, error: err?.message || 'Error cifrando paquete.' };
    }
  }

  /**
   * Cifra un bloque o mensaje de control del canal de archivos con encryptE2EEBytes (AES-256-GCM + AAD),
   * lo envía por el Relay y espera la confirmación real del dispositivo destinatario.
   * Nunca confirma únicamente por enrutado ni guarda archivos en cola offline.
   */
  public async sendBinaryFileEnvelope(params: {
    fileId: string;
    chunkIndex: number;
    totalChunks: number;
    purpose: BinaryFileEnvelopePurpose;
    payloadBytes: Uint8Array | ArrayBuffer;
    timeoutMs?: number;
  }): Promise<BinaryFileEnvelopeSendResult> {
    const operationId = buildBinaryFileOperationId(
      params.purpose,
      params.fileId,
      params.chunkIndex,
      params.totalChunks
    );

    if (
      this.state !== 'LINKED' ||
      !this.sessionKey ||
      !this.currentIdentity?.activeLinkId ||
      !this.currentIdentity?.pairedPeerDeviceId ||
      !this.ws ||
      this.ws.readyState !== 1
    ) {
      return {
        confirmed: false,
        operationId,
        reason: 'OFFLINE_OR_UNLINKED',
        error: 'Sin conexión cifrada activa con el dispositivo par.'
      };
    }

    const now = Date.now();
    const senderId = this.currentIdentity.deviceId;
    const recipientId = this.currentIdentity.pairedPeerDeviceId;
    const sessionId = this.currentIdentity.activeLinkId;

    try {
      const { ivBase64, ciphertextBase64 } = await encryptE2EEBytes(
        this.sessionKey,
        params.payloadBytes,
        {
          sessionId,
          senderId,
          recipientId,
          operationId,
          timestamp: now,
          fileId: params.fileId,
          chunkIndex: params.chunkIndex,
          totalChunks: params.totalChunks,
          purpose: params.purpose
        }
      );

      const ackPromise = new Promise<BinaryFileEnvelopeSendResult>((resolve) => {
        const timeout = setTimeout(() => {
          this.pendingFileAckWaiters.delete(operationId);
          resolve({
            confirmed: false,
            operationId,
            reason: 'ACK_TIMEOUT',
            error: 'Tiempo agotado esperando confirmación real desde VEL CORE.'
          });
        }, params.timeoutMs ?? Math.max(this.operationAckTimeoutMs, 15_000));

        this.pendingFileAckWaiters.set(operationId, { resolve, timer: timeout });
      });

      const sent = this.sendEncryptedEnvelope({
        type: 'ENCRYPTED_MESSAGE',
        senderId,
        recipientId,
        sessionId,
        operationId,
        iv: ivBase64,
        ciphertext: ciphertextBase64,
        timestamp: now
      });

      if (!sent) {
        const waiter = this.pendingFileAckWaiters.get(operationId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pendingFileAckWaiters.delete(operationId);
        }
        return {
          confirmed: false,
          operationId,
          reason: 'WS_SEND_FAILED',
          error: 'La conexión WebSocket se cerró durante el envío.'
        };
      }

      return await ackPromise;
    } catch (err: any) {
      const waiter = this.pendingFileAckWaiters.get(operationId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.pendingFileAckWaiters.delete(operationId);
      }
      return {
        confirmed: false,
        operationId,
        reason: 'ENCRYPT_OR_SEND_ERROR',
        error: err?.message || 'Error cifrando o enviando el bloque E2EE.'
      };
    }
  }

  /**
   * Revoca remotamente el VEL MÓVIL desde VEL CORE:
   * - Si el Relay está conectado, ejecuta REVOKE_DEVICE (persiste en Firestore + cierra socket del terminal en vivo).
   * - Si el Relay está offline, invoca directamente POST /api/revoke-device para persistir en Firestore de inmediato.
   */
  public async revokePairedTerminal(
    targetTerminalId: string,
    reason = 'Revocado por el usuario desde VEL CORE'
  ): Promise<RevokeOutcome> {
    const local = await this.storage.getIdentity();
    if (!local || local.role !== 'CORE') {
      return {
        success: false,
        persistedInFirestore: false,
        disconnectedLive: false,
        error: 'Únicamente VEL CORE puede revocar un dispositivo.'
      };
    }

    this.revocationStatus = 'PENDING';
    this.revocationDetail = 'Revocación pendiente: enviando orden de revocación al servidor...';
    this.emit();

    if (this.ws && this.ws.readyState === 1 && (this.state === 'LINKED' || this.state === 'AUTHENTICATED')) {
      return new Promise<RevokeOutcome>((resolve) => {
        const timeout = setTimeout(() => {
          this.pendingRevokeResolver = null;
          void this.revokeViaHttpFallback(local.deviceId, targetTerminalId, reason).then(resolve);
        }, 5000);

        this.pendingRevokeResolver = (res) => {
          clearTimeout(timeout);
          resolve(res);
        };

        this.sendRaw({
          type: 'REVOKE_DEVICE',
          coreId: local.deviceId,
          targetTerminalId,
          reason
        });
      });
    }

    return this.revokeViaHttpFallback(local.deviceId, targetTerminalId, reason);
  }

  private async revokeViaHttpFallback(
    coreDeviceId: string,
    targetTerminalId: string,
    reason: string
  ): Promise<RevokeOutcome> {
    try {
      const token = await this.tokenProvider();
      if (!token) {
        this.revocationStatus = 'UNKNOWN';
        this.revocationDetail =
          'Estado desconocido: sin token Firebase válido para confirmar si la revocación llegó a Firestore.';
        this.emit();
        return {
          success: false,
          persistedInFirestore: false,
          disconnectedLive: false,
          error: 'Sin token Firebase válido para confirmar revocación en Firestore.'
        };
      }

      const res = await this.fetchFn('/api/revoke-device', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ coreDeviceId, targetTerminalId, reason })
      });
      const contentType = (res.headers?.get?.('content-type') || '').toLowerCase();
      if (contentType.includes('text/html')) {
        this.revocationStatus = 'UNKNOWN';
        this.revocationDetail =
          'Estado desconocido: /api/revoke-device no está disponible en un despliegue estático puro (sin Netlify Functions).';
        this.emit();
        return {
          success: false,
          persistedInFirestore: false,
          disconnectedLive: false,
          error:
            'Endpoint /api/revoke-device no disponible en despliegue estático (Netlify Drop no incluye Netlify Functions).'
        };
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        this.revocationStatus = 'UNKNOWN';
        this.revocationDetail = `Estado desconocido: el servidor no confirmó la revocación (${data.error || `HTTP ${res.status}`}).`;
        this.emit();
        return {
          success: false,
          persistedInFirestore: false,
          disconnectedLive: false,
          error: data.error || `Error revocando en Firestore (HTTP ${res.status}).`
        };
      }

      this.sessionKey = null;
      this.peerOnline = false;
      const local = await this.storage.getIdentity();
      if (local) {
        const updated = {
          ...local,
          registrationStatus: 'registered' as const,
          activeLinkId: null,
          pairedPeerDeviceId: null,
          updatedAt: new Date().toISOString()
        };
        await this.storage.saveIdentity(updated);
        this.syncSummaryFromLocal(updated);
      }
      this.revocationStatus = 'PERSISTED_PEER_OFFLINE';
      this.revocationDetail =
        'Revocación pendiente de desconexión en vivo: persistida en Firestore vía API; el terminal será bloqueado al reconectar o validar sesión.';
      this.emit();

      return {
        success: true,
        persistedInFirestore: true,
        disconnectedLive: false
      };
    } catch (err: any) {
      this.revocationStatus = 'UNKNOWN';
      this.revocationDetail =
        'Estado desconocido: error de red al consultar confirmación de revocación en el servidor.';
      this.emit();
      return {
        success: false,
        persistedInFirestore: false,
        disconnectedLive: false,
        error: err?.message || 'Error de red al revocar autorización.'
      };
    }
  }
}
