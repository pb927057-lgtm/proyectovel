import React, { useState, useEffect, useRef } from 'react';
import {
  Shield,
  Smartphone,
  ArrowLeft,
  Lock,
  Plus,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Info,
  ChevronRight,
  ExternalLink,
  Ban,
  User,
  Download,
  CreditCard,
  Check,
  HelpCircle,
  Radio,
  FileText,
  Key,
  Loader2,
  Send,
  Wifi,
  WifiOff,
  Copy,
  Database,
  Trash2,
  Eye,
  EyeOff
} from 'lucide-react';
import {
  DeviceIdentitySummary,
  DeviceRole,
  OperationDeliveryStatus,
  RelayConnectionState,
  RelayServerConfigResponse,
  RevocationStatus
} from './contracts/velContracts';
import {
  DeviceSetupResult,
  ROLE_CHANGE_CONFIRMATION_KEYWORD,
  SetupProgressStep,
  executeControlledRoleChange,
  loadPersistedDeviceIdentity,
  retryPendingDeviceRegistration,
  setupNewDeviceIdentity,
  syncPersistedDeviceSession
} from './services/deviceIdentityService';
import {
  clearPendingEmailForLink,
  completePasswordlessSignInLink,
  getAuthErrorMessage,
  getFreshDeviceAuthToken,
  isIncomingPasswordlessSignInLink,
  logoutUser,
  sendPasswordlessSignInLink,
  subscribeToAuthChanges,
  User as FirebaseUser
} from './services/firebase';
import { RelayClientSnapshot, VelRelayClient } from './services/relayClient';
import {
  AceptacionContratoDocument,
  ensureSubscriberDocument,
  getContractAcceptance,
  getSubscriberDocument,
  isTechnicalAccount,
  recordContractAcceptance,
  SuscriptorDocument,
  OFFICIAL_CONTRACT_URL,
  CURRENT_CONTRACT_VERSION
} from './services/firestore';
import { velOfflineSync } from './db/offlineSync';
import type { VelLocalRecord } from './db/db';
import { useOnlineStatus, usePWAInstall } from './hooks/usePWAInstall';
import {
  OfflineIndicator,
  PWAInstallButton,
  SWUpdateBanner
} from './components/PWAInstallBanner';

export type ScreenType =
  | 'WELCOME'
  | 'ROLE_SELECTION'
  | 'SETUP_CORE'
  | 'SETUP_MOVIL'
  | 'CORE_HOME'
  | 'TERMINAL_HOME'
  | 'PAIRING_CORE'
  | 'DEVICE_MANAGEMENT'
  | 'REPLACE_PHONE';

export type { DeviceRole };

export function App() {
  // Modos de vista: PWA VEL (Dispositivo), Portal Web (Contratación) e Instalación
  const [viewMode, setViewMode] = useState<'PHONE_PREVIEW' | 'WEB_PORTAL' | 'INSTALL_INFO'>('PHONE_PREVIEW');
  const [currentScreen, setCurrentScreen] = useState<ScreenType>('WELCOME');

  // Modales de información, emergencia y cambio controlado de rol
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showEmergencyModal, setShowEmergencyModal] = useState(false);
  const [showRoleChangeModal, setShowRoleChangeModal] = useState(false);
  const [roleChangeConfirmInput, setRoleChangeConfirmInput] = useState('');
  const [roleChangeError, setRoleChangeError] = useState<string | null>(null);
  const [isChangingRole, setIsChangingRole] = useState(false);

  // Estado real de identidad técnica del dispositivo (IndexedDB + Web Crypto + Firebase/Firestore)
  const [isLoadingIdentity, setIsLoadingIdentity] = useState(true);
  const [deviceIdentity, setDeviceIdentity] = useState<DeviceIdentitySummary | null>(null);
  const [setupSteps, setSetupSteps] = useState<SetupProgressStep[]>([]);
  const [isSettingUpDevice, setIsSettingUpDevice] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [requiresExternalConfig, setRequiresExternalConfig] = useState(false);
  const [isRetryingSync, setIsRetryingSync] = useState(false);

  // PWA & Conectividad
  const pwa = usePWAInstall();
  const isOnline = useOnlineStatus();

  // Custodia local cifrada exclusiva de VEL CORE (IndexedDB + AES-256-GCM no exportable)
  const [coreVaultRecords, setCoreVaultRecords] = useState<VelLocalRecord[]>([]);
  const [vaultNoteTitle, setVaultNoteTitle] = useState('');
  const [vaultNoteBody, setVaultNoteBody] = useState('');
  const [isSavingVaultNote, setIsSavingVaultNote] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [decryptedVaultNote, setDecryptedVaultNote] = useState<{
    id: string;
    title: string;
    content: string;
    savedAt: string;
  } | null>(null);

  // Estado real del cliente Relay WebSocket y cifrado E2EE (Intervención 2)
  const relayClientRef = useRef<VelRelayClient | null>(null);
  if (!relayClientRef.current) {
    relayClientRef.current = new VelRelayClient();
  }
  const [relaySnapshot, setRelaySnapshot] = useState<RelayClientSnapshot>(() =>
    relayClientRef.current!.getSnapshot()
  );
  const PRODUCTION_RELAY_WSS_URL = 'wss://server-vel.onrender.com';

  const getCompiledOrDefaultRelayConfig = (): RelayServerConfigResponse => {
    const viteConfigured = String((import.meta as any).env?.VITE_VEL_RELAY_WSS_URL || '').trim();
    if (/^wss?:\/\/.+/i.test(viteConfigured)) {
      return {
        configured: true,
        wssUrl: viteConfigured.replace(/\/+$/, ''),
        source: 'vite_env'
      };
    }
    return {
      configured: true,
      wssUrl: PRODUCTION_RELAY_WSS_URL,
      source: 'production_default'
    };
  };

  const [relayConfig, setRelayConfig] = useState<
    RelayServerConfigResponse & { loading: boolean }
  >(() => ({
    loading: true,
    ...getCompiledOrDefaultRelayConfig()
  }));
  const [pairingCodeInput, setPairingCodeInput] = useState('');
  const [isStartingPairingOffer, setIsStartingPairingOffer] = useState(false);
  const [isClaimingPairing, setIsClaimingPairing] = useState(false);
  const [pairingCountdownSec, setPairingCountdownSec] = useState<number>(0);
  const [e2eeMessageInput, setE2eeMessageInput] = useState('');
  const [isSendingE2ee, setIsSendingE2ee] = useState(false);
  const [e2eeNotice, setE2eeNotice] = useState<string | null>(null);
  const [isRevokingPeer, setIsRevokingPeer] = useState(false);
  const [revokeFeedback, setRevokeFeedback] = useState<string | null>(null);
  const [copiedPairingCode, setCopiedPairingCode] = useState(false);

  const loadRelayConfiguration = async () => {
    const fallback = getCompiledOrDefaultRelayConfig();
    setRelayConfig((prev) => ({ ...prev, loading: true }));
    try {
      const res = await fetch('/api/relay-config');
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && contentType.includes('application/json')) {
        const data = (await res.json()) as RelayServerConfigResponse;
        if (data.configured && data.wssUrl) {
          setRelayConfig({
            loading: false,
            configured: true,
            wssUrl: data.wssUrl.replace(/\/+$/, ''),
            source: data.source || 'env'
          });
          return;
        }
      }
      setRelayConfig({
        loading: false,
        ...fallback
      });
    } catch {
      setRelayConfig({
        loading: false,
        ...fallback
      });
    }
  };

  useEffect(() => {
    const client = relayClientRef.current!;
    const unsubscribe = client.subscribe((snap) => {
      setRelaySnapshot(snap);
      if (snap.identity) {
        setDeviceIdentity(snap.identity);
      }
    });
    void loadRelayConfiguration();

    return () => {
      unsubscribe();
      client.disconnect();
    };
  }, []);

  // Reconexión automática controlada al volver la red o recuperar visibilidad de la PWA
  useEffect(() => {
    const syncAndReconnect = async () => {
      if (!deviceIdentity) return;
      try {
        const syncRes = await syncPersistedDeviceSession();
        if (syncRes) {
          setDeviceIdentity(syncRes.identity);
          if (syncRes.revoked) {
            relayClientRef.current?.disconnect();
            return;
          }
        }
      } catch {
        // Conserva estado local hasta que haya red estable
      }

      if (
        isOnline &&
        deviceIdentity.registrationStatus !== 'pending_local' &&
        deviceIdentity.registrationStatus !== 'revoked' &&
        relayConfig.configured &&
        relayConfig.wssUrl
      ) {
        const st = relayClientRef.current!.getState();
        if (st === 'DISCONNECTED' || st === 'ERROR') {
          relayClientRef.current!.connect(relayConfig.wssUrl, getFreshDeviceAuthToken);
        }
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void syncAndReconnect();
      }
    };

    if (isOnline && deviceIdentity) {
      void syncAndReconnect();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isOnline, deviceIdentity?.deviceId, deviceIdentity?.registrationStatus, relayConfig.configured, relayConfig.wssUrl]);

  useEffect(() => {
    const client = relayClientRef.current!;
    if (
      isOnline &&
      deviceIdentity &&
      deviceIdentity.registrationStatus !== 'pending_local' &&
      deviceIdentity.registrationStatus !== 'revoked' &&
      relayConfig.configured &&
      relayConfig.wssUrl
    ) {
      const currentState = client.getState();
      if (currentState === 'DISCONNECTED' || currentState === 'ERROR') {
        client.connect(relayConfig.wssUrl, getFreshDeviceAuthToken);
      }
    } else if (!deviceIdentity || deviceIdentity.registrationStatus === 'revoked') {
      if (client.getState() !== 'REVOKED' && client.getState() !== 'DISCONNECTED') {
        client.disconnect();
      }
    }
  }, [
    isOnline,
    deviceIdentity?.deviceId,
    deviceIdentity?.registrationStatus,
    relayConfig.configured,
    relayConfig.wssUrl
  ]);

  // Cargar registros locales cifrados exclusivamente cuando este dispositivo es VEL CORE
  const refreshCoreVaultRecords = async () => {
    if (deviceIdentity?.role !== 'CORE') {
      setCoreVaultRecords([]);
      return;
    }
    try {
      const list = await velOfflineSync.getAllRecords();
      setCoreVaultRecords(list.sort((a, b) => b.updatedAt - a.updatedAt));
    } catch {
      setVaultError('No se pudo leer la bóveda local cifrada en IndexedDB.');
    }
  };

  useEffect(() => {
    if (deviceIdentity?.role === 'CORE' && currentScreen === 'CORE_HOME') {
      void refreshCoreVaultRecords();
    } else if (deviceIdentity?.role !== 'CORE') {
      setCoreVaultRecords([]);
      setDecryptedVaultNote(null);
    }
  }, [deviceIdentity?.role, currentScreen]);

  const handleSaveCoreVaultNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (deviceIdentity?.role !== 'CORE') return;
    const title = vaultNoteTitle.trim() || 'Registro confidencial';
    const content = vaultNoteBody.trim();
    if (!content) {
      setVaultError('Ingresa un contenido para guardar cifrado en tu VEL CORE.');
      return;
    }
    setIsSavingVaultNote(true);
    setVaultError(null);
    try {
      const id = `CORE-REC-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await velOfflineSync.saveLocal(id, {
        title,
        content,
        savedAt: new Date().toISOString()
      });
      setVaultNoteTitle('');
      setVaultNoteBody('');
      await refreshCoreVaultRecords();
    } catch (err: any) {
      setVaultError(err?.message || 'Error al cifrar localmente con AES-256-GCM.');
    } finally {
      setIsSavingVaultNote(false);
    }
  };

  const handleOpenCoreVaultNote = async (id: string) => {
    if (deviceIdentity?.role !== 'CORE') return;
    setVaultError(null);
    const data = await velOfflineSync.getLocal<{ title?: string; content?: string; savedAt?: string }>(id);
    if (!data) {
      setVaultError('No se pudo descifrar este registro con la clave local no exportable.');
      return;
    }
    setDecryptedVaultNote({
      id,
      title: data.title || 'Registro CORE',
      content: data.content || (typeof data === 'string' ? data : JSON.stringify(data)),
      savedAt: data.savedAt || ''
    });
  };

  const handleDeleteCoreVaultNote = async (id: string) => {
    if (deviceIdentity?.role !== 'CORE') return;
    await velOfflineSync.removeRecord(id);
    if (decryptedVaultNote?.id === id) {
      setDecryptedVaultNote(null);
    }
    await refreshCoreVaultRecords();
  };

  const handleArchiveIncomingMessageInCore = async (text: string, operationId: string) => {
    if (deviceIdentity?.role !== 'CORE') return;
    setVaultError(null);
    try {
      await velOfflineSync.saveLocal(`E2EE-${operationId}`, {
        title: 'Mensaje E2EE recibido desde VEL MÓVIL',
        content: text,
        savedAt: new Date().toISOString()
      });
      await refreshCoreVaultRecords();
    } catch (err: any) {
      setVaultError(err?.message || 'No se pudo archivar localmente.');
    }
  };

  useEffect(() => {
    const expiresAt = relaySnapshot.pairingSession?.expiresAt;
    if (!expiresAt || relaySnapshot.pairingSession?.stage === 'CONFIRMED') {
      setPairingCountdownSec(0);
      return;
    }
    const updateTick = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setPairingCountdownSec(remaining);
    };
    updateTick();
    const timer = setInterval(updateTick, 1000);
    return () => clearInterval(timer);
  }, [relaySnapshot.pairingSession?.expiresAt, relaySnapshot.pairingSession?.stage]);

  const handleReconnectRelay = () => {
    if (relayConfig.configured && relayConfig.wssUrl) {
      relayClientRef.current!.connect(relayConfig.wssUrl, getFreshDeviceAuthToken);
    } else {
      void loadRelayConfiguration();
    }
  };

  const handleCreatePairingOffer = async () => {
    setIsStartingPairingOffer(true);
    try {
      await relayClientRef.current!.createPairingOffer();
    } finally {
      setIsStartingPairingOffer(false);
    }
  };

  const handleClaimPairingCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsClaimingPairing(true);
    try {
      await relayClientRef.current!.claimPairingOffer(pairingCodeInput);
    } finally {
      setIsClaimingPairing(false);
    }
  };

  const handleSendE2eeVerification = async (e?: React.FormEvent, overrideText?: string) => {
    if (e) e.preventDefault();
    const textToSend = (
      overrideText ??
      (e2eeMessageInput.trim() ||
        `Verificación técnica E2EE VEL (${deviceIdentity?.role || 'PEER'}) • ${new Date().toLocaleTimeString()}`)
    ).trim();
    setIsSendingE2ee(true);
    setE2eeNotice(null);
    try {
      const outcome = await relayClientRef.current!.sendEncryptedMessage(
        textToSend,
        overrideText ? 'Reintento técnico E2EE' : textToSend.slice(0, 42)
      );
      if (!outcome.accepted) {
        setE2eeNotice(outcome.error || 'No se pudo enviar el paquete cifrado.');
      } else if (!overrideText) {
        setE2eeMessageInput('');
      }
    } finally {
      setIsSendingE2ee(false);
    }
  };

  const handleRevokePeerDevice = async (reason: string) => {
    if (!deviceIdentity?.pairedPeerDeviceId) return;
    setIsRevokingPeer(true);
    setRevokeFeedback(null);
    try {
      const res = await relayClientRef.current!.revokePairedTerminal(
        deviceIdentity.pairedPeerDeviceId,
        reason
      );
      if (res.success && res.persistedInFirestore) {
        setRevokeFeedback(
          res.disconnectedLive
            ? '✓ Revocación confirmada: autorización invalidada en Firestore y VEL MÓVIL desconectado del Relay en vivo.'
            : '⚠ Revocación pendiente de desconexión en vivo: autorización invalidada en Firestore, pero el VEL MÓVIL estaba desconectado y será bloqueado al reconectar.'
        );
      } else {
        setRevokeFeedback(
          `✕ Estado desconocido: ${res.error || 'No se recibió confirmación del servidor sobre la revocación.'}`
        );
      }
    } finally {
      setIsRevokingPeer(false);
    }
  };

  const formatRevocationBadge = (status: RevocationStatus) => {
    switch (status) {
      case 'CONFIRMED':
        return { label: 'Revocación confirmada', cls: 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30' };
      case 'PERSISTED_PEER_OFFLINE':
      case 'PENDING':
        return { label: 'Revocación pendiente', cls: 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/30' };
      case 'UNKNOWN':
        return { label: 'Estado desconocido', cls: 'bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/30' };
      default:
        return null;
    }
  };

  const formatRelayBadge = (state: RelayConnectionState, peerOnline: boolean) => {
    switch (state) {
      case 'LINKED':
        return {
          label: peerOnline ? 'Vinculado E2EE (Par en línea)' : 'Vinculado E2EE (Par desconectado)',
          cls: peerOnline
            ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30'
            : 'bg-[#00CFE8]/15 text-[#00CFE8] border-[#00CFE8]/30'
        };
      case 'AUTHENTICATED':
        return { label: 'Relay conectado (esperando emparejamiento)', cls: 'bg-[#00CFE8]/15 text-[#00CFE8] border-[#00CFE8]/30' };
      case 'CONNECTING':
      case 'CONNECTED_UNAUTHENTICATED':
      case 'AUTHENTICATING':
        return { label: 'Autenticando en Relay...', cls: 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/30' };
      case 'RECONNECTING':
        return { label: 'Reconectando Relay...', cls: 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/30' };
      case 'REVOKED':
        return { label: 'Dispositivo revocado', cls: 'bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/30' };
      case 'ERROR':
        return { label: 'Error de Relay', cls: 'bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/30' };
      case 'DISCONNECTED':
      default:
        return { label: 'Relay desconectado', cls: 'bg-[#94A3B8]/15 text-[#94A3B8] border-[#94A3B8]/30' };
    }
  };

  const formatOpStatusLabel = (status: OperationDeliveryStatus) => {
    switch (status) {
      case 'SENDING':
        return { text: 'Enviando...', cls: 'text-[#00CFE8]' };
      case 'ROUTED_AWAITING_ACK':
        return { text: 'Enrutado (esperando confirmación)', cls: 'text-[#F59E0B]' };
      case 'CONFIRMED':
        return { text: 'Recibido y confirmado ✓', cls: 'text-[#10B981]' };
      case 'FAILED':
        return { text: 'Fallido (no encolado)', cls: 'text-[#EF4444]' };
      case 'UNKNOWN':
      default:
        return { text: 'Estado desconocido', cls: 'text-[#F59E0B]' };
    }
  };

  const handleApplySetupOutcome = (result: DeviceSetupResult) => {
    if (result.identity) {
      setDeviceIdentity(result.identity);
    }
    if (!result.success) {
      setSetupError(result.error || 'No se pudo completar el registro en Firebase/Firestore.');
      setRequiresExternalConfig(Boolean(result.requiresExternalConfig));
    } else {
      setSetupError(null);
      setRequiresExternalConfig(false);
    }
  };

  const handleStartDeviceSetup = async (role: DeviceRole) => {
    setSetupError(null);
    setRequiresExternalConfig(false);
    setIsSettingUpDevice(true);
    setCurrentScreen(role === 'CORE' ? 'SETUP_CORE' : 'SETUP_MOVIL');

    try {
      const result = await setupNewDeviceIdentity(role, (steps) => {
        setSetupSteps(steps);
      });
      handleApplySetupOutcome(result);
    } catch (err: any) {
      setSetupError(err?.message || 'Error inesperado al configurar la identidad técnica.');
    } finally {
      setIsSettingUpDevice(false);
    }
  };

  const handleRetryServerRegistration = async () => {
    setIsRetryingSync(true);
    setSetupError(null);
    try {
      const result = await retryPendingDeviceRegistration();
      handleApplySetupOutcome(result);
    } catch (err: any) {
      setSetupError(err?.message || 'Error al reintentar el registro en Firebase/Firestore.');
    } finally {
      setIsRetryingSync(false);
    }
  };

  const handleRefreshDeviceSession = async () => {
    setIsRetryingSync(true);
    setSetupError(null);
    try {
      const syncRes = await syncPersistedDeviceSession();
      if (syncRes) {
        setDeviceIdentity(syncRes.identity);
        if (!syncRes.synced && syncRes.error) {
          setSetupError(syncRes.error);
        }
      }
    } catch (err: any) {
      setSetupError(err?.message || 'No se pudo verificar la sesión técnica en Firestore.');
    } finally {
      setIsRetryingSync(false);
    }
  };

  const handleExecuteControlledRoleChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setRoleChangeError(null);
    setIsChangingRole(true);

    try {
      relayClientRef.current?.disconnect();
      const res = await executeControlledRoleChange(roleChangeConfirmInput);
      if (!res.success) {
        setRoleChangeError(res.error || 'Confirmación inválida.');
        return;
      }

      setDeviceIdentity(null);
      setSetupSteps([]);
      setSetupError(null);
      setRequiresExternalConfig(false);
      setPairingCodeInput('');
      setRevokeFeedback(null);
      setRoleChangeConfirmInput('');
      setShowRoleChangeModal(false);
      setCurrentScreen('WELCOME');
    } catch (err: any) {
      setRoleChangeError(err?.message || 'No se pudo completar el cambio controlado de rol.');
    } finally {
      setIsChangingRole(false);
    }
  };

  // ==========================================
  // ESTADO DEL PORTAL WEB: CONTRATACIÓN Y SUSCRIPCIÓN (SIN CONTRASEÑA)
  // ==========================================
  const [currentUser, setCurrentUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authEmail, setAuthEmail] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);
  const [emailLinkSentTo, setEmailLinkSentTo] = useState<string | null>(null);
  const [needsLinkEmailConfirm, setNeedsLinkEmailConfirm] = useState(false);
  const [confirmLinkEmailInput, setConfirmLinkEmailInput] = useState('');
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false);
  const [subscriberDoc, setSubscriberDoc] = useState<SuscriptorDocument | null>(null);

  // Aceptación obligatoria del contrato en Portal Web (persistida realmente en Firestore)
  const [webContractAccepted, setWebContractAccepted] = useState(false);
  const [contractAcceptanceDoc, setContractAcceptanceDoc] = useState<AceptacionContratoDocument | null>(null);
  const [isRecordingContract, setIsRecordingContract] = useState(false);
  const [contractError, setContractError] = useState<string | null>(null);

  // Retorno desde Mercado Pago (?pago_retorno=aprobado|pendiente|cancelado)
  const [paymentReturnStatus, setPaymentReturnStatus] = useState<'aprobado' | 'pendiente' | 'cancelado' | null>(null);
  const [isRefreshingSubscription, setIsRefreshingSubscription] = useState(false);

  // Estados comerciales de Mercado Pago y Precios
  const [serverPricing, setServerPricing] = useState<{ monto: number; moneda: string; periodicidad: string }>({
    monto: 4500,
    moneda: 'ARS',
    periodicidad: 'mensual'
  });
  const [isStartingCheckout, setIsStartingCheckout] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [isCancellingSub, setIsCancellingSub] = useState(false);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);

  // Panel de administración de precios
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [adminNewPrice, setAdminNewPrice] = useState('4500');
  const [adminNewCurrency, setAdminNewCurrency] = useState('ARS');
  const [adminPriceMsg, setAdminPriceMsg] = useState<string | null>(null);
  const [adminHistory, setAdminHistory] = useState<any[]>([]);

  const isAdmin = currentUser?.email && ['admin@vel.com', 'soporte@vel.com', 'pb927057@gmail.com'].includes(currentUser.email.toLowerCase());

  // Cargar precio vigente desde el servidor
  useEffect(() => {
    fetch('/api/get-pricing')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.pricing) {
          setServerPricing(data.pricing);
          setAdminNewPrice(String(data.pricing.monto));
          setAdminNewCurrency(data.pricing.moneda);
        }
      })
      .catch(() => {
        // Fallback predeterminado ya configurado
      });
  }, []);

  const loadAdminHistory = async () => {
    if (!currentUser) return;
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch('/api/admin-pricing', {
        headers: { Authorization: `Bearer ${idToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        setAdminHistory(data.history || []);
      }
    } catch {
      // Manejo silencioso
    }
  };

  const handleStartCheckout = async () => {
    if (!currentUser) {
      setCheckoutError('Debes registrar tu cuenta o iniciar sesión antes de contratar.');
      return;
    }

    const isExistingSubscriber = Boolean(
      subscriberDoc?.precioContratado &&
        subscriberDoc.precioContratado > 0 &&
        (subscriberDoc.fechaUltimoPago ||
          subscriberDoc.venceEl ||
          ['activo', 'en_gracia', 'suspendido', 'vencido'].includes(subscriberDoc.estado))
    );

    if (!isExistingSubscriber) {
      if (!webContractAccepted) {
        setCheckoutError('Debes aceptar obligatoriamente los Términos y Condiciones antes de continuar.');
        return;
      }

      // Verificar que la aceptación legal esté efectivamente persistida en Firestore antes de abrir Checkout Pro
      if (!contractAcceptanceDoc?.aceptado || contractAcceptanceDoc.versionContrato !== CURRENT_CONTRACT_VERSION) {
        setIsRecordingContract(true);
        setContractError(null);
        const acceptanceRes = await recordContractAcceptance(
          currentUser.uid,
          CURRENT_CONTRACT_VERSION,
          OFFICIAL_CONTRACT_URL,
          currentUser.email
        );
        setIsRecordingContract(false);
        if (!acceptanceRes.success || !acceptanceRes.doc) {
          const msg =
            acceptanceRes.error ||
            'No se pudo confirmar el registro legal de tu aceptación en Firestore. Intenta nuevamente.';
          setContractError(msg);
          setWebContractAccepted(false);
          setCheckoutError(msg);
          return;
        }
        setContractAcceptanceDoc(acceptanceRes.doc);
      }
    }

    setIsStartingCheckout(true);
    setCheckoutError(null);
    setCancelMessage(null);

    try {
      const idToken = await currentUser.getIdToken(true);
      const res = await fetch('/api/create-preference', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify({})
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'No se pudo generar la preferencia de pago en Mercado Pago.');
      }

      if (data.pendingConfig || data.isConfigPending) {
        setCheckoutError(data.error || data.mensaje || 'Credenciales pendientes de configuración en Netlify.');
      } else if (typeof data.init_point === 'string' && data.init_point.startsWith('https://')) {
        window.location.href = data.init_point;
      } else {
        throw new Error('Mercado Pago no retornó una URL de pago válida (init_point).');
      }
    } catch (err: any) {
      setCheckoutError(err.message || 'Error al conectar con la pasarela de pago.');
    } finally {
      setIsStartingCheckout(false);
    }
  };

  const [isCheckingDownload, setIsCheckingDownload] = useState(false);

  const handleAuthorizedDownload = async () => {
    if (!currentUser) {
      setCheckoutError('Debes iniciar sesión para descargar el paquete autorizado.');
      return;
    }
    setIsCheckingDownload(true);
    setCheckoutError(null);

    try {
      const idToken = await currentUser.getIdToken(true);
      const res = await fetch('/api/download-package?format=json', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${idToken}`,
          Accept: 'application/json'
        }
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.authorized || !data.downloadUrl) {
        const refreshed = await getSubscriberDocument(currentUser.uid).catch(() => null);
        if (refreshed) setSubscriberDoc(refreshed);
        throw new Error(data.error || 'Descarga no autorizada para el estado actual de tu suscripción.');
      }

      const link = document.createElement('a');
      link.href = data.downloadUrl;
      link.download = 'vel-netlify-actualizacion.zip';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err: any) {
      setCheckoutError(err.message || 'No se pudo validar la autorización de descarga.');
    } finally {
      setIsCheckingDownload(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (!currentUser) return;
    setIsCancellingSub(true);
    setCancelMessage(null);
    setCheckoutError(null);

    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch('/api/cancel-subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`
        }
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Fallo al procesar la cancelación.');
      }

      setCancelMessage(data.mensaje || 'Suscripción cancelada exitosamente.');
      const docSnap = await getSubscriberDocument(currentUser.uid);
      setSubscriberDoc(docSnap);
    } catch (err: any) {
      setCheckoutError(err.message || 'Error al cancelar la suscripción.');
    } finally {
      setIsCancellingSub(false);
    }
  };

  const handleUpdatePriceAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    setAdminPriceMsg(null);

    const num = Number(adminNewPrice);
    if (isNaN(num) || num <= 0) {
      setAdminPriceMsg('El monto debe ser mayor a 0.');
      return;
    }

    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch('/api/admin-pricing', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify({
          monto: num,
          moneda: adminNewCurrency,
          motivoCambio: 'Actualización comercial desde el panel administrativo'
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al actualizar');

      setAdminPriceMsg(`✓ ${data.mensaje}`);
      if (data.pricing) {
        setServerPricing(data.pricing);
      }
      loadAdminHistory();
    } catch (err: any) {
      setAdminPriceMsg(`Error: ${err.message}`);
    }
  };

  // Restaurar identidad técnica persistida (IndexedDB) y completar posible retorno de Email Link
  useEffect(() => {
    let active = true;

    const bootstrapApp = async () => {
      try {
        const persisted = await loadPersistedDeviceIdentity();
        if (!active) return;

        if (persisted) {
          setDeviceIdentity(persisted);
          setCurrentScreen(persisted.role === 'CORE' ? 'CORE_HOME' : 'TERMINAL_HOME');
          setIsLoadingIdentity(false);

          // Sincronización silenciosa en segundo plano contra Firestore (/api/device-session)
          syncPersistedDeviceSession()
            .then((syncRes) => {
              if (!active || !syncRes) return;
              setDeviceIdentity(syncRes.identity);
              if (!syncRes.synced && syncRes.error) {
                setSetupError(syncRes.error);
              } else {
                setSetupError(null);
              }
            })
            .catch(() => {
              // Mantiene la identidad persistida localmente sin interrumpir el inicio
            });
        } else {
          setCurrentScreen('WELCOME');
          setIsLoadingIdentity(false);
        }
      } catch (err: any) {
        if (!active) return;
        setSetupError(err?.message || 'Error al cargar la identidad técnica local.');
        setCurrentScreen('WELCOME');
        setIsLoadingIdentity(false);
      }

      // Detectar retorno desde Mercado Pago (?pago_retorno=aprobado|pendiente|cancelado) o parámetro ?vista=portal
      if (typeof window !== 'undefined' && window.location.search) {
        const params = new URLSearchParams(window.location.search);
        const pagoRetorno = params.get('pago_retorno');
        const vista = params.get('vista');
        if (pagoRetorno === 'aprobado' || pagoRetorno === 'pendiente' || pagoRetorno === 'cancelado') {
          setPaymentReturnStatus(pagoRetorno);
          setViewMode('WEB_PORTAL');
          if (!isIncomingPasswordlessSignInLink() && window.history?.replaceState) {
            window.history.replaceState({}, document.title, window.location.pathname);
          }
        } else if (vista === 'portal') {
          setViewMode('WEB_PORTAL');
        } else if (vista === 'instalar') {
          setViewMode('INSTALL_INFO');
        }
      }

      // Verificar si la URL corresponde a un enlace de acceso comercial sin contraseña (Email Link)
      if (isIncomingPasswordlessSignInLink()) {
        setViewMode('WEB_PORTAL');
        setIsSubmittingAuth(true);
        const linkRes = await completePasswordlessSignInLink();
        if (!active) return;
        setIsSubmittingAuth(false);

        if (linkRes.completed && linkRes.user) {
          setAuthSuccess(`✓ Identidad verificada sin contraseña: ${linkRes.user.email}`);
          setNeedsLinkEmailConfirm(false);
          setEmailLinkSentTo(null);
          await ensureSubscriberDocument(linkRes.user.uid, linkRes.user.email || '');
          const docSnap = await getSubscriberDocument(linkRes.user.uid).catch(() => null);
          if (active) setSubscriberDoc(docSnap);
          if (typeof window !== 'undefined' && window.history?.replaceState) {
            window.history.replaceState({}, document.title, window.location.pathname);
          }
        } else if (linkRes.needsEmailConfirmation) {
          setNeedsLinkEmailConfirm(true);
          setAuthError(linkRes.error || 'Ingresa tu correo para completar la verificación del enlace.');
        } else if (linkRes.error) {
          setAuthError(linkRes.error);
        }
      }
    };

    bootstrapApp();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToAuthChanges(async (user) => {
      setCurrentUser(user);
      setAuthLoading(false);
      if (user) {
        try {
          const docSnap = await getSubscriberDocument(user.uid);
          setSubscriberDoc(docSnap);
          try {
            const acceptanceSnap = await getContractAcceptance(user.uid, CURRENT_CONTRACT_VERSION);
            if (acceptanceSnap?.aceptado) {
              setWebContractAccepted(true);
              setContractAcceptanceDoc(acceptanceSnap);
              setContractError(null);
            } else {
              setWebContractAccepted(false);
              setContractAcceptanceDoc(null);
            }
          } catch (contractErr: any) {
            setWebContractAccepted(false);
            setContractAcceptanceDoc(null);
            setContractError(
              contractErr?.message ||
                'No se pudo verificar el estado previo de aceptación del contrato en Firestore.'
            );
          }
        } catch {
          // Manejo silencioso de carga inicial del perfil comercial
        }
      } else {
        setSubscriberDoc(null);
        setWebContractAccepted(false);
        setContractAcceptanceDoc(null);
        setContractError(null);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleRequestPasswordlessLink = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setAuthError(null);
    setAuthSuccess(null);

    const email = authEmail.trim();
    if (!email || !email.includes('@')) {
      setAuthError('Por favor ingresa un correo electrónico válido.');
      return;
    }

    setIsSubmittingAuth(true);
    try {
      await sendPasswordlessSignInLink(email);
      setEmailLinkSentTo(email);
      setAuthSuccess(
        `✓ Enlace de acceso único enviado a ${email}. Abre tu bandeja y haz clic en el enlace para ingresar sin contraseña (si ya eras suscriptor, se conservará tu historial y tarifa).`
      );
    } catch (err: any) {
      setAuthError(getAuthErrorMessage(err?.code || ''));
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  const handleConfirmEmailForLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccess(null);

    const email = confirmLinkEmailInput.trim();
    if (!email || !email.includes('@')) {
      setAuthError('Ingresa el mismo correo electrónico en el que recibiste el enlace.');
      return;
    }

    setIsSubmittingAuth(true);
    try {
      const res = await completePasswordlessSignInLink(email);
      if (res.completed && res.user) {
        setNeedsLinkEmailConfirm(false);
        setConfirmLinkEmailInput('');
        setAuthSuccess(`✓ Identidad verificada sin contraseña: ${res.user.email}`);
        await ensureSubscriberDocument(res.user.uid, res.user.email || '');
        const docSnap = await getSubscriberDocument(res.user.uid).catch(() => null);
        setSubscriberDoc(docSnap);
        if (typeof window !== 'undefined' && window.history?.replaceState) {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      } else {
        setAuthError(res.error || 'No se pudo validar el enlace con ese correo electrónico.');
      }
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  const handleWebLogout = async () => {
    await logoutUser();
    await clearPendingEmailForLink();
    setSubscriberDoc(null);
    setAuthSuccess(null);
    setAuthError(null);
    setEmailLinkSentTo(null);
    setNeedsLinkEmailConfirm(false);
  };

  const handleContractCheckboxChange = async (checked: boolean) => {
    setContractError(null);
    setCheckoutError(null);

    if (!checked) {
      if (contractAcceptanceDoc?.aceptado) {
        setWebContractAccepted(true);
        return;
      }
      setWebContractAccepted(false);
      return;
    }

    if (!currentUser) {
      setWebContractAccepted(false);
      setContractError('Debes iniciar sesión sin contraseña en el Paso 1 antes de registrar la aceptación del contrato.');
      return;
    }

    if (isTechnicalAccount(currentUser.uid, currentUser.email)) {
      setWebContractAccepted(false);
      setContractError('Operación bloqueada: la cuenta técnica o de soporte no puede registrarse como cliente particular.');
      return;
    }

    // Evitar registro duplicado si la versión actual ya fue aceptada y persistida
    if (
      contractAcceptanceDoc?.aceptado &&
      contractAcceptanceDoc.versionContrato === CURRENT_CONTRACT_VERSION
    ) {
      setWebContractAccepted(true);
      return;
    }

    setIsRecordingContract(true);
    try {
      const res = await recordContractAcceptance(
        currentUser.uid,
        CURRENT_CONTRACT_VERSION,
        OFFICIAL_CONTRACT_URL,
        currentUser.email
      );
      if (!res.success || !res.doc) {
        setWebContractAccepted(false);
        setContractAcceptanceDoc(null);
        setContractError(
          res.error || 'No se pudo registrar tu aceptación legal en Cloud Firestore. Intenta nuevamente.'
        );
        return;
      }
      setContractAcceptanceDoc(res.doc);
      setWebContractAccepted(true);
    } catch (err: any) {
      setWebContractAccepted(false);
      setContractAcceptanceDoc(null);
      setContractError(err?.message || 'Error inesperado al guardar la aceptación del contrato.');
    } finally {
      setIsRecordingContract(false);
    }
  };

  const handleRefreshSubscriptionFromFirestore = async () => {
    if (!currentUser) return;
    setIsRefreshingSubscription(true);
    try {
      const fresh = await getSubscriberDocument(currentUser.uid);
      setSubscriberDoc(fresh);
    } catch {
      setCheckoutError('No se pudo consultar tu estado comercial actual en Cloud Firestore.');
    } finally {
      setIsRefreshingSubscription(false);
    }
  };

  const commercialStatusBadge = (() => {
    if (!currentUser) {
      return {
        label: 'Sesión comercial no iniciada en este navegador',
        cls: 'bg-[#94A3B8]/15 text-[#94A3B8] border-[#94A3B8]/30'
      };
    }
    const est = subscriberDoc?.estado;
    const venceMs = subscriberDoc?.venceEl ? Date.parse(subscriberDoc.venceEl) : NaN;
    const isExpiredDate = !Number.isNaN(venceMs) && venceMs <= Date.now();
    if (est === 'activo' && !isExpiredDate) {
      const daysLeft = !Number.isNaN(venceMs)
        ? Math.ceil((venceMs - Date.now()) / (24 * 60 * 60 * 1000))
        : null;
      if (daysLeft !== null && daysLeft <= 7) {
        return {
          label: `Comercial: Próximo a vencer (${daysLeft} d)`,
          cls: 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/30'
        };
      }
      return {
        label: 'Comercial: Activo',
        cls: 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30'
      };
    }
    if (est === 'en_gracia') {
      return {
        label: 'Comercial: Período de gracia (7 días)',
        cls: 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/30'
      };
    }
    if (est === 'vencido' || (est === 'activo' && isExpiredDate)) {
      return {
        label: 'Comercial: Vencido',
        cls: 'bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/30'
      };
    }
    if (est === 'suspendido') {
      return {
        label: 'Comercial: Suspendido',
        cls: 'bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/30'
      };
    }
    if (est === 'cancelado') {
      return {
        label: 'Comercial: Cancelado',
        cls: 'bg-[#94A3B8]/15 text-[#94A3B8] border-[#94A3B8]/30'
      };
    }
    return {
      label: 'Comercial: No contratado / Pendiente',
      cls: 'bg-[#94A3B8]/15 text-[#94A3B8] border-[#94A3B8]/30'
    };
  })();

  const registrationBadge = (() => {
    switch (deviceIdentity?.registrationStatus) {
      case 'registered':
        return { label: 'Registrado en Firebase', cls: 'bg-[#10B981]/15 text-[#10B981]' };
      case 'paired':
        return { label: 'Vinculado (E2EE)', cls: 'bg-[#00CFE8]/15 text-[#00CFE8]' };
      case 'revoked':
        return { label: 'Dispositivo revocado', cls: 'bg-[#EF4444]/15 text-[#EF4444]' };
      case 'pending_local':
      default:
        return { label: 'Registro en nube pendiente', cls: 'bg-[#F59E0B]/15 text-[#F59E0B]' };
    }
  })();

  return (
    <div className="min-h-screen bg-[#0B1220] text-[#F1F5F9] flex flex-col font-sans selection:bg-[#00CFE8]/20">
      {/* Barra superior limpia */}
      <header className="h-14 border-b border-[#22324C] bg-[#111C2E]/90 backdrop-blur px-4 sm:px-6 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#18263E] border border-[#22324C] flex items-center justify-center text-[#00CFE8]">
            <Shield className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm tracking-wider text-white">VEL 0.1</span>
              <span className="text-[10px] bg-[#00CFE8]/15 text-[#00CFE8] font-semibold px-2 py-0.5 rounded border border-[#00CFE8]/30">
                Oficial
              </span>
            </div>
            <p className="text-[11px] text-[#94A3B8] hidden sm:block">
              Protección inteligente de tu información personal.
            </p>
          </div>
        </div>

        {/* Pestañas de Vista */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode('PHONE_PREVIEW')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              viewMode === 'PHONE_PREVIEW'
                ? 'bg-[#00CFE8] text-[#0B1220] font-bold shadow-md'
                : 'text-[#94A3B8] hover:text-white bg-[#18263E]'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">App VEL (PWA)</span>
            <span className="sm:hidden">VEL</span>
          </button>

          <button
            onClick={() => setViewMode('WEB_PORTAL')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              viewMode === 'WEB_PORTAL'
                ? 'bg-[#00CFE8] text-[#0B1220] font-bold shadow-md'
                : 'text-[#94A3B8] hover:text-white bg-[#18263E]'
            }`}
          >
            <CreditCard className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Portal Web & Contratar</span>
            <span className="sm:hidden">Contratar</span>
          </button>

          <button
            onClick={() => setViewMode('INSTALL_INFO')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              viewMode === 'INSTALL_INFO'
                ? 'bg-[#00CFE8] text-[#0B1220] font-bold shadow-md'
                : 'text-[#94A3B8] hover:text-white bg-[#18263E]'
            }`}
          >
            <Info className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Instalar App (PWA)</span>
            <span className="sm:hidden">Instalar</span>
          </button>

          <PWAInstallButton pwa={pwa} compact />
        </div>
      </header>

      <SWUpdateBanner visible={pwa.swUpdateAvailable} onUpdate={pwa.applySwUpdate} />
      <OfflineIndicator isOnline={isOnline} />

      {/* Contenido principal */}
      <main className="flex-1 flex items-center justify-center p-3 sm:p-6 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-[#111C2E] via-[#0B1220] to-[#070A11]">

        {/* ========================================================= */}
        {/* VISTA 1: APLICACIÓN WEB PROGRESIVA VEL (PWA) */}
        {/* ========================================================= */}
        {viewMode === 'PHONE_PREVIEW' && (
          <div className="flex items-center justify-center w-full">
            {/* Chasis del teléfono Android */}
            <div className="relative w-[375px] h-[780px] bg-[#070A11] rounded-[48px] p-3 shadow-2xl border-4 border-[#22324C] flex flex-col overflow-hidden">
              {/* Altavoz superior y cámara frontal */}
              <div className="absolute top-4 left-1/2 -translate-x-1/2 w-32 h-5 bg-[#0B1220] rounded-full flex items-center justify-center z-50 border border-[#22324C]/60">
                <div className="w-10 h-1 bg-[#22324C] rounded-full"></div>
              </div>

              {/* Pantalla del teléfono */}
              <div className="relative flex-1 bg-[#0B1220] rounded-[38px] flex flex-col pt-7 pb-3 overflow-hidden">

                {/* BOTÓN (ⓘ) DE INFORMACIÓN Y AYUDA */}
                <div className="absolute top-3 right-4 z-40">
                  <button
                    onClick={() => setShowHelpModal(true)}
                    className="w-7 h-7 rounded-full bg-[#111C2E] border border-[#22324C] text-[#94A3B8] hover:text-[#00CFE8] flex items-center justify-center transition-colors cursor-pointer"
                    title="Información y ayuda"
                    aria-label="Información y ayuda"
                  >
                    <Info className="w-4 h-4" />
                  </button>
                </div>

                {/* ============================================== */}
                {/* 0. CARGA INICIAL DE IDENTIDAD PERSISTIDA */}
                {/* ============================================== */}
                {isLoadingIdentity && (
                  <div className="flex-1 px-5 py-6 flex flex-col items-center justify-center text-center space-y-3">
                    <div className="w-12 h-12 rounded-2xl bg-[#111C2E] border border-[#22324C] flex items-center justify-center text-[#00CFE8]">
                      <Loader2 className="w-6 h-6 animate-spin" />
                    </div>
                    <div className="space-y-1">
                      <h2 className="text-sm font-bold text-white">Verificando identidad técnica</h2>
                      <p className="text-[11px] text-[#94A3B8]">
                        Leyendo configuración local protegida en IndexedDB...
                      </p>
                    </div>
                  </div>
                )}

                {/* ============================================== */}
                {/* 1. PANTALLA: PRIMER ACCESO Y ELECCIÓN DEL ROL */}
                {/* ============================================== */}
                {!isLoadingIdentity && currentScreen === 'WELCOME' && (
                  <div className="flex-1 px-5 py-3.5 flex flex-col justify-between space-y-3 overflow-hidden">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] bg-[#00CFE8]/15 text-[#00CFE8] font-bold px-2 py-0.5 rounded border border-[#00CFE8]/30">
                        VEL 0.1
                      </span>
                    </div>

                    {/* Logo Oficial VEL: V minimalista con línea luminosa y punto */}
                    <div className="flex flex-col items-center text-center space-y-1.5 pt-0.5">
                      <div className="w-14 h-14 rounded-2xl bg-[#111C2E] border border-[#22324C] flex items-center justify-center shadow-lg">
                        <svg className="w-9 h-9" viewBox="0 0 100 100" fill="none">
                          <path d="M50 15L85 85H70L50 45L30 85H15L50 15Z" fill="#00CFE8" />
                          <circle cx="50" cy="35" r="5" fill="#FFFFFF" />
                        </svg>
                      </div>

                      <div className="space-y-0.5">
                        <h1 className="text-xl font-extrabold tracking-tight text-white">
                          Bienvenido a VEL
                        </h1>
                        <p className="text-[11px] text-[#94A3B8] max-w-[280px] mx-auto leading-relaxed">
                          Protección inteligente de tu información personal.
                        </p>
                      </div>
                    </div>

                    {/* Presentación de los dos roles */}
                    <div className="w-full space-y-2">
                      <div className="p-3 rounded-2xl bg-[#111C2E] border border-[#22324C] space-y-2">
                        {/* Teléfono 1: VEL CORE */}
                        <div className="p-2.5 rounded-xl bg-[#0B1220] border border-[#00CFE8]/30 flex items-start gap-2.5">
                          <div className="w-7 h-7 rounded-lg bg-[#00CFE8]/10 text-[#00CFE8] flex items-center justify-center shrink-0 mt-0.5 border border-[#00CFE8]/30">
                            <Shield className="w-3.5 h-3.5" />
                          </div>
                          <div>
                            <h4 className="text-xs font-bold text-white">VEL CORE</h4>
                            <p className="text-[10px] text-[#94A3B8] leading-tight">
                              Dispositivo principal. Administra y protege tu información.
                            </p>
                          </div>
                        </div>

                        {/* Teléfono 2: VEL MÓVIL */}
                        <div className="p-2.5 rounded-xl bg-[#0B1220] border border-[#10B981]/30 flex items-start gap-2.5">
                          <div className="w-7 h-7 rounded-lg bg-[#10B981]/10 text-[#10B981] flex items-center justify-center shrink-0 mt-0.5 border border-[#10B981]/30">
                            <Smartphone className="w-3.5 h-3.5" />
                          </div>
                          <div>
                            <h4 className="text-xs font-bold text-white">VEL MÓVIL</h4>
                            <p className="text-[10px] text-[#94A3B8] leading-tight">
                              Dispositivo personal. Se conecta con tu VEL CORE.
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Elección obligatoria inicial */}
                    <div className="space-y-2 pt-0.5">
                      <span className="text-[11px] font-bold text-white block text-center">
                        ¿Qué teléfono estás configurando?
                      </span>

                      <button
                        onClick={() => handleStartDeviceSetup('CORE')}
                        disabled={isSettingUpDevice}
                        className="w-full h-11 rounded-xl bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-extrabold text-xs tracking-wider transition-all shadow-md active:scale-[0.98] cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-60"
                      >
                        <Shield className="w-4 h-4" />
                        <span>CONFIGURAR VEL CORE</span>
                      </button>

                      <button
                        onClick={() => handleStartDeviceSetup('TERMINAL')}
                        disabled={isSettingUpDevice}
                        className="w-full h-11 rounded-xl bg-[#18263E] hover:bg-[#22324C] border border-[#00CFE8]/30 text-white font-bold text-xs tracking-wider transition-all active:scale-[0.98] cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-60"
                      >
                        <Smartphone className="w-4 h-4 text-[#00CFE8]" />
                        <span>CONFIGURAR VEL MÓVIL</span>
                      </button>

                      <div className="pt-1 text-center">
                        <a
                          href={OFFICIAL_CONTRACT_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-[#94A3B8] hover:text-[#00CFE8] transition-colors inline-flex items-center gap-1 cursor-pointer"
                        >
                          <FileText className="w-3 h-3" />
                          <span>Consultar términos y condiciones</span>
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      </div>
                    </div>
                  </div>
                )}

                {/* ============================================== */}
                {/* 1.1 CONFIGURACIÓN AUTOMÁTICA REAL: VEL CORE */}
                {/* ============================================== */}
                {!isLoadingIdentity && currentScreen === 'SETUP_CORE' && (
                  <div className="flex-1 px-5 py-4 flex flex-col justify-between space-y-3 overflow-y-auto">
                    <div className="space-y-3">
                      <div className="space-y-0.5">
                        <h2 className="text-base font-bold text-white">Configuración de VEL CORE</h2>
                        <p className="text-xs text-[#94A3B8]">
                          Identidad técnica única, claves Web Crypto protegidas y registro en Firebase.
                        </p>
                      </div>

                      <div className="p-3.5 rounded-2xl bg-[#111C2E] border border-[#22324C] space-y-2.5">
                        {setupSteps.map((s, idx) => (
                          <div key={s.step} className="space-y-0.5">
                            <div
                              className={`flex items-center gap-2 font-bold text-xs ${
                                s.status === 'done'
                                  ? 'text-[#10B981]'
                                  : s.status === 'error'
                                  ? 'text-[#F59E0B]'
                                  : s.status === 'in_progress'
                                  ? 'text-[#00CFE8]'
                                  : 'text-[#94A3B8]'
                              }`}
                            >
                              {s.status === 'in_progress' ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                              ) : s.status === 'error' ? (
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                              ) : (
                                <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                              )}
                              <span>Paso {idx + 1}:</span>
                            </div>
                            <p className="text-[10px] text-[#94A3B8] leading-snug pl-5">{s.detail}</p>
                          </div>
                        ))}

                        {deviceIdentity && (
                          <div className="pt-2 mt-1 border-t border-[#22324C] space-y-1 font-mono text-[10px]">
                            <div className="flex justify-between text-[#94A3B8]">
                              <span>ID asignado:</span>
                              <strong className="text-white">{deviceIdentity.deviceId}</strong>
                            </div>
                            <div className="flex justify-between text-[#94A3B8]">
                              <span>Huella SHA-256:</span>
                              <span className="text-[#00CFE8]">{deviceIdentity.fingerprint.slice(0, 17)}...</span>
                            </div>
                          </div>
                        )}
                      </div>

                      {!isSettingUpDevice && deviceIdentity?.registrationStatus === 'registered' && (
                        <div className="p-3 rounded-xl bg-[#10B981]/10 border border-[#10B981]/30 text-xs text-[#10B981] space-y-1">
                          <strong>✓ Identidad registrada en Firebase/Firestore</strong>
                          <p className="text-[10px] text-white/90">
                            Este dispositivo quedó persistido como VEL CORE con claves privadas no exportables en almacenamiento local.
                          </p>
                        </div>
                      )}

                      {!isSettingUpDevice && setupError && (
                        <div className="p-3 rounded-xl bg-[#F59E0B]/10 border border-[#F59E0B]/30 text-xs text-[#F59E0B] space-y-2">
                          <p className="text-[10px] leading-snug">
                            <strong>Registro remoto pendiente:</strong> {setupError}
                          </p>
                          {requiresExternalConfig && (
                            <p className="text-[10px] text-white/80 leading-snug">
                              Las claves locales ya quedaron protegidas en IndexedDB. Cuando Firebase Anonymous Auth y el servidor estén listos, pulsa reintentar sin perder tu ID.
                            </p>
                          )}
                          <button
                            type="button"
                            onClick={handleRetryServerRegistration}
                            disabled={isRetryingSync}
                            className="w-full h-8 rounded-lg bg-[#F59E0B] hover:bg-[#D97706] text-[#0B1220] font-bold text-[11px] cursor-pointer disabled:opacity-60"
                          >
                            {isRetryingSync ? 'Reintentando registro...' : 'Reintentar registro en Firestore'}
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <button
                        type="button"
                        disabled={isSettingUpDevice || !deviceIdentity}
                        onClick={() => setCurrentScreen('CORE_HOME')}
                        className="w-full h-11 rounded-xl bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-extrabold text-xs transition-all shadow cursor-pointer disabled:opacity-50"
                      >
                        {isSettingUpDevice ? 'CONFIGURANDO IDENTIDAD...' : 'ACCEDER AL PANEL DE VEL CORE'}
                      </button>

                      {!deviceIdentity && !isSettingUpDevice && (
                        <button
                          type="button"
                          onClick={() => setCurrentScreen('WELCOME')}
                          className="w-full h-9 rounded-xl bg-[#18263E] text-white font-bold text-xs cursor-pointer"
                        >
                          Volver
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* ============================================== */}
                {/* 1.2 CONFIGURACIÓN AUTOMÁTICA REAL: VEL MÓVIL */}
                {/* ============================================== */}
                {!isLoadingIdentity && currentScreen === 'SETUP_MOVIL' && (
                  <div className="flex-1 px-5 py-4 flex flex-col justify-between space-y-3 overflow-y-auto">
                    <div className="space-y-3">
                      <div className="space-y-0.5">
                        <h2 className="text-base font-bold text-white">Configuración de VEL MÓVIL</h2>
                        <p className="text-xs text-[#94A3B8]">
                          Terminal personal sin custodia de datos y con identidad criptográfica propia.
                        </p>
                      </div>

                      <div className="p-3.5 rounded-2xl bg-[#111C2E] border border-[#22324C] space-y-2.5">
                        {setupSteps.map((s, idx) => (
                          <div key={s.step} className="space-y-0.5">
                            <div
                              className={`flex items-center gap-2 font-bold text-xs ${
                                s.status === 'done'
                                  ? 'text-[#10B981]'
                                  : s.status === 'error'
                                  ? 'text-[#F59E0B]'
                                  : s.status === 'in_progress'
                                  ? 'text-[#00CFE8]'
                                  : 'text-[#94A3B8]'
                              }`}
                            >
                              {s.status === 'in_progress' ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                              ) : s.status === 'error' ? (
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                              ) : (
                                <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                              )}
                              <span>Paso {idx + 1}:</span>
                            </div>
                            <p className="text-[10px] text-[#94A3B8] leading-snug pl-5">{s.detail}</p>
                          </div>
                        ))}

                        {deviceIdentity && (
                          <div className="pt-2 mt-1 border-t border-[#22324C] space-y-1 font-mono text-[10px]">
                            <div className="flex justify-between text-[#94A3B8]">
                              <span>ID asignado:</span>
                              <strong className="text-white">{deviceIdentity.deviceId}</strong>
                            </div>
                            <div className="flex justify-between text-[#94A3B8]">
                              <span>Huella SHA-256:</span>
                              <span className="text-[#10B981]">{deviceIdentity.fingerprint.slice(0, 17)}...</span>
                            </div>
                          </div>
                        )}
                      </div>

                      {!isSettingUpDevice && setupError && (
                        <div className="p-3 rounded-xl bg-[#F59E0B]/10 border border-[#F59E0B]/30 text-xs text-[#F59E0B] space-y-2">
                          <p className="text-[10px] leading-snug">
                            <strong>Registro remoto pendiente:</strong> {setupError}
                          </p>
                          <button
                            type="button"
                            onClick={handleRetryServerRegistration}
                            disabled={isRetryingSync}
                            className="w-full h-8 rounded-lg bg-[#F59E0B] hover:bg-[#D97706] text-[#0B1220] font-bold text-[11px] cursor-pointer disabled:opacity-60"
                          >
                            {isRetryingSync ? 'Reintentando registro...' : 'Reintentar registro en Firestore'}
                          </button>
                        </div>
                      )}

                      <div className="p-3 rounded-xl bg-[#0B1220] border border-[#22324C] text-[10px] text-[#94A3B8] space-y-1">
                        <strong className="text-white">Privacidad garantizada:</strong>
                        <p>No se guardan conversaciones, contactos ni documentos personales en este terminal.</p>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={isSettingUpDevice || !deviceIdentity}
                      onClick={() => setCurrentScreen('TERMINAL_HOME')}
                      className="w-full h-11 rounded-xl bg-[#10B981] hover:bg-[#0ea571] text-[#0B1220] font-extrabold text-xs cursor-pointer disabled:opacity-50"
                    >
                      {isSettingUpDevice ? 'CONFIGURANDO TERMINAL...' : 'IR AL PANEL DE VEL MÓVIL'}
                    </button>
                  </div>
                )}

                {/* ============================================== */}
                {/* 2. PANTALLA: SELECCIÓN EXPLÍCITA DE ROL */}
                {/* ============================================== */}
                {!isLoadingIdentity && currentScreen === 'ROLE_SELECTION' && (
                  <div className="flex-1 px-5 py-4 flex flex-col justify-between space-y-3 overflow-y-auto">
                    <div className="space-y-2">
                      <button
                        onClick={() => setCurrentScreen('WELCOME')}
                        className="h-9 px-3 -ml-2 rounded-xl text-[#00CFE8] hover:text-white bg-[#111C2E] border border-[#22324C] flex items-center gap-1.5 text-xs font-bold transition-all cursor-pointer shadow-sm"
                      >
                        <ArrowLeft className="w-4 h-4" />
                        <span>← Volver</span>
                      </button>

                      <div className="space-y-0.5">
                        <h2 className="text-base font-bold text-white">¿Qué teléfono estás configurando?</h2>
                        <p className="text-xs text-[#94A3B8]">Selecciona la función que desempeñará este dispositivo:</p>
                      </div>
                    </div>

                    <div className="space-y-3 flex-1 flex flex-col justify-center">
                      <div className="p-3.5 rounded-2xl bg-[#111C2E] border border-[#00CFE8]/30 space-y-2.5">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-lg bg-[#00CFE8]/10 text-[#00CFE8] flex items-center justify-center border border-[#00CFE8]/30">
                            <Shield className="w-4 h-4" />
                          </div>
                          <div>
                            <h3 className="font-bold text-xs text-white">VEL CORE</h3>
                            <p className="text-[10px] text-[#00CFE8]">Dispositivo principal</p>
                          </div>
                        </div>

                        <ul className="text-[11px] text-[#94A3B8] space-y-1 list-disc list-inside">
                          <li>Guarda las claves y los datos bajo su responsabilidad.</li>
                          <li>Administra y autoriza al teléfono MÓVIL.</li>
                        </ul>

                        <button
                          onClick={() => handleStartDeviceSetup('CORE')}
                          disabled={isSettingUpDevice}
                          className="w-full h-10 rounded-xl bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-bold text-xs transition-all shadow cursor-pointer"
                        >
                          CONFIGURAR COMO VEL CORE
                        </button>
                      </div>

                      <div className="p-3.5 rounded-2xl bg-[#111C2E] border border-[#10B981]/30 space-y-2.5">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-lg bg-[#10B981]/10 text-[#10B981] flex items-center justify-center border border-[#10B981]/30">
                            <Smartphone className="w-4 h-4" />
                          </div>
                          <div>
                            <h3 className="font-bold text-xs text-white">VEL MÓVIL</h3>
                            <p className="text-[10px] text-[#10B981]">Dispositivo de uso diario</p>
                          </div>
                        </div>

                        <ul className="text-[11px] text-[#94A3B8] space-y-1 list-disc list-inside">
                          <li>Se conecta con VEL CORE.</li>
                          <li>Permite acceder a las funciones autorizadas.</li>
                        </ul>

                        <button
                          onClick={() => handleStartDeviceSetup('TERMINAL')}
                          disabled={isSettingUpDevice}
                          className="w-full h-10 rounded-xl bg-[#10B981] hover:bg-[#0ea571] text-[#0B1220] font-bold text-xs transition-all shadow cursor-pointer"
                        >
                          CONFIGURAR COMO VEL MÓVIL
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ============================================== */}
                {/* 3. PANTALLA: PANEL PRINCIPAL VEL CORE */}
                {/* ============================================== */}
                {!isLoadingIdentity && currentScreen === 'CORE_HOME' && deviceIdentity && (
                  <div className="flex-1 px-5 py-3.5 flex flex-col justify-between space-y-3 overflow-y-auto">
                    <div className="space-y-3">
                      {/* Cabecera */}
                      <div className="flex items-center justify-between pb-2 border-b border-[#22324C]">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-[#00CFE8]/10 border border-[#00CFE8]/30 flex items-center justify-center text-[#00CFE8]">
                            <Shield className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="flex items-center gap-1.5">
                              <h2 className="font-bold text-sm text-white leading-none">VEL CORE</h2>
                              <span className="text-[9px] bg-[#00CFE8]/15 text-[#00CFE8] font-bold px-1.5 py-0.5 rounded">
                                Principal
                              </span>
                            </div>
                            <p className="text-[10px] text-[#94A3B8] font-mono mt-0.5">
                              ID: {deviceIdentity.deviceId}
                            </p>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setRoleChangeConfirmInput('');
                            setRoleChangeError(null);
                            setShowRoleChangeModal(true);
                          }}
                          className="p-1.5 rounded-lg bg-[#111C2E] border border-[#22324C] text-[#94A3B8] hover:text-white cursor-pointer"
                          title="Cambio controlado de rol"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Estado técnico real en Firebase / IndexedDB */}
                      <div className="p-3 rounded-2xl bg-[#111C2E] border border-[#22324C] space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-white flex items-center gap-1.5">
                            <Key className="w-3.5 h-3.5 text-[#00CFE8]" />
                            <span>Identidad Técnica</span>
                          </span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${registrationBadge.cls}`}>
                            {registrationBadge.label}
                          </span>
                        </div>

                        <div className="p-2 rounded-xl bg-[#0B1220] border border-[#22324C] space-y-1 text-[10px] font-mono">
                          <div className="flex justify-between text-[#94A3B8]">
                            <span>Huella pública:</span>
                            <span className="text-[#00CFE8]">{deviceIdentity.fingerprint.slice(0, 17)}...</span>
                          </div>
                          <div className="flex justify-between text-[#94A3B8]">
                            <span>Claves privadas:</span>
                            <span className="text-[#10B981]">No exportables (Web Crypto)</span>
                          </div>
                          {deviceIdentity.firebaseAuthUid && (
                            <div className="flex justify-between text-[#94A3B8]">
                              <span>Sesión Firebase UID:</span>
                              <span className="text-white">{deviceIdentity.firebaseAuthUid.slice(0, 10)}...</span>
                            </div>
                          )}
                        </div>

                        {deviceIdentity.registrationStatus === 'pending_local' && (
                          <div className="space-y-1.5 pt-0.5">
                            {setupError && (
                              <p className="text-[10px] text-[#F59E0B] leading-snug">{setupError}</p>
                            )}
                            <button
                              type="button"
                              onClick={handleRetryServerRegistration}
                              disabled={isRetryingSync}
                              className="w-full h-8 rounded-lg bg-[#F59E0B] hover:bg-[#D97706] text-[#0B1220] font-bold text-[11px] cursor-pointer disabled:opacity-60"
                            >
                              {isRetryingSync ? 'Registrando...' : 'Completar registro en Firestore'}
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Sección: Teléfono móvil vinculado y estado real del Relay */}
                      <div className="p-3.5 rounded-2xl bg-[#111C2E] border border-[#22324C] space-y-2.5">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-bold text-white uppercase tracking-wider">
                            Mi teléfono móvil
                          </span>
                          {(() => {
                            const rb = formatRelayBadge(relaySnapshot.connectionState, relaySnapshot.peerOnline);
                            return (
                              <span className={`text-[9px] font-bold px-2 py-0.5 rounded border ${rb.cls}`}>
                                {rb.label}
                              </span>
                            );
                          })()}
                        </div>

                        {!relayConfig.loading && !relayConfig.configured && (
                          <div className="p-2 rounded-xl bg-[#F59E0B]/10 border border-[#F59E0B]/30 text-[10px] text-[#F59E0B] leading-snug space-y-1">
                            <strong>Relay externo pendiente de configuración:</strong>
                            <p className="text-white/80">
                              Define <code className="text-[#00CFE8]">VEL_RELAY_WSS_URL</code> en Netlify con la URL real <code className="text-[#00CFE8]">wss://...</code> de tu servidor Relay desplegado.
                            </p>
                          </div>
                        )}

                        {relaySnapshot.lastError && (
                          <div className="p-2 rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/30 text-[10px] text-[#FCA5A5] flex items-center justify-between gap-2">
                            <span className="leading-snug">{relaySnapshot.lastError}</span>
                            <button
                              type="button"
                              onClick={handleReconnectRelay}
                              className="px-2 py-1 rounded bg-[#18263E] text-[#00CFE8] font-bold shrink-0 cursor-pointer"
                            >
                              Reintentar
                            </button>
                          </div>
                        )}

                        {deviceIdentity.pairedPeerDeviceId ? (
                          <div className="p-2.5 rounded-xl bg-[#0B1220] border border-[#22324C] space-y-1">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Smartphone className="w-4 h-4 text-[#00CFE8]" />
                                <span className="text-xs font-bold text-white font-mono">
                                  {deviceIdentity.pairedPeerDeviceId}
                                </span>
                              </div>
                              <span
                                className={`w-2 h-2 rounded-full ${
                                  relaySnapshot.peerOnline ? 'bg-[#10B981]' : 'bg-[#94A3B8]'
                                }`}
                                title={relaySnapshot.peerOnline ? 'En línea' : 'Desconectado'}
                              />
                            </div>
                            <p className="text-[10px] text-[#94A3B8]">
                              {relaySnapshot.connectionState === 'LINKED'
                                ? 'Clave de sesión AES-256-GCM derivada en memoria (no exportable).'
                                : 'Vínculo autorizado en Firestore.'}
                            </p>
                          </div>
                        ) : (
                          <div className="p-2.5 rounded-xl bg-[#0B1220] border border-[#22324C] text-center space-y-1">
                            <p className="text-[11px] text-white font-bold">
                              Ningún VEL MÓVIL vinculado todavía
                            </p>
                            <p className="text-[10px] text-[#94A3B8] leading-snug">
                              Genera una invitación temporal de 5 minutos en Vincular para emparejar con código SAS de 6 dígitos.
                            </p>
                          </div>
                        )}

                        {/* Canal cifrado E2EE en tiempo real (cuando está vinculado) */}
                        {deviceIdentity.pairedPeerDeviceId && (
                          <div className="p-2.5 rounded-xl bg-[#0B1220] border border-[#00CFE8]/25 space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-bold text-[#00CFE8] uppercase tracking-wider flex items-center gap-1">
                                <Lock className="w-3 h-3" />
                                <span>Canal Cifrado E2EE</span>
                              </span>
                              {relaySnapshot.connectionState !== 'LINKED' && (
                                <button
                                  type="button"
                                  onClick={handleReconnectRelay}
                                  className="text-[9px] text-[#00CFE8] hover:underline cursor-pointer"
                                >
                                  Reconectar
                                </button>
                              )}
                            </div>

                            <form onSubmit={(e) => void handleSendE2eeVerification(e)} className="flex gap-1.5">
                              <input
                                type="text"
                                value={e2eeMessageInput}
                                onChange={(e) => setE2eeMessageInput(e.target.value)}
                                placeholder="Texto de prueba cifrado E2EE..."
                                className="flex-1 h-8 px-2.5 rounded-lg bg-[#111C2E] border border-[#22324C] text-[10px] text-white placeholder-[#94A3B8]/60 focus:outline-none focus:border-[#00CFE8]"
                              />
                              <button
                                type="submit"
                                disabled={isSendingE2ee || relaySnapshot.connectionState !== 'LINKED'}
                                className="h-8 px-2.5 rounded-lg bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-bold text-[10px] flex items-center gap-1 cursor-pointer disabled:opacity-45 shrink-0"
                              >
                                <Send className="w-3 h-3" />
                                <span>Probar</span>
                              </button>
                            </form>

                            {e2eeNotice && (
                              <p className="text-[9px] text-[#F59E0B] leading-tight">{e2eeNotice}</p>
                            )}

                            {relaySnapshot.operations.slice(0, 2).map((op) => {
                              const st = formatOpStatusLabel(op.status);
                              return (
                                <div
                                  key={op.operationId}
                                  className="p-1.5 rounded-lg bg-[#111C2E] border border-[#22324C] text-[9px] space-y-0.5"
                                >
                                  <div className="flex items-center justify-between gap-1">
                                    <span className="text-white truncate">{op.previewLabel}</span>
                                    <span className={`font-bold shrink-0 ${st.cls}`}>{st.text}</span>
                                  </div>
                                  <div className="flex items-center justify-between text-[#94A3B8]">
                                    <span className="truncate">{op.statusDetail}</span>
                                    {(op.status === 'FAILED' || op.status === 'UNKNOWN') &&
                                      op.direction === 'OUTGOING' && (
                                        <button
                                          type="button"
                                          onClick={() => void handleSendE2eeVerification(undefined, op.previewLabel)}
                                          className="text-[#00CFE8] font-bold ml-1 shrink-0 cursor-pointer"
                                        >
                                          Reintentar
                                        </button>
                                      )}
                                  </div>
                                </div>
                              );
                            })}

                            {relaySnapshot.receivedMessages.length > 0 && (
                              <div className="p-1.5 rounded-lg bg-[#10B981]/10 border border-[#10B981]/25 text-[9px] space-y-1">
                                <span className="text-[#10B981] font-bold block">
                                  Último recibido y descifrado en memoria:
                                </span>
                                <span className="text-white break-words block">
                                  {relaySnapshot.receivedMessages[0].text}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleArchiveIncomingMessageInCore(
                                      relaySnapshot.receivedMessages[0].text,
                                      relaySnapshot.receivedMessages[0].operationId
                                    )
                                  }
                                  className="px-2 py-0.5 rounded bg-[#00CFE8]/15 border border-[#00CFE8]/40 text-[#00CFE8] font-bold cursor-pointer"
                                >
                                  Guardar cifrado en bóveda CORE
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Botones de acción de VEL CORE */}
                        <div className="grid grid-cols-2 gap-2 pt-1">
                          <button
                            onClick={() => setCurrentScreen('PAIRING_CORE')}
                            className="h-9 rounded-xl bg-[#18263E] hover:bg-[#22324C] border border-[#22324C] text-[#00CFE8] font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>VINCULAR</span>
                          </button>

                          <button
                            onClick={() => setCurrentScreen('DEVICE_MANAGEMENT')}
                            className="h-9 rounded-xl bg-[#18263E] hover:bg-[#22324C] border border-[#22324C] text-white font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                          >
                            <Smartphone className="w-3.5 h-3.5 text-[#00CFE8]" />
                            <span>ADMINISTRAR</span>
                          </button>
                        </div>

                        <button
                          onClick={() => setCurrentScreen('REPLACE_PHONE')}
                          className="w-full h-9 rounded-xl bg-[#111C2E] hover:bg-[#18263E] border border-[#00CFE8]/40 text-[#00CFE8] font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>REEMPLAZAR TELÉFONO MÓVIL</span>
                        </button>
                      </div>

                      {/* Estado Comercial independiente del Estado Técnico */}
                      <div className="p-2.5 rounded-2xl bg-[#111C2E] border border-[#22324C] space-y-1">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[10px] font-bold text-white">Estado comercial</span>
                          <span className={`text-[9px] font-bold px-2 py-0.5 rounded border ${commercialStatusBadge.cls}`}>
                            {commercialStatusBadge.label}
                          </span>
                        </div>
                        <p className="text-[9px] text-[#94A3B8] leading-snug">
                          El estado comercial es independiente: una suspensión comercial nunca borra tus registros locales ni revoca tus dispositivos.
                        </p>
                      </div>

                      {/* Bóveda Local Cifrada (Custodia exclusiva de VEL CORE) */}
                      <div className="p-3 rounded-2xl bg-[#111C2E] border border-[#00CFE8]/30 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-white flex items-center gap-1.5">
                            <Database className="w-3.5 h-3.5 text-[#00CFE8]" />
                            <span>Bóveda Local Cifrada (CORE)</span>
                          </span>
                          <span className="text-[9px] font-mono bg-[#00CFE8]/15 text-[#00CFE8] px-2 py-0.5 rounded font-bold">
                            {coreVaultRecords.length} registro{coreVaultRecords.length === 1 ? '' : 's'}
                          </span>
                        </div>

                        <form onSubmit={handleSaveCoreVaultNote} className="space-y-1.5">
                          <input
                            type="text"
                            value={vaultNoteTitle}
                            onChange={(e) => setVaultNoteTitle(e.target.value)}
                            placeholder="Título del registro local..."
                            className="w-full h-7 px-2.5 rounded-lg bg-[#0B1220] border border-[#22324C] text-[10px] text-white placeholder-[#94A3B8]/60 focus:outline-none focus:border-[#00CFE8]"
                          />
                          <div className="flex gap-1.5">
                            <input
                              type="text"
                              value={vaultNoteBody}
                              onChange={(e) => setVaultNoteBody(e.target.value)}
                              placeholder="Dato personal (cifrado solo aquí)..."
                              className="flex-1 h-7 px-2.5 rounded-lg bg-[#0B1220] border border-[#22324C] text-[10px] text-white placeholder-[#94A3B8]/60 focus:outline-none focus:border-[#00CFE8]"
                            />
                            <button
                              type="submit"
                              disabled={isSavingVaultNote}
                              className="h-7 px-2.5 rounded-lg bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-bold text-[10px] cursor-pointer disabled:opacity-50 shrink-0"
                            >
                              {isSavingVaultNote ? '...' : 'Guardar'}
                            </button>
                          </div>
                        </form>

                        {vaultError && (
                          <p className="text-[9px] text-[#EF4444]">{vaultError}</p>
                        )}

                        {decryptedVaultNote && (
                          <div className="p-2 rounded-xl bg-[#0B1220] border border-[#10B981]/40 text-[10px] space-y-1">
                            <div className="flex items-center justify-between">
                              <strong className="text-[#10B981] truncate">{decryptedVaultNote.title}</strong>
                              <button
                                type="button"
                                onClick={() => setDecryptedVaultNote(null)}
                                className="text-[9px] text-[#94A3B8] hover:text-white inline-flex items-center gap-0.5 cursor-pointer"
                              >
                                <EyeOff className="w-3 h-3" />
                                <span>Ocultar</span>
                              </button>
                            </div>
                            <p className="text-white break-words">{decryptedVaultNote.content}</p>
                          </div>
                        )}

                        {coreVaultRecords.length > 0 && (
                          <div className="max-h-24 overflow-y-auto space-y-1">
                            {coreVaultRecords.slice(0, 5).map((rec) => (
                              <div
                                key={rec.id}
                                className="p-1.5 rounded-lg bg-[#0B1220] border border-[#22324C] flex items-center justify-between gap-2 text-[9px]"
                              >
                                <span className="font-mono text-[#94A3B8] truncate">{rec.id}</span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => void handleOpenCoreVaultNote(rec.id)}
                                    className="text-[#00CFE8] hover:underline inline-flex items-center gap-0.5 cursor-pointer"
                                  >
                                    <Eye className="w-3 h-3" />
                                    <span>Ver</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleDeleteCoreVaultNote(rec.id)}
                                    className="text-[#EF4444] hover:underline inline-flex items-center cursor-pointer"
                                    title="Eliminar registro local"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        <p className="text-[9px] text-[#94A3B8] leading-tight">
                          Cifrado AES-256-GCM en IndexedDB (sin envío a Firebase, Netlify ni Relay). Si borras los datos del navegador CORE, no existe recuperación en la nube.
                        </p>
                      </div>

                      {/* SECCIÓN DESTACADA: EMERGENCIA Y REVOCACIÓN */}
                      <div className="p-3.5 rounded-2xl bg-gradient-to-br from-[#1A1A2E] to-[#161226] border border-[#EF4444]/40 space-y-2">
                        <div className="flex items-start gap-2">
                          <div className="w-7 h-7 rounded-lg bg-[#EF4444]/15 border border-[#EF4444]/30 flex items-center justify-center text-[#EF4444] shrink-0 mt-0.5">
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </div>
                          <div>
                            <h4 className="text-xs font-bold text-white leading-tight">¿PERDISTE TU TELÉFONO O TE LO ROBARON?</h4>
                            <p className="text-[10px] text-[#94A3B8] leading-tight mt-0.5">
                              Inicia el procedimiento de emergencia ante pérdida o robo.
                            </p>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setRevokeFeedback(null);
                            setShowEmergencyModal(true);
                          }}
                          className="w-full h-10 rounded-xl bg-[#DC2626] hover:bg-[#B91C1C] text-white font-extrabold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-lg active:scale-[0.98]"
                        >
                          <AlertTriangle className="w-4 h-4" />
                          <span>EMERGENCIA Y REVOCACIÓN</span>
                        </button>
                      </div>
                    </div>

                    <div className="text-center pt-1 border-t border-[#22324C]">
                      <a
                        href={OFFICIAL_CONTRACT_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-[#94A3B8] hover:text-[#00CFE8] inline-flex items-center gap-1"
                      >
                        <FileText className="w-3 h-3" />
                        <span>Consultar términos y condiciones</span>
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    </div>
                  </div>
                )}

                {/* ============================================== */}
                {/* 4. PANTALLA: PANEL VEL MÓVIL */}
                {/* ============================================== */}
                {!isLoadingIdentity && currentScreen === 'TERMINAL_HOME' && deviceIdentity && (
                  <div className="flex-1 px-5 py-3.5 flex flex-col justify-between space-y-3 overflow-y-auto">
                    <div className="space-y-3">
                      {/* Cabecera */}
                      <div className="flex items-center justify-between pb-2 border-b border-[#22324C]">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-[#10B981]/10 border border-[#10B981]/30 flex items-center justify-center text-[#10B981]">
                            <Smartphone className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="flex items-center gap-1.5">
                              <h2 className="font-bold text-sm text-white leading-none">VEL MÓVIL</h2>
                              <span className="text-[9px] bg-[#10B981]/15 text-[#10B981] font-bold px-1.5 py-0.5 rounded">
                                Terminal
                              </span>
                            </div>
                            <p className="text-[10px] text-[#94A3B8] font-mono mt-0.5">
                              ID: {deviceIdentity.deviceId}
                            </p>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setRoleChangeConfirmInput('');
                            setRoleChangeError(null);
                            setShowRoleChangeModal(true);
                          }}
                          className="p-1.5 rounded-lg bg-[#111C2E] border border-[#22324C] text-[#94A3B8] hover:text-white cursor-pointer"
                          title="Cambio controlado de rol"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Estado real con VEL CORE */}
                      <div className="p-3.5 rounded-2xl bg-[#111C2E] border border-[#22324C] space-y-2">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-bold text-white uppercase tracking-wider">
                            Estado en red VEL
                          </span>
                          {(() => {
                            const rb = formatRelayBadge(relaySnapshot.connectionState, relaySnapshot.peerOnline);
                            return (
                              <span className={`text-[9px] font-bold px-2 py-0.5 rounded border ${rb.cls}`}>
                                {rb.label}
                              </span>
                            );
                          })()}
                        </div>

                        <div className="p-2.5 rounded-xl bg-[#0B1220] border border-[#22324C] flex items-center justify-between">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-[#18263E] border border-[#22324C] flex items-center justify-center text-[#10B981]">
                              <Shield className="w-4 h-4" />
                            </div>
                            <div>
                              <h4 className="text-xs font-bold text-white leading-none">VEL CORE asociado</h4>
                              <p className="text-[10px] text-[#94A3B8] mt-0.5 font-mono">
                                {deviceIdentity.pairedPeerDeviceId
                                  ? `ID: ${deviceIdentity.pairedPeerDeviceId}`
                                  : 'Aún no vinculado'}
                              </p>
                            </div>
                          </div>
                          <span
                            className={`w-2.5 h-2.5 rounded-full ${
                              deviceIdentity.registrationStatus === 'revoked'
                                ? 'bg-[#EF4444]'
                                : relaySnapshot.connectionState === 'LINKED' && relaySnapshot.peerOnline
                                ? 'bg-[#10B981]'
                                : deviceIdentity.pairedPeerDeviceId
                                ? 'bg-[#00CFE8]'
                                : 'bg-[#F59E0B]'
                            }`}
                          ></span>
                        </div>

                        {!relayConfig.loading && !relayConfig.configured && (
                          <div className="p-2 rounded-xl bg-[#F59E0B]/10 border border-[#F59E0B]/30 text-[10px] text-[#F59E0B] leading-snug">
                            Relay externo pendiente de configuración (<code className="text-[#00CFE8]">VEL_RELAY_WSS_URL</code>).
                          </div>
                        )}

                        {deviceIdentity.registrationStatus === 'revoked' && (
                          <div className="p-2.5 rounded-xl bg-[#EF4444]/15 border border-[#EF4444]/30 text-[#FCA5A5] text-[11px] leading-tight">
                            {relaySnapshot.lastRevocationMessage ||
                              'Acceso revocado permanentemente por VEL CORE para esta identidad técnica.'}
                          </div>
                        )}

                        {deviceIdentity.registrationStatus === 'pending_local' && (
                          <div className="space-y-1.5">
                            {setupError && (
                              <p className="text-[10px] text-[#F59E0B] leading-snug">{setupError}</p>
                            )}
                            <button
                              type="button"
                              onClick={handleRetryServerRegistration}
                              disabled={isRetryingSync}
                              className="w-full h-8 rounded-lg bg-[#F59E0B] hover:bg-[#D97706] text-[#0B1220] font-bold text-[11px] cursor-pointer disabled:opacity-60"
                            >
                              {isRetryingSync ? 'Registrando...' : 'Completar registro en Firestore'}
                            </button>
                          </div>
                        )}

                        {relaySnapshot.lastError && deviceIdentity.registrationStatus !== 'revoked' && (
                          <div className="p-2 rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/30 text-[10px] text-[#FCA5A5] flex items-center justify-between gap-2">
                            <span>{relaySnapshot.lastError}</span>
                            <button
                              type="button"
                              onClick={handleReconnectRelay}
                              className="px-2 py-1 rounded bg-[#18263E] text-[#00CFE8] font-bold shrink-0 cursor-pointer"
                            >
                              Reconectar
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Emparejamiento desde VEL MÓVIL (cuando aún no está vinculado) */}
                      {!deviceIdentity.pairedPeerDeviceId &&
                        deviceIdentity.registrationStatus === 'registered' && (
                          <div className="p-3.5 rounded-2xl bg-[#111C2E] border border-[#10B981]/30 space-y-2.5">
                            <div className="flex items-center gap-2 text-[#10B981] text-xs font-bold">
                              <Radio className="w-4 h-4" />
                              <span>Vincular con VEL CORE</span>
                            </div>

                            {relaySnapshot.pairingSession?.stage === 'SAS_PENDING' ||
                            relaySnapshot.pairingSession?.stage === 'SAS_AWAITING_PEER' ? (
                              <div className="space-y-2.5">
                                <div className="p-3 rounded-xl bg-[#0B1220] border border-[#10B981]/40 text-center space-y-1.5">
                                  <span className="text-[10px] font-bold text-[#10B981] uppercase tracking-wider block">
                                    Verificación de Seguridad (SAS)
                                  </span>
                                  <div className="text-2xl font-mono font-extrabold tracking-[0.22em] text-[#10B981] py-1">
                                    {relaySnapshot.pairingSession.sasCode || '---'}
                                  </div>
                                  <div className="text-[10px] text-[#94A3B8] font-mono space-y-0.5">
                                    <p>CORE: {relaySnapshot.pairingSession.peerDeviceId}</p>
                                    {relaySnapshot.pairingSession.peerFingerprint && (
                                      <p className="text-[#00CFE8]">
                                        Huella: {relaySnapshot.pairingSession.peerFingerprint.slice(0, 17)}...
                                      </p>
                                    )}
                                  </div>
                                </div>

                                {relaySnapshot.pairingSession.localConfirmedSas ||
                                relaySnapshot.pairingSession.stage === 'SAS_AWAITING_PEER' ? (
                                  <div className="space-y-2">
                                    <button
                                      type="button"
                                      disabled
                                      className="w-full h-10 rounded-xl bg-[#18263E] text-[#10B981] border border-[#10B981]/30 font-bold text-xs opacity-90 cursor-not-allowed"
                                    >
                                      ✓ Confirmado. Esperando a VEL CORE...
                                    </button>
                                    <p className="text-[10px] text-[#94A3B8] leading-snug text-center">
                                      Ambos dispositivos deben confirmar para completar el emparejamiento cifrado.
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() => relayClientRef.current!.cancelPairing('CANCELLED_BY_TERMINAL')}
                                      className="w-full h-8 rounded-lg border border-[#EF4444]/40 text-[#EF4444] text-[10px] font-bold cursor-pointer"
                                    >
                                      Cancelar vinculación
                                    </button>
                                  </div>
                                ) : (
                                  <div className="space-y-2">
                                    <p className="text-[10px] text-[#94A3B8] leading-snug text-center">
                                      Compara este código de seguridad con el que aparece en tu VEL CORE. Pulsa confirmar solo si coinciden visualmente.
                                    </p>
                                    <div className="grid grid-cols-2 gap-2">
                                      <button
                                        type="button"
                                        onClick={() => relayClientRef.current!.cancelPairing('SAS_MISMATCH')}
                                        className="h-10 rounded-xl border border-[#EF4444]/50 text-[#EF4444] font-bold text-xs cursor-pointer"
                                      >
                                        No coincide
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          try {
                                            relayClientRef.current?.confirmPairingSas();
                                          } catch (err) {
                                            console.error('Error al confirmar SAS en Móvil:', err);
                                          }
                                        }}
                                        className="h-10 rounded-xl bg-[#10B981] hover:bg-[#0ea571] text-[#0B1220] font-extrabold text-xs cursor-pointer"
                                      >
                                        Confirmar SAS
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <form onSubmit={handleClaimPairingCode} className="space-y-2">
                                <p className="text-[10px] text-[#94A3B8] leading-snug">
                                  Ingresa el código temporal de 8 caracteres generado en la pantalla Vincular de VEL CORE:
                                </p>
                                <input
                                  type="text"
                                  value={pairingCodeInput}
                                  onChange={(e) => setPairingCodeInput(e.target.value.toUpperCase())}
                                  placeholder="Ej: ABCD-2345"
                                  className="w-full h-9 px-3 rounded-xl bg-[#0B1220] border border-[#22324C] text-xs font-mono text-white text-center tracking-widest uppercase focus:outline-none focus:border-[#10B981]"
                                />
                                <button
                                  type="submit"
                                  disabled={
                                    isClaimingPairing ||
                                    relaySnapshot.connectionState !== 'AUTHENTICATED' ||
                                    !pairingCodeInput.trim()
                                  }
                                  className="w-full h-9 rounded-xl bg-[#10B981] hover:bg-[#0ea571] text-[#0B1220] font-bold text-xs cursor-pointer disabled:opacity-45"
                                >
                                  {isClaimingPairing ? 'Enviando solicitud...' : 'Conectar con VEL CORE'}
                                </button>
                              </form>
                            )}
                          </div>
                        )}

                      {/* Canal cifrado E2EE en VEL MÓVIL (cuando ya está vinculado) */}
                      {deviceIdentity.pairedPeerDeviceId &&
                        deviceIdentity.registrationStatus === 'paired' && (
                          <div className="p-3 rounded-2xl bg-[#111C2E] border border-[#00CFE8]/25 space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-bold text-[#00CFE8] uppercase tracking-wider flex items-center gap-1">
                                <Lock className="w-3 h-3" />
                                <span>Canal Cifrado E2EE con CORE</span>
                              </span>
                              <span className="text-[9px] text-[#94A3B8] font-mono">
                                {relaySnapshot.peerOnline ? 'CORE en línea' : 'CORE desconectado'}
                              </span>
                            </div>

                            <form onSubmit={(e) => void handleSendE2eeVerification(e)} className="flex gap-1.5">
                              <input
                                type="text"
                                value={e2eeMessageInput}
                                onChange={(e) => setE2eeMessageInput(e.target.value)}
                                placeholder="Enviar prueba cifrada a CORE..."
                                className="flex-1 h-8 px-2.5 rounded-lg bg-[#0B1220] border border-[#22324C] text-[10px] text-white placeholder-[#94A3B8]/60 focus:outline-none focus:border-[#00CFE8]"
                              />
                              <button
                                type="submit"
                                disabled={isSendingE2ee || relaySnapshot.connectionState !== 'LINKED'}
                                className="h-8 px-2.5 rounded-lg bg-[#10B981] hover:bg-[#0ea571] text-[#0B1220] font-bold text-[10px] flex items-center gap-1 cursor-pointer disabled:opacity-45 shrink-0"
                              >
                                <Send className="w-3 h-3" />
                                <span>Enviar</span>
                              </button>
                            </form>

                            {relaySnapshot.operations.slice(0, 2).map((op) => {
                              const st = formatOpStatusLabel(op.status);
                              return (
                                <div
                                  key={op.operationId}
                                  className="p-1.5 rounded-lg bg-[#0B1220] border border-[#22324C] text-[9px] space-y-0.5"
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="text-white truncate">{op.previewLabel}</span>
                                    <span className={`font-bold shrink-0 ${st.cls}`}>{st.text}</span>
                                  </div>
                                  <p className="text-[#94A3B8] truncate">{op.statusDetail}</p>
                                </div>
                              );
                            })}

                            {relaySnapshot.receivedMessages.length > 0 && (
                              <div className="p-1.5 rounded-lg bg-[#10B981]/10 border border-[#10B981]/25 text-[9px] space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[#10B981] font-bold">
                                    Recibido en memoria (sin guardar en disco):
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => relayClientRef.current?.clearReceivedMessages()}
                                    className="text-[9px] text-[#00CFE8] hover:underline font-semibold cursor-pointer shrink-0"
                                  >
                                    Limpiar memoria
                                  </button>
                                </div>
                                <span className="text-white break-words block">
                                  {relaySnapshot.receivedMessages[0].text}
                                </span>
                              </div>
                            )}
                          </div>
                        )}

                      {/* Arquitectura de Acceso Autorizado */}
                      <div className="p-3 rounded-2xl bg-[#111C2E] border border-[#22324C] space-y-1.5">
                        <div className="flex items-center gap-2 text-white">
                          <Lock className="w-3.5 h-3.5 text-[#00CFE8]" />
                          <h4 className="text-[11px] font-bold uppercase tracking-wider">Terminal de Acceso y Operación</h4>
                        </div>
                        <p className="text-[10px] text-[#94A3B8] leading-snug">
                          VEL CORE es el custodio exclusivo. No se guardan mensajes, fotos ni datos personales en este teléfono móvil.
                        </p>
                      </div>

                      {/* Datos técnicos reales persistidos localmente */}
                      <div className="p-2.5 rounded-2xl bg-[#0B1220] border border-[#22324C] space-y-1 text-[10px]">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-white">Estado técnico local:</span>
                          <button
                            type="button"
                            onClick={handleRefreshDeviceSession}
                            disabled={isRetryingSync}
                            className="text-[10px] text-[#00CFE8] hover:underline cursor-pointer disabled:opacity-50"
                          >
                            {isRetryingSync ? 'Sincronizando...' : 'Sincronizar'}
                          </button>
                        </div>
                        <div className="flex justify-between text-[#94A3B8] font-mono">
                          <span>Huella pública:</span>
                          <span className="text-[#00CFE8]">{deviceIdentity.fingerprint.slice(0, 17)}...</span>
                        </div>
                      </div>
                    </div>

                    <div className="text-center pt-1 border-t border-[#22324C]">
                      <a
                        href={OFFICIAL_CONTRACT_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-[#94A3B8] hover:text-[#00CFE8] inline-flex items-center gap-1"
                      >
                        <FileText className="w-3 h-3" />
                        <span>Consultar términos y condiciones</span>
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    </div>
                  </div>
                )}

                {/* ============================================== */}
                {/* 5. PANTALLA: EMPAREJAMIENTO EN VIVO CON SAS (CORE) */}
                {/* ============================================== */}
                {!isLoadingIdentity && currentScreen === 'PAIRING_CORE' && deviceIdentity && (
                  <div className="flex-1 px-5 py-4 flex flex-col justify-between space-y-3 overflow-y-auto">
                    <div className="space-y-3">
                      <button
                        onClick={() => setCurrentScreen('CORE_HOME')}
                        className="h-9 px-3 -ml-2 rounded-xl text-[#00CFE8] hover:text-white bg-[#111C2E] border border-[#22324C] flex items-center gap-1.5 text-xs font-bold transition-all cursor-pointer shadow-sm"
                      >
                        <ArrowLeft className="w-4 h-4" />
                        <span>← Volver</span>
                      </button>

                      <div className="space-y-0.5">
                        <h2 className="text-base font-bold text-white">Vincular teléfono móvil</h2>
                        <p className="text-xs text-[#94A3B8]">
                          Invitación efímera de un solo uso y verificación criptográfica SAS de 6 dígitos.
                        </p>
                      </div>

                      {!relayConfig.configured && (
                        <div className="p-3 rounded-xl bg-[#F59E0B]/10 border border-[#F59E0B]/30 text-[11px] text-[#F59E0B] space-y-1">
                          <strong>Relay WebSocket no configurado:</strong>
                          <p className="text-[10px] text-white/85">
                            Configura la variable <code className="text-[#00CFE8]">VEL_RELAY_WSS_URL</code> en Netlify apuntando al servidor Relay desplegado para habilitar el emparejamiento entre dos teléfonos.
                          </p>
                        </div>
                      )}

                      {relaySnapshot.pairingSession?.stage === 'OFFERING' && (
                        <div className="p-4 rounded-2xl bg-[#111C2E] border border-[#00CFE8]/40 space-y-3 text-center">
                          <span className="text-[10px] text-[#94A3B8] uppercase font-bold tracking-wider block">
                            Código temporal (válido 5 minutos)
                          </span>
                          <div className="text-2xl font-mono font-extrabold text-[#00CFE8] tracking-widest bg-[#0B1220] py-2.5 rounded-xl border border-[#22324C]">
                            {relaySnapshot.pairingSession.code}
                          </div>
                          <div className="flex items-center justify-center gap-3 text-[10px] text-[#94A3B8]">
                            <span>
                              Expira en:{' '}
                              <strong className="text-white font-mono">
                                {Math.floor(pairingCountdownSec / 60)}:
                                {String(pairingCountdownSec % 60).padStart(2, '0')}
                              </strong>
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                void navigator.clipboard?.writeText(relaySnapshot.pairingSession!.code);
                                setCopiedPairingCode(true);
                                setTimeout(() => setCopiedPairingCode(false), 1800);
                              }}
                              className="text-[#00CFE8] font-bold inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Copy className="w-3 h-3" />
                              <span>{copiedPairingCode ? 'Copiado' : 'Copiar'}</span>
                            </button>
                          </div>
                          <p className="text-[10px] text-[#94A3B8] leading-snug">
                            Ingresa este código en tu teléfono VEL MÓVIL. Luego ambos mostrarán el código SAS de 6 dígitos para comparar cara a cara.
                          </p>
                          <button
                            type="button"
                            onClick={() => relayClientRef.current!.cancelPairing()}
                            className="w-full h-8 rounded-lg border border-[#EF4444]/40 text-[#EF4444] text-[10px] font-bold cursor-pointer"
                          >
                            Cancelar invitación
                          </button>
                        </div>
                      )}

                      {(relaySnapshot.pairingSession?.stage === 'SAS_PENDING' ||
                        relaySnapshot.pairingSession?.stage === 'SAS_AWAITING_PEER') && (
                        <div className="p-4 rounded-2xl bg-[#111C2E] border-2 border-[#00CFE8] space-y-3">
                          <div className="text-center space-y-1">
                            <span className="text-[10px] font-bold text-[#00CFE8] uppercase tracking-wider block">
                              Verificación cara a cara (Código SAS)
                            </span>
                            <div className="text-3xl font-mono font-extrabold tracking-[0.22em] text-white py-2 bg-[#0B1220] rounded-xl border border-[#22324C]">
                              {relaySnapshot.pairingSession.sasCode}
                            </div>
                          </div>

                          <div className="p-2.5 rounded-xl bg-[#0B1220] border border-[#22324C] text-[10px] font-mono space-y-1">
                            <div className="flex justify-between text-[#94A3B8]">
                              <span>MÓVIL detectado:</span>
                              <span className="text-white">{relaySnapshot.pairingSession.peerDeviceId}</span>
                            </div>
                            <div className="flex justify-between text-[#94A3B8]">
                              <span>Huella par:</span>
                              <span className="text-[#00CFE8]">
                                {relaySnapshot.pairingSession.peerFingerprint?.slice(0, 17)}...
                              </span>
                            </div>
                          </div>

                          {relaySnapshot.pairingSession.localConfirmedSas ? (
                            <div className="space-y-2">
                              <div className="p-2.5 rounded-xl bg-[#00CFE8]/10 border border-[#00CFE8]/30 text-[10px] text-[#00CFE8] text-center">
                                ✓ Emparejamiento pendiente: confirmado en VEL CORE. Ahora pulsa «Confirmar SAS» también en tu VEL MÓVIL.
                              </div>
                              <button
                                type="button"
                                onClick={() => relayClientRef.current!.cancelPairing('CANCELLED_BY_CORE')}
                                className="w-full h-9 rounded-xl border border-[#EF4444]/50 text-[#EF4444] font-bold text-xs cursor-pointer"
                              >
                                Cancelar vinculación
                              </button>
                            </div>
                          ) : (
                            <>
                              <p className="text-[10px] text-[#94A3B8] leading-snug text-center">
                                Confirma únicamente si este código de 6 dígitos coincide en ambos teléfonos. Ambos dispositivos deben confirmar.
                              </p>

                              <div className="grid grid-cols-2 gap-2">
                                <button
                                  type="button"
                                  onClick={() => relayClientRef.current!.cancelPairing('SAS_MISMATCH')}
                                  className="h-10 rounded-xl border border-[#EF4444]/50 text-[#EF4444] font-bold text-xs cursor-pointer"
                                >
                                  No coincide
                                </button>
                                <button
                                  type="button"
                                  onClick={() => relayClientRef.current!.confirmPairingSas()}
                                  className="h-10 rounded-xl bg-[#10B981] hover:bg-[#0ea571] text-[#0B1220] font-extrabold text-xs cursor-pointer"
                                >
                                  Confirmar SAS
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}

                      {relaySnapshot.pairingSession?.stage === 'CONFIRMED' && (
                        <div className="p-4 rounded-2xl bg-[#10B981]/10 border border-[#10B981]/40 space-y-2 text-center">
                          <CheckCircle className="w-8 h-8 text-[#10B981] mx-auto" />
                          <h3 className="text-xs font-bold text-white">Vinculación cifrada E2EE activada</h3>
                          <p className="text-[10px] text-[#94A3B8]">
                            Autorización persistida en Firestore y clave AES-256-GCM derivada en ambos dispositivos.
                          </p>
                        </div>
                      )}

                      {(!relaySnapshot.pairingSession ||
                        relaySnapshot.pairingSession.stage === 'CANCELLED' ||
                        relaySnapshot.pairingSession.stage === 'EXPIRED') && (
                        <div className="p-3.5 rounded-2xl bg-[#111C2E] border border-[#22324C] space-y-3">
                          <button
                            type="button"
                            onClick={handleCreatePairingOffer}
                            disabled={
                              isStartingPairingOffer ||
                              (relaySnapshot.connectionState !== 'AUTHENTICATED' &&
                                relaySnapshot.connectionState !== 'LINKED')
                            }
                            className="w-full h-11 rounded-xl bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-extrabold text-xs cursor-pointer disabled:opacity-45"
                          >
                            {isStartingPairingOffer ? 'Generando código...' : 'Generar código de emparejamiento'}
                          </button>

                          <div className="p-2.5 rounded-xl bg-[#0B1220] border border-[#22324C] space-y-1 text-[10px]">
                            <span className="text-[#94A3B8] block">ID público de este VEL CORE:</span>
                            <span className="font-mono text-white font-bold block">{deviceIdentity.deviceId}</span>
                            <span className="text-[#94A3B8] block pt-0.5">Huella SHA-256:</span>
                            <span className="font-mono text-[#00CFE8] break-all">{deviceIdentity.fingerprint}</span>
                          </div>
                        </div>
                      )}

                      {relaySnapshot.lastError && (
                        <p className="text-[10px] text-[#EF4444] text-center">{relaySnapshot.lastError}</p>
                      )}
                    </div>

                    <button
                      onClick={() => setCurrentScreen('CORE_HOME')}
                      className="w-full h-10 rounded-xl bg-[#18263E] text-white font-bold text-xs cursor-pointer"
                    >
                      Volver a VEL CORE
                    </button>
                  </div>
                )}

                {/* ============================================== */}
                {/* 6. PANTALLA: ADMINISTRAR DISPOSITIVOS */}
                {/* ============================================== */}
                {!isLoadingIdentity && currentScreen === 'DEVICE_MANAGEMENT' && deviceIdentity && (
                  <div className="flex-1 px-5 py-4 flex flex-col justify-between space-y-3 overflow-y-auto">
                    <div className="space-y-3">
                      <button
                        onClick={() => {
                          setRevokeFeedback(null);
                          setCurrentScreen('CORE_HOME');
                        }}
                        className="h-9 px-3 -ml-2 rounded-xl text-[#00CFE8] hover:text-white bg-[#111C2E] border border-[#22324C] flex items-center gap-1.5 text-xs font-bold transition-all cursor-pointer shadow-sm"
                      >
                        <ArrowLeft className="w-4 h-4" />
                        <span>← Volver</span>
                      </button>

                      <div className="space-y-0.5">
                        <h2 className="text-base font-bold text-white">Administración de dispositivos</h2>
                        <p className="text-xs text-[#94A3B8]">
                          Control de autorizaciones activas en Firestore y Relay WebSocket.
                        </p>
                      </div>

                      {deviceIdentity.pairedPeerDeviceId ? (
                        <div className="p-3.5 rounded-2xl bg-[#111C2E] border border-[#22324C] space-y-2.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Smartphone className="w-4 h-4 text-[#00CFE8]" />
                              <span className="text-xs font-bold text-white font-mono">
                                {deviceIdentity.pairedPeerDeviceId}
                              </span>
                            </div>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#10B981]/15 text-[#10B981]">
                              Autorizado
                            </span>
                          </div>
                          {deviceIdentity.activeLinkId && (
                            <div className="text-[10px] text-[#94A3B8] font-mono">
                              Vínculo ID: {deviceIdentity.activeLinkId}
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleRevokePeerDevice('Revocado desde Administración de VEL CORE')}
                            disabled={isRevokingPeer}
                            className="w-full h-9 rounded-xl bg-[#EF4444]/15 hover:bg-[#EF4444]/25 border border-[#EF4444]/40 text-[#EF4444] font-bold text-xs cursor-pointer disabled:opacity-50"
                          >
                            {isRevokingPeer ? 'Revocando...' : 'Revocar autorización de este móvil'}
                          </button>
                        </div>
                      ) : (
                        <div className="p-4 rounded-2xl bg-[#111C2E] border border-[#22324C] text-center space-y-1.5">
                          <p className="text-xs font-bold text-white">Sin dispositivos móviles vinculados</p>
                          <p className="text-[10px] text-[#94A3B8] leading-relaxed">
                            No existen autorizaciones activas en Firestore para este VEL CORE actualmente.
                          </p>
                        </div>
                      )}

                      {revokeFeedback && (
                        <div className="p-2.5 rounded-xl bg-[#0B1220] border border-[#22324C] space-y-1 text-[10px]">
                          {(() => {
                            const rb = formatRevocationBadge(relaySnapshot.revocationStatus);
                            return rb ? (
                              <span className={`inline-block text-[9px] font-bold px-2 py-0.5 rounded border ${rb.cls}`}>
                                {rb.label}
                              </span>
                            ) : null;
                          })()}
                          <p className="text-[#E2E8F0] leading-snug">{revokeFeedback}</p>
                        </div>
                      )}

                      <button
                        onClick={() => setCurrentScreen('REPLACE_PHONE')}
                        className="w-full h-10 rounded-xl bg-[#18263E] hover:bg-[#22324C] border border-[#00CFE8]/30 text-[#00CFE8] font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Reemplazar teléfono perdido o nuevo</span>
                      </button>
                    </div>

                    <button
                      onClick={() => setCurrentScreen('CORE_HOME')}
                      className="w-full h-10 rounded-xl bg-[#18263E] text-white font-bold text-xs cursor-pointer"
                    >
                      Volver a VEL CORE
                    </button>
                  </div>
                )}

                {/* ============================================== */}
                {/* 7. PANTALLA: REEMPLAZAR TELÉFONO MÓVIL */}
                {/* ============================================== */}
                {!isLoadingIdentity && currentScreen === 'REPLACE_PHONE' && deviceIdentity && (
                  <div className="flex-1 px-5 py-4 flex flex-col justify-between space-y-3 overflow-y-auto">
                    <div className="space-y-3">
                      <button
                        onClick={() => {
                          setRevokeFeedback(null);
                          setCurrentScreen('CORE_HOME');
                        }}
                        className="h-9 px-3 -ml-2 rounded-xl text-[#00CFE8] hover:text-white bg-[#111C2E] border border-[#22324C] flex items-center gap-1.5 text-xs font-bold transition-all cursor-pointer shadow-sm"
                      >
                        <ArrowLeft className="w-4 h-4" />
                        <span>← Volver</span>
                      </button>

                      <div className="space-y-0.5">
                        <h2 className="text-base font-bold text-white">REEMPLAZAR TELÉFONO MÓVIL</h2>
                        <p className="text-xs text-[#94A3B8]">
                          Sustitución segura conservando intacta la identidad y custodia de VEL CORE.
                        </p>
                      </div>

                      <div className="p-3 rounded-2xl bg-[#0B1220] border border-[#22324C] space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-white flex items-center gap-1.5">
                            <Shield className="w-3.5 h-3.5 text-[#00CFE8]" />
                            <span>Custodio: VEL CORE</span>
                          </span>
                          <span className="text-[10px] font-mono text-[#00CFE8] bg-[#00CFE8]/10 px-2 py-0.5 rounded font-bold">
                            IDENTIDAD INTACTA
                          </span>
                        </div>
                        <p className="text-[10px] text-[#94A3B8]">
                          ID: <span className="font-mono text-white">{deviceIdentity.deviceId}</span> • Las claves locales de CORE no se modifican ni se transfieren.
                        </p>
                      </div>

                      <div className="p-3 rounded-2xl bg-[#111C2E] border border-[#22324C] space-y-2">
                        <span className="text-xs font-bold text-white block">
                          Paso 1: Revocar teléfono anterior
                        </span>
                        {deviceIdentity.pairedPeerDeviceId ? (
                          <>
                            <div className="p-2 rounded-xl bg-[#0B1220] border border-[#22324C] text-[11px] font-mono text-white">
                              ID: {deviceIdentity.pairedPeerDeviceId}
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleRevokePeerDevice('Reemplazo de teléfono móvil desde VEL CORE')}
                              disabled={isRevokingPeer}
                              className="w-full h-9 rounded-xl bg-[#EF4444] hover:bg-[#DC2626] text-white font-bold text-xs cursor-pointer disabled:opacity-50"
                            >
                              {isRevokingPeer ? 'Revocando teléfono anterior...' : 'Revocar terminal anterior ahora'}
                            </button>
                          </>
                        ) : (
                          <div className="text-[11px] text-[#10B981] p-2 rounded-xl bg-[#10B981]/10 border border-[#10B981]/25">
                            ✓ Sin terminal activo vinculado. Listo para vincular un nuevo VEL MÓVIL.
                          </div>
                        )}
                      </div>

                      {revokeFeedback && (
                        <div className="p-2.5 rounded-xl bg-[#0B1220] border border-[#00CFE8]/30 text-[10px] text-[#00CFE8]">
                          {revokeFeedback}
                        </div>
                      )}

                      {(() => {
                        const revBadge = formatRevocationBadge(relaySnapshot.revocationStatus);
                        return (
                          <>
                            {revBadge && (
                              <div className="p-2.5 rounded-xl bg-[#0B1220] border border-[#22324C] space-y-1">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-bold text-white">Estado de revocación</span>
                                  <span className={`text-[9px] font-bold px-2 py-0.5 rounded border ${revBadge.cls}`}>
                                    {revBadge.label}
                                  </span>
                                </div>
                                {relaySnapshot.revocationDetail && (
                                  <p className="text-[10px] text-[#94A3B8] leading-snug">
                                    {relaySnapshot.revocationDetail}
                                  </p>
                                )}
                              </div>
                            )}

                            <div className="p-3 rounded-2xl bg-[#111C2E] border border-[#22324C] space-y-2 text-[10px] text-[#94A3B8]">
                              <strong className="text-white text-xs block">Paso 2: Vincular nuevo VEL MÓVIL</strong>
                              <p className="leading-relaxed">
                                {deviceIdentity.pairedPeerDeviceId
                                  ? 'Primero ejecuta el Paso 1 para revocar el terminal anterior. Cuando Firestore confirme la revocación, podrás generar un nuevo código efímero.'
                                  : 'Genera un nuevo código efímero y confirma el código SAS de 6 dígitos en ambos teléfonos (CORE y nuevo VEL MÓVIL).'}
                              </p>
                              <button
                                type="button"
                                disabled={Boolean(deviceIdentity.pairedPeerDeviceId)}
                                onClick={() => setCurrentScreen('PAIRING_CORE')}
                                className="w-full h-9 rounded-xl bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-bold text-xs cursor-pointer disabled:opacity-45"
                              >
                                Ir a vincular nuevo VEL MÓVIL
                              </button>
                            </div>
                          </>
                        );
                      })()}

                      <div className="p-3 rounded-xl bg-[#0B1220] border border-[#22324C] text-[10px] text-[#94A3B8] space-y-1">
                        <p>
                          <strong className="text-white">Sin nuevo contrato ni cobro:</strong> El reemplazo no exige una nueva suscripción ni altera tu cuenta comercial.
                        </p>
                        <p>
                          <strong className="text-white">Soberanía de datos:</strong> Ninguna información personal custodiada en CORE es transferida ni borrada durante el reemplazo.
                        </p>
                      </div>
                    </div>

                    <button
                      onClick={() => setCurrentScreen('CORE_HOME')}
                      className="w-full h-10 rounded-xl bg-[#18263E] text-white font-bold text-xs cursor-pointer"
                    >
                      Volver a VEL CORE
                    </button>
                  </div>
                )}

                {/* ============================================== */}
                {/* MODAL: CAMBIO CONTROLADO DE ROL */}
                {/* ============================================== */}
                {showRoleChangeModal && (
                  <div className="absolute inset-0 bg-black/85 backdrop-blur-sm p-4 flex items-center justify-center z-50">
                    <form
                      onSubmit={handleExecuteControlledRoleChange}
                      className="bg-[#111C2E] border border-[#F59E0B]/50 rounded-2xl p-5 space-y-3 max-w-xs w-full shadow-2xl text-xs"
                    >
                      <div className="flex items-center gap-2 text-[#F59E0B]">
                        <AlertTriangle className="w-5 h-5 shrink-0" />
                        <h3 className="font-bold text-sm text-white">Cambio controlado de rol</h3>
                      </div>

                      <p className="text-[11px] text-[#94A3B8] leading-relaxed">
                        El rol de este dispositivo persiste entre sesiones. Cambiarlo revocará la identidad técnica actual (<span className="font-mono text-white">{deviceIdentity?.deviceId}</span>) en Firestore y generará nuevas claves locales.
                      </p>

                      <div className="space-y-1">
                        <label className="text-[10px] text-[#94A3B8] block">
                          Escribe exactamente <strong className="text-white">{ROLE_CHANGE_CONFIRMATION_KEYWORD}</strong> para continuar:
                        </label>
                        <input
                          type="text"
                          value={roleChangeConfirmInput}
                          onChange={(e) => setRoleChangeConfirmInput(e.target.value)}
                          placeholder={ROLE_CHANGE_CONFIRMATION_KEYWORD}
                          className="w-full h-9 px-3 bg-[#0B1220] border border-[#22324C] rounded-xl text-xs font-mono text-white focus:outline-none focus:border-[#F59E0B]"
                        />
                      </div>

                      {roleChangeError && (
                        <p className="text-[11px] text-[#EF4444] font-medium">{roleChangeError}</p>
                      )}

                      <div className="flex gap-2 pt-1">
                        <button
                          type="submit"
                          disabled={isChangingRole}
                          className="flex-1 h-9 rounded-xl bg-[#F59E0B] hover:bg-[#D97706] text-[#0B1220] font-bold text-xs cursor-pointer disabled:opacity-60"
                        >
                          {isChangingRole ? 'Aplicando...' : 'Confirmar cambio'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowRoleChangeModal(false)}
                          className="flex-1 h-9 rounded-xl border border-[#22324C] text-[#94A3B8] text-xs cursor-pointer"
                        >
                          Cancelar
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {/* ============================================== */}
                {/* MODAL: PROCEDIMIENTO DE EMERGENCIA Y LOCALIZADOR */}
                {/* ============================================== */}
                {showEmergencyModal && (
                  <div className="absolute inset-0 bg-black/85 backdrop-blur-sm p-4 flex items-center justify-center z-50 overflow-y-auto">
                    <div className="bg-[#111C2E] border-2 border-[#EF4444] rounded-3xl p-5 space-y-3.5 max-w-xs w-full shadow-2xl text-xs">
                      <div className="flex items-center gap-2 text-[#EF4444]">
                        <AlertTriangle className="w-5 h-5 shrink-0" />
                        <h3 className="font-bold text-sm text-white">PROCEDIMIENTO DE EMERGENCIA</h3>
                      </div>

                      <p className="text-[#94A3B8] leading-relaxed">
                        Si perdiste tu teléfono móvil o sospechas que te lo robaron, sigue estos dos pasos claramente diferenciados:
                      </p>

                      {/* Acción 1: Revocación de VEL */}
                      <div className="p-3 rounded-xl bg-[#0B1220] border border-[#EF4444]/40 space-y-2">
                        <div className="flex items-center gap-1.5 text-white font-bold text-[11px]">
                          <span className="w-4 h-4 rounded-full bg-[#EF4444] text-white flex items-center justify-center text-[10px]">1</span>
                          <span>Revocar autorización de VEL:</span>
                        </div>
                        <p className="text-[10px] text-[#94A3B8] leading-tight">
                          {deviceIdentity?.pairedPeerDeviceId
                            ? `Dispositivo vinculado: ${deviceIdentity.pairedPeerDeviceId}. Esta acción invalida su autorización en Firestore y cierra su sesión en el Relay.`
                            : 'Actualmente no hay ningún VEL MÓVIL vinculado a este VEL CORE.'}
                        </p>
                        {deviceIdentity?.pairedPeerDeviceId && (
                          <button
                            type="button"
                            onClick={() => void handleRevokePeerDevice('Emergencia por pérdida o robo desde VEL CORE')}
                            disabled={isRevokingPeer}
                            className="w-full h-8 rounded-lg bg-[#DC2626] hover:bg-[#B91C1C] text-white font-bold text-[11px] cursor-pointer disabled:opacity-50"
                          >
                            {isRevokingPeer ? 'Ejecutando revocación...' : 'REVOCAR VEL MÓVIL AHORA'}
                          </button>
                        )}
                        {revokeFeedback && (
                          <div className="space-y-1">
                            {(() => {
                              const rb = formatRevocationBadge(relaySnapshot.revocationStatus);
                              return rb ? (
                                <span className={`inline-block text-[9px] font-bold px-2 py-0.5 rounded border ${rb.cls}`}>
                                  {rb.label}
                                </span>
                              ) : null;
                            })()}
                            <p className="text-[10px] text-[#E2E8F0] leading-tight">{revokeFeedback}</p>
                          </div>
                        )}
                      </div>

                      {/* Acción 2: Google Localizador */}
                      <div className="p-3 rounded-xl bg-[#0B1220] border border-[#22324C] space-y-2">
                        <div className="flex items-center gap-1.5 text-white font-bold text-[11px]">
                          <span className="w-4 h-4 rounded-full bg-[#00CFE8] text-[#0B1220] flex items-center justify-center text-[10px] font-bold">2</span>
                          <span>Google Localizador (Encontrar mi dispositivo):</span>
                        </div>
                        <p className="text-[10px] text-[#94A3B8] leading-tight">
                          Permite localizar, bloquear o solicitar el borrado de fábrica de tu teléfono mediante tu cuenta de Google.
                        </p>

                        <div className="p-2 rounded bg-[#111C2E] border border-[#F59E0B]/30 text-[10px] text-[#F59E0B] leading-tight">
                          <strong>Aviso:</strong> Abrir Google Localizador no borra automáticamente el dispositivo: deberás iniciar sesión con tu cuenta de Google, seleccionar tu teléfono y solicitar la acción desde allí.
                        </div>

                        <a
                          href="https://android.com/find"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-full h-8 rounded-lg bg-[#18263E] hover:bg-[#22324C] border border-[#00CFE8]/40 text-[#00CFE8] font-bold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>Abrir Google Localizador ↗</span>
                        </a>
                      </div>

                      <button
                        onClick={() => setShowEmergencyModal(false)}
                        className="w-full h-9 rounded-xl border border-[#22324C] text-[#94A3B8] text-xs hover:text-white cursor-pointer"
                      >
                        Cerrar ventana de emergencia
                      </button>
                    </div>
                  </div>
                )}

                {/* MODAL: INFORMACIÓN, AYUDA, DESINSTALACIÓN Y LIBERTAD DE CONTRATACIÓN (ⓘ) */}
                {showHelpModal && (
                  <div className="absolute inset-0 bg-black/85 backdrop-blur-sm p-4 flex items-center justify-center z-50 overflow-y-auto">
                    <div className="bg-[#111C2E] border border-[#22324C] rounded-3xl p-5 space-y-3.5 max-w-xs w-full shadow-2xl text-xs max-h-[720px] overflow-y-auto">
                      <div className="flex items-center justify-between pb-2 border-b border-[#22324C]">
                        <h3 className="font-bold text-sm text-white flex items-center gap-1.5">
                          <Info className="w-4 h-4 text-[#00CFE8]" />
                          <span>Información y Ayuda VEL</span>
                        </h3>
                        <button onClick={() => setShowHelpModal(false)} className="text-[#94A3B8] hover:text-white cursor-pointer">✕</button>
                      </div>

                      {/* 1. Información General */}
                      <div className="space-y-1 text-[#94A3B8]">
                        <h4 className="font-bold text-white text-[11px]">1. Arquitectura de dos teléfonos</h4>
                        <p className="text-[10px] leading-relaxed">
                          VEL opera separando funciones: VEL CORE es el custodio exclusivo de tus datos y claves. VEL MÓVIL es el terminal personal de acceso autorizado.
                        </p>
                      </div>

                      {/* 2. Instrucciones Básicas */}
                      <div className="space-y-1 text-[#94A3B8]">
                        <h4 className="font-bold text-white text-[11px]">2. Instrucciones de uso</h4>
                        <p className="text-[10px] leading-relaxed">
                          Configura primero VEL CORE en tu teléfono principal. Luego selecciona VEL MÓVIL en tu teléfono diario y verifica el código SAS de 6 dígitos cara a cara.
                        </p>
                      </div>

                      {/* 3. Desinstalación (Requisito 11) */}
                      <div className="space-y-1 text-[#94A3B8]">
                        <h4 className="font-bold text-white text-[11px]">3. Desinstalación de la aplicación PWA</h4>
                        <p className="text-[10px] leading-relaxed">
                          VEL puede desinstalarse en cualquier momento manteniendo presionado el ícono de VEL en la pantalla de inicio o desde la configuración de aplicaciones del navegador.
                        </p>
                        <p className="text-[10px] text-[#F59E0B] leading-tight">
                          Nota: Desinstalar la PWA o borrar los datos del sitio en VEL CORE elimina permanentemente los datos cifrados locales de ese navegador, y no cancela automáticamente suscripciones comerciales activas.
                        </p>
                      </div>

                      {/* 4. Cláusula de Libertad de Contratación destacada en rojo (Requisito 12) */}
                      <div className="p-2.5 rounded-xl bg-[#EF4444]/15 border border-[#EF4444]/40 text-[#FCA5A5] space-y-1">
                        <h4 className="font-extrabold text-[11px] text-white">Libertad de Contratación:</h4>
                        <p className="text-[10px] leading-relaxed">
                          No existe permanencia obligatoria. No se cobra por instalar, reinstalar, configurar, reemplazar o revocar dispositivos. Puedes cancelar tu suscripción libremente desde el Portal Web. Una suspensión comercial no borra los datos conservados en VEL CORE.
                        </p>
                      </div>

                      {/* Enlace al contrato */}
                      <div className="pt-1 border-t border-[#22324C]">
                        <a
                          href={OFFICIAL_CONTRACT_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-[#00CFE8] hover:underline flex items-center gap-1 cursor-pointer"
                        >
                          <ExternalLink className="w-3 h-3" />
                          <span>Consultar términos y condiciones</span>
                        </a>
                      </div>

                      <button
                        onClick={() => setShowHelpModal(false)}
                        className="w-full h-9 rounded-xl bg-[#00CFE8] text-[#0B1220] font-bold text-xs cursor-pointer"
                      >
                        Entendido
                      </button>
                    </div>
                  </div>
                )}

              </div>
            </div>
          </div>
        )}

        {/* ========================================================= */}
        {/* VISTA 2: PORTAL WEB EXCLUSIVO DE CONTRATACIÓN Y SUSCRIPCIÓN */}
        {/* ========================================================= */}
        {viewMode === 'WEB_PORTAL' && (
          <div className="max-w-2xl w-full bg-[#111C2E] border border-[#22324C] rounded-3xl p-6 sm:p-8 space-y-6 shadow-2xl">
            <div className="border-b border-[#22324C] pb-4 space-y-1">
              <div className="flex items-center gap-2 text-[#00CFE8]">
                <CreditCard className="w-5 h-5" />
                <span className="text-xs font-bold uppercase tracking-wider">Portal Web Oficial</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-extrabold text-white">
                Contratación y Suscripción del Servicio VEL
              </h2>
              <p className="text-xs text-[#94A3B8]">
                Circuito comercial oficial conectado con Firebase Auth, Cloud Firestore y Mercado Pago Checkout Pro.
              </p>
            </div>

            {paymentReturnStatus && (
              <div
                className={`p-4 rounded-2xl border space-y-2 text-xs ${
                  paymentReturnStatus === 'aprobado'
                    ? 'bg-[#10B981]/10 border-[#10B981]/40 text-[#A7F3D0]'
                    : paymentReturnStatus === 'pendiente'
                    ? 'bg-[#F59E0B]/10 border-[#F59E0B]/40 text-[#FDE68A]'
                    : 'bg-[#EF4444]/10 border-[#EF4444]/40 text-[#FCA5A5]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-white">
                    {paymentReturnStatus === 'aprobado'
                      ? 'Retorno de pago aprobado en Mercado Pago'
                      : paymentReturnStatus === 'pendiente'
                      ? 'Pago pendiente de acreditación'
                      : 'Pago cancelado en Mercado Pago'}
                  </strong>
                  <button
                    type="button"
                    onClick={() => setPaymentReturnStatus(null)}
                    className="text-[11px] underline cursor-pointer"
                  >
                    Ocultar
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed">
                  {paymentReturnStatus === 'aprobado'
                    ? 'Tu regreso desde Mercado Pago se registró. La vigencia comercial de 30 días solo se acredita en Firestore cuando el webhook oficial del servidor verifica el pago aprobado ante Mercado Pago.'
                    : paymentReturnStatus === 'pendiente'
                    ? 'El pago quedó pendiente en Mercado Pago (por ejemplo, pago en efectivo). Tu estado en Firestore se actualizará automáticamente al acreditarse.'
                    : 'El proceso en Checkout Pro fue cancelado o interrumpido. No se realizó ningún cambio en tu vigencia.'}
                </p>
                {currentUser && (
                  <button
                    type="button"
                    disabled={isRefreshingSubscription}
                    onClick={() => void handleRefreshSubscriptionFromFirestore()}
                    className="px-3 py-1.5 rounded-lg bg-[#18263E] hover:bg-[#22324C] text-[#00CFE8] font-bold text-[11px] cursor-pointer disabled:opacity-50"
                  >
                    {isRefreshingSubscription ? 'Consultando Firestore...' : 'Actualizar estado real desde Firestore'}
                  </button>
                )}
              </div>
            )}

            <div className="space-y-4">
              {/* Paso 1: Identificación sin contraseña (Enlace de verificación por correo) */}
              <div className="p-4 rounded-2xl bg-[#0B1220] border border-[#22324C] space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-[#00CFE8] text-[#0B1220] flex items-center justify-center text-[11px] font-extrabold">1</span>
                    Identificación por Enlace Único (Sin contraseña)
                  </span>
                  {currentUser && (
                    <span className="text-[10px] bg-[#10B981]/15 text-[#10B981] font-bold px-2 py-0.5 rounded">
                      Sesión activa
                    </span>
                  )}
                </div>

                {currentUser ? (
                  <div className="flex items-center justify-between p-3 rounded-xl bg-[#111C2E] border border-[#10B981]/30">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-[#10B981]/15 text-[#10B981] flex items-center justify-center font-bold">
                        <Check className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-white">{currentUser.email}</p>
                        <p className="text-[10px] text-[#94A3B8]">
                          Cuenta verificada sin contraseña en Firebase Authentication
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={handleWebLogout}
                      className="px-3 py-1 rounded-lg border border-[#EF4444]/40 hover:bg-[#EF4444]/10 text-[#EF4444] text-xs font-semibold cursor-pointer"
                    >
                      Cerrar sesión
                    </button>
                  </div>
                ) : needsLinkEmailConfirm ? (
                  <form onSubmit={handleConfirmEmailForLink} className="space-y-3">
                    <p className="text-[11px] text-[#F59E0B] leading-relaxed">
                      Abriste el enlace de acceso en un navegador distinto. Confirma tu correo electrónico para validar el enlace de un solo uso y recuperar tu cuenta:
                    </p>
                    <input
                      type="email"
                      value={confirmLinkEmailInput}
                      onChange={(e) => setConfirmLinkEmailInput(e.target.value)}
                      placeholder="Confirma tu correo electrónico..."
                      className="w-full h-10 px-3 bg-[#111C2E] border border-[#22324C] rounded-xl text-xs text-white placeholder-[#94A3B8]/60 focus:outline-none focus:border-[#00CFE8]"
                    />
                    {authError && <p className="text-xs text-[#EF4444] font-medium">{authError}</p>}
                    <button
                      type="submit"
                      disabled={isSubmittingAuth}
                      className="w-full h-10 rounded-xl bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-bold text-xs cursor-pointer"
                    >
                      {isSubmittingAuth ? 'Verificando enlace...' : 'Completar acceso sin contraseña'}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleRequestPasswordlessLink} className="space-y-3">
                    <p className="text-[11px] text-[#94A3B8] leading-relaxed">
                      VEL no utiliza contraseñas. Ingresa tu correo para recibir un enlace de verificación de un solo uso. Si ya eras suscriptor, conservarás exactamente tu cuenta, tarifa histórica y vigencia actual.
                    </p>

                    <input
                      type="email"
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      placeholder="Correo electrónico del titular..."
                      className="w-full h-10 px-3 bg-[#111C2E] border border-[#22324C] rounded-xl text-xs text-white placeholder-[#94A3B8]/60 focus:outline-none focus:border-[#00CFE8]"
                    />

                    {authError && <p className="text-xs text-[#EF4444] font-medium">{authError}</p>}
                    {authSuccess && <p className="text-xs text-[#10B981] font-medium leading-relaxed">{authSuccess}</p>}

                    <button
                      type="submit"
                      disabled={isSubmittingAuth || authLoading}
                      className="w-full h-10 rounded-xl bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-bold text-xs cursor-pointer disabled:opacity-60"
                    >
                      {isSubmittingAuth
                        ? 'Enviando enlace seguro...'
                        : emailLinkSentTo
                        ? 'Reenviar enlace de acceso sin contraseña'
                        : 'Enviar enlace de acceso sin contraseña'}
                    </button>
                  </form>
                )}
              </div>

              {/* Plan y Contratación con Precio Centralizado */}
              <div className="p-4 rounded-2xl bg-[#0B1220] border border-[#22324C] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-[#00CFE8] text-[#0B1220] flex items-center justify-center text-[11px] font-extrabold">2</span>
                    Plan Oficial VEL (2 Teléfonos: CORE + MÓVIL)
                  </span>
                  <span className="text-xs font-mono font-bold text-[#00CFE8] bg-[#00CFE8]/10 px-2 py-0.5 rounded border border-[#00CFE8]/20">
                    ${serverPricing.monto.toLocaleString()} {serverPricing.moneda} / mes
                  </span>
                </div>
                <p className="text-xs text-[#94A3B8]">
                  Licencia para un teléfono principal (VEL CORE custodio) y un dispositivo personal (VEL MÓVIL terminal).
                </p>
                {subscriberDoc?.precioContratado &&
                  (subscriberDoc.fechaUltimoPago ||
                    subscriberDoc.venceEl ||
                    ['activo', 'en_gracia', 'suspendido', 'vencido'].includes(subscriberDoc.estado)) && (
                    <p className="text-[11px] text-[#10B981] bg-[#10B981]/10 p-2 rounded-lg border border-[#10B981]/25">
                      Tu tarifa histórica conservada: <strong>${subscriberDoc.precioContratado.toLocaleString()} {subscriberDoc.moneda || 'ARS'} / 30 días</strong> (se respeta en todas tus renovaciones).
                    </p>
                  )}
              </div>

              {/* Términos y Condiciones */}
              <div className="p-4 rounded-2xl bg-[#0B1220] border border-[#22324C] space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-white flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-[#00CFE8] text-[#0B1220] flex items-center justify-center text-[11px] font-extrabold">3</span>
                    Lectura y Aceptación de Términos ({CURRENT_CONTRACT_VERSION})
                  </span>
                  {contractAcceptanceDoc?.aceptado && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30">
                      Registrado en Firestore ✓
                    </span>
                  )}
                </div>
                <a
                  href={OFFICIAL_CONTRACT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full h-10 rounded-xl bg-[#18263E] hover:bg-[#22324C] border border-[#00CFE8]/40 text-[#00CFE8] font-bold text-xs flex items-center justify-center gap-2"
                >
                  <ExternalLink className="w-4 h-4" />
                  <span>Consultar términos y condiciones</span>
                </a>

                <label className="flex items-start gap-3 p-3 rounded-xl bg-[#111C2E] border border-[#22324C] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={webContractAccepted}
                    disabled={isRecordingContract}
                    onChange={(e) => void handleContractCheckboxChange(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-[#22324C] bg-[#0B1220] text-[#00CFE8] accent-[#00CFE8] shrink-0"
                  />
                  <span className="text-xs text-white leading-relaxed">
                    <strong className="text-[#00CFE8]">Acepto obligatoriamente</strong> los Términos y Condiciones y el Contrato de Uso para contratar el servicio.
                    {isRecordingContract && (
                      <span className="block text-[11px] text-[#00CFE8] mt-1">
                        Registrando aceptación legal en Firestore...
                      </span>
                    )}
                  </span>
                </label>

                {contractError && (
                  <div className="p-2.5 rounded-xl bg-[#EF4444]/15 border border-[#EF4444]/30 text-[11px] text-[#FCA5A5] leading-snug">
                    {contractError}
                  </div>
                )}
              </div>

              {/* Paso 4: Estado Comercial de la Suscripción y Pasarela Mercado Pago (Checkout Pro 30 días) */}
              {(() => {
                const nowMs = Date.now();
                const venceMs = subscriberDoc?.venceEl ? Date.parse(subscriberDoc.venceEl) : NaN;
                const hasValidVence = !Number.isNaN(venceMs);
                const isExpiredByDate = hasValidVence && venceMs <= nowMs;
                const daysRemaining = hasValidVence
                  ? Math.max(0, Math.ceil((venceMs - nowMs) / (24 * 60 * 60 * 1000)))
                  : null;
                const isActivelyValid = subscriberDoc?.estado === 'activo' && (!hasValidVence || !isExpiredByDate);
                const isExpiringSoon = isActivelyValid && daysRemaining !== null && daysRemaining <= 7;
                const isExpiredState =
                  subscriberDoc?.estado === 'vencido' ||
                  (subscriberDoc?.estado === 'activo' && isExpiredByDate);
                const hasLegacyAutoPreapproval =
                  Boolean(subscriberDoc?.mpPreapprovalId) &&
                  subscriberDoc?.modalidadComercial !== 'manual_30d';

                const badgeLabel = isExpiredState
                  ? 'VENCIDO'
                  : isExpiringSoon
                  ? 'PRÓXIMO A VENCER'
                  : subscriberDoc?.estado
                  ? subscriberDoc.estado.toUpperCase().replace('_', ' ')
                  : 'NO CONTRATADA';

                return (
                  <div className="p-4 rounded-2xl bg-[#0B1220] border border-[#22324C] space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-white flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-[#00CFE8] text-[#0B1220] flex items-center justify-center text-[11px] font-extrabold">4</span>
                        {hasLegacyAutoPreapproval
                          ? 'Suscripción Histórica (Mercado Pago Preapproval)'
                          : 'Suscripción Manual 30 días (Mercado Pago Checkout Pro)'}
                      </span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                        isActivelyValid && !isExpiringSoon
                          ? 'bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40'
                          : isExpiringSoon || subscriberDoc?.estado === 'en_gracia'
                          ? 'bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/40'
                          : isExpiredState || subscriberDoc?.estado === 'suspendido'
                          ? 'bg-[#EF4444]/20 text-[#EF4444] border border-[#EF4444]/40'
                          : 'bg-[#94A3B8]/20 text-[#94A3B8] border border-[#94A3B8]/40'
                      }`}>
                        {badgeLabel}
                      </span>
                    </div>

                    {/* Caso 1: Suscripción ACTIVA y VIGENTE (incluye aviso si está próxima a vencer) */}
                    {isActivelyValid && (
                      <div className={`p-3.5 rounded-xl border space-y-2.5 ${
                        isExpiringSoon
                          ? 'bg-[#F59E0B]/10 border-[#F59E0B]/30'
                          : 'bg-[#10B981]/10 border-[#10B981]/30'
                      }`}>
                        <div className={`flex items-center gap-2 font-bold text-xs ${
                          isExpiringSoon ? 'text-[#F59E0B]' : 'text-[#10B981]'
                        }`}>
                          {isExpiringSoon ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
                          <span>
                            {isExpiringSoon
                              ? `Suscripción Próxima a Vencer (${daysRemaining} día${daysRemaining === 1 ? '' : 's'} restante${daysRemaining === 1 ? '' : 's'})`
                              : 'Suscripción Oficial Habilitada y al Día'}
                          </span>
                        </div>
                        <p className="text-[11px] text-[#94A3B8]">
                          {isExpiringSoon
                            ? 'Puedes renovar manualmente ahora por otros 30 días: los días nuevos se sumarán exactamente a partir de tu fecha de vencimiento actual.'
                            : hasLegacyAutoPreapproval
                            ? 'Tu servicio VEL está activo bajo suscripción recurrente histórica.'
                            : 'Tu servicio VEL está activo bajo modalidad manual por 30 días (sin débitos automáticos).'}
                        </p>
                        {subscriberDoc?.venceEl && (
                          <p className="text-[10px] text-white font-mono">
                            Vence el: {new Date(subscriberDoc.venceEl).toLocaleDateString()}
                            {daysRemaining !== null ? ` (${daysRemaining} días restantes)` : ''}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2 pt-1">
                          <button
                            type="button"
                            onClick={handleAuthorizedDownload}
                            disabled={isCheckingDownload}
                            className="flex-1 min-w-[180px] h-9 rounded-lg bg-[#10B981] hover:bg-[#059669] text-[#0B1220] font-bold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                            title="Paquete técnico autorizado para actualización del portal web (no es instalador móvil)"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>{isCheckingDownload ? 'Verificando vigencia...' : 'Paquete técnico autorizado (.zip)'}</span>
                          </button>

                          <button
                            type="button"
                            onClick={handleStartCheckout}
                            disabled={isStartingCheckout}
                            className="flex-1 min-w-[180px] h-9 rounded-lg bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-bold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            <span>{isStartingCheckout ? 'Conectando...' : 'Renovar 30 días anticipadamente ↗'}</span>
                          </button>

                          {hasLegacyAutoPreapproval && (
                            <button
                              type="button"
                              onClick={handleCancelSubscription}
                              disabled={isCancellingSub}
                              className="px-3 h-9 rounded-lg border border-[#EF4444]/40 hover:bg-[#EF4444]/15 text-[#EF4444] text-xs font-semibold cursor-pointer"
                            >
                              {isCancellingSub ? 'Cancelando...' : 'Cancelar suscripción'}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Caso 2: Suscripción VENCIDA (por estado 'vencido' o fecha venceEl expirada) */}
                    {isExpiredState && (
                      <div className="p-3.5 rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/30 space-y-2.5">
                        <div className="flex items-center gap-2 text-[#EF4444] font-bold text-xs">
                          <AlertTriangle className="w-4 h-4" />
                          <span>Período de 30 Días Vencido</span>
                        </div>
                        <p className="text-[11px] text-[#94A3B8]">
                          Tu período de vigencia finalizó{subscriberDoc?.venceEl ? ` el ${new Date(subscriberDoc.venceEl).toLocaleDateString()}` : ''}. Las descargas están pausadas hasta acreditar una nueva renovación manual de 30 días.
                        </p>
                        <p className="text-[10px] text-[#00CFE8] bg-[#00CFE8]/10 p-2 rounded-lg border border-[#00CFE8]/20">
                          <strong>Garantía de Soberanía:</strong> Tus notas, claves e identidades en VEL CORE permanecen 100% intactas. Al renovarse el pago, se conserva tu tarifa histórica contratada.
                        </p>
                        <button
                          type="button"
                          onClick={handleStartCheckout}
                          disabled={isStartingCheckout}
                          className="w-full h-9 rounded-lg bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          {isStartingCheckout ? 'Conectando...' : 'Renovar 30 días en Mercado Pago ↗'}
                        </button>
                      </div>
                    )}

                    {/* Caso 3: Suscripción EN PERÍODO DE GRACIA (7 días) */}
                    {subscriberDoc?.estado === 'en_gracia' && (
                      <div className="p-3.5 rounded-xl bg-[#F59E0B]/10 border border-[#F59E0B]/30 space-y-2.5">
                        <div className="flex items-center gap-2 text-[#F59E0B] font-bold text-xs">
                          <AlertTriangle className="w-4 h-4" />
                          <span>Período de Gracia Activo (Tolerancia de 7 días)</span>
                        </div>
                        <p className="text-[11px] text-[#94A3B8]">
                          Tu pago mensual está pendiente de confirmación en Mercado Pago. <strong className="text-white">El servicio continúa habilitado</strong> durante el período de gracia de 7 días. Regulariza el pago mediante Checkout Pro para evitar la suspensión comercial.
                        </p>
                        <button
                          type="button"
                          onClick={handleStartCheckout}
                          disabled={isStartingCheckout}
                          className="w-full h-9 rounded-lg bg-[#F59E0B] hover:bg-[#D97706] text-[#0B1220] font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          {isStartingCheckout ? 'Conectando...' : 'Regularizar pago (30 días) en Mercado Pago ↗'}
                        </button>
                      </div>
                    )}

                    {/* Caso 4: Suscripción SUSPENDIDA */}
                    {subscriberDoc?.estado === 'suspendido' && (
                      <div className="p-3.5 rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/30 space-y-2.5">
                        <div className="flex items-center gap-2 text-[#EF4444] font-bold text-xs">
                          <Ban className="w-4 h-4" />
                          <span>Acceso Comercial Suspendido</span>
                        </div>
                        <p className="text-[11px] text-[#94A3B8]">
                          El acceso comercial se encuentra suspendido por vencimiento o reversión del pago.
                        </p>
                        <p className="text-[10px] text-[#00CFE8] bg-[#00CFE8]/10 p-2 rounded-lg border border-[#00CFE8]/20">
                          <strong>Garantía de Soberanía:</strong> La suspensión comercial no borra notas, claves ni información de tu VEL CORE, ni desvincula dispositivos. Al acreditar un nuevo pago de 30 días se reactiva automáticamente.
                        </p>
                        <button
                          type="button"
                          onClick={handleStartCheckout}
                          disabled={isStartingCheckout}
                          className="w-full h-9 rounded-lg bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          {isStartingCheckout ? 'Conectando...' : 'Reactivar 30 días con Mercado Pago ↗'}
                        </button>
                      </div>
                    )}

                    {/* Caso 5: No contratado, Pendiente de Pago Inicial o Cancelado */}
                    {(!subscriberDoc?.estado || subscriberDoc.estado === 'pendiente_pago' || subscriberDoc.estado === 'cancelado') && (
                      <div className="space-y-2.5">
                        <p className="text-[11px] text-[#94A3B8] leading-relaxed">
                          La contratación se realiza por pago manual de <strong>30 días mediante Mercado Pago Checkout Pro</strong> (tarjetas, saldo en cuenta, Rapipago o Pago Fácil). La vigencia se acredita al confirmarse el pago aprobado.
                        </p>

                        <button
                          type="button"
                          onClick={handleStartCheckout}
                          disabled={isStartingCheckout || !currentUser || !webContractAccepted}
                          className={`w-full h-11 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all shadow-lg ${
                            currentUser && webContractAccepted
                              ? 'bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] cursor-pointer'
                              : 'bg-[#18263E] text-[#94A3B8] cursor-not-allowed opacity-60'
                          }`}
                        >
                          <CreditCard className="w-4 h-4" />
                          <span>{isStartingCheckout ? 'Generando preferencia...' : 'CONTRATAR 30 DÍAS EN MERCADO PAGO ↗'}</span>
                        </button>

                        {(!currentUser || !webContractAccepted) && (
                          <p className="text-[10px] text-[#F59E0B] text-center">
                            {!currentUser
                              ? 'Debes registrarte o iniciar sesión en el Paso 1.'
                              : 'Debes marcar la aceptación de Términos en el Paso 3 para habilitar el botón.'}
                          </p>
                        )}
                      </div>
                    )}

                    {checkoutError && (
                      <div className="p-3 rounded-xl bg-[#EF4444]/15 border border-[#EF4444]/30 text-xs text-[#EF4444] leading-relaxed">
                        {checkoutError}
                      </div>
                    )}

                    {cancelMessage && (
                      <div className="p-3 rounded-xl bg-[#10B981]/15 border border-[#10B981]/30 text-xs text-[#10B981] leading-relaxed">
                        {cancelMessage}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Paso 5: Panel Administrativo de Precios (Solo Administrador Autorizado) */}
              {isAdmin && (
                <div className="p-4 rounded-2xl bg-[#0B1220] border border-[#00CFE8]/30 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white flex items-center gap-2">
                      <Shield className="w-4 h-4 text-[#00CFE8]" />
                      Panel Administrativo Comercial
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAdminPanel(!showAdminPanel);
                        if (!showAdminPanel) loadAdminHistory();
                      }}
                      className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-[#18263E] hover:bg-[#22324C] text-[#00CFE8] cursor-pointer"
                    >
                      {showAdminPanel ? 'Ocultar panel' : 'Gestionar precios'}
                    </button>
                  </div>

                  {showAdminPanel && (
                    <div className="space-y-3 pt-2 border-t border-[#22324C]">
                      <p className="text-[11px] text-[#94A3B8] leading-relaxed">
                        <strong className="text-white">Regla Comercial:</strong> Los nuevos suscriptores contratarán al precio vigente aquí configurado. Los suscriptores existentes conservan de forma inmutable el precio al que contrataron.
                      </p>

                      <form onSubmit={handleUpdatePriceAdmin} className="space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[10px] text-[#94A3B8] block mb-1">Monto mensual:</label>
                            <input
                              type="number"
                              value={adminNewPrice}
                              onChange={(e) => setAdminNewPrice(e.target.value)}
                              className="w-full h-9 px-3 bg-[#111C2E] border border-[#22324C] rounded-lg text-xs text-white"
                              min="1"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-[#94A3B8] block mb-1">Moneda:</label>
                            <select
                              value={adminNewCurrency}
                              onChange={(e) => setAdminNewCurrency(e.target.value)}
                              className="w-full h-9 px-2 bg-[#111C2E] border border-[#22324C] rounded-lg text-xs text-white"
                            >
                              <option value="ARS">ARS (Pesos Argentinos)</option>
                              <option value="USD">USD (Dólares)</option>
                              <option value="BRL">BRL (Reales)</option>
                              <option value="MXN">MXN (Pesos Mexicanos)</option>
                            </select>
                          </div>
                        </div>

                        {adminPriceMsg && (
                          <p className="text-[11px] text-[#00CFE8] font-medium">{adminPriceMsg}</p>
                        )}

                        <button
                          type="submit"
                          className="w-full h-9 rounded-lg bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-bold text-xs cursor-pointer"
                        >
                          Guardar nuevo precio oficial
                        </button>
                      </form>

                      {adminHistory.length > 0 && (
                        <div className="pt-2 space-y-1">
                          <span className="text-[10px] font-bold text-white block">Historial de tarifas:</span>
                          <div className="max-h-28 overflow-y-auto space-y-1 text-[10px] font-mono text-[#94A3B8]">
                            {adminHistory.map((item) => (
                              <div key={item.id} className="p-1.5 rounded bg-[#111C2E] flex justify-between">
                                <span>${item.monto} {item.moneda}</span>
                                <span>{new Date(item.actualizadoEl).toLocaleDateString()}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ========================================================= */}
        {/* VISTA 3: INSTALACIÓN DE VEL COMO PWA OFICIAL */}
        {/* ========================================================= */}
        {viewMode === 'INSTALL_INFO' && (
          <div className="max-w-2xl w-full bg-[#111C2E] border border-[#22324C] rounded-3xl p-6 sm:p-8 space-y-6 shadow-2xl">
            <div className="border-b border-[#22324C] pb-4 space-y-1">
              <div className="flex items-center gap-2 text-[#00CFE8]">
                <Download className="w-5 h-5" />
                <span className="text-xs font-bold uppercase tracking-wider">Instalación Oficial PWA</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-extrabold text-white">
                Instalar VEL en tus teléfonos (CORE y MÓVIL)
              </h2>
              <p className="text-xs text-[#94A3B8]">
                Aplicación Web Progresiva oficial servida directamente desde Netlify sobre HTTPS.
              </p>
            </div>

            <div className="space-y-4">
              <div className="p-4 rounded-2xl bg-[#0B1220] border border-[#22324C] space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-white flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-[#10B981]" />
                    <span>Requisitos PWA activos</span>
                  </h4>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#10B981]/15 text-[#10B981]">
                    {pwa.isInstalled ? 'EJECUTANDO COMO PWA' : 'LISTA PARA INSTALAR'}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2.5 rounded-xl bg-[#111C2E] border border-[#22324C]">
                    <span className="text-[#94A3B8] block text-[10px]">Nombre oficial:</span>
                    <span className="text-white font-mono text-[11px]">VEL</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-[#111C2E] border border-[#22324C]">
                    <span className="text-[#94A3B8] block text-[10px]">Íconos PWA:</span>
                    <span className="text-white font-mono text-[11px]">192 / 512 / Maskable ✓</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-[#111C2E] border border-[#22324C]">
                    <span className="text-[#94A3B8] block text-[10px]">Service Worker:</span>
                    <span className="text-white font-mono text-[11px]">sw.js (solo estáticos) ✓</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-[#111C2E] border border-[#22324C]">
                    <span className="text-[#94A3B8] block text-[10px]">Modo:</span>
                    <span className="text-white font-mono text-[11px]">standalone (start_url: /) ✓</span>
                  </div>
                </div>

                <PWAInstallButton pwa={pwa} />
              </div>

              <div className="p-4 rounded-2xl bg-[#0B1220] border border-[#22324C] space-y-2.5 text-xs text-[#94A3B8]">
                <h4 className="text-sm font-bold text-white">Pasos manuales según tu navegador</h4>
                <div className="space-y-1.5 leading-relaxed">
                  <p>
                    <strong className="text-[#00CFE8]">Android (Chrome / Edge):</strong> Abre{' '}
                    <code className="text-white">https://proyecto-vel.netlify.app</code>, toca el menú{' '}
                    <strong className="text-white">⋮</strong> y selecciona{' '}
                    <strong className="text-white">«Instalar aplicación»</strong> o{' '}
                    <strong className="text-white">«Agregar a la pantalla principal»</strong>.
                  </p>
                  <p>
                    <strong className="text-[#10B981]">iPhone / iPad (Safari):</strong> Abre el dominio oficial en Safari, pulsa{' '}
                    <strong className="text-white">Compartir</strong> y luego{' '}
                    <strong className="text-white">«Agregar a inicio»</strong>.
                  </p>
                </div>
                <div className="p-2.5 rounded-xl bg-[#111C2E] border border-[#22324C] text-[11px] leading-snug">
                  <strong className="text-white">Importante:</strong> Blogger actúa exclusivamente como página institucional y de contratación. El Service Worker y la aplicación instalable viven en el dominio Netlify oficial. No se requiere descargar ningún APK ni archivo ZIP para instalar VEL en tus teléfonos.
                </div>
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

export default App;
