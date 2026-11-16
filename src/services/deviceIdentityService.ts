import {
  DeviceIdentitySummary,
  DeviceRecord,
  DeviceRole,
  LocalDeviceIdentityRecord
} from '../contracts/velContracts';
import {
  generateDeviceCryptoMaterial,
  isPrivateKeyProtected
} from '../crypto/deviceCrypto';
import { velDb, VelStorageAdapter } from '../db/db';
import {
  DeviceAnonymousAuthResult,
  ensureDeviceAnonymousSession,
  getFreshDeviceAuthToken,
  signOutDeviceAuth
} from './firebase';

export const ROLE_CHANGE_CONFIRMATION_KEYWORD = 'CAMBIAR ROL';

export interface SetupProgressStep {
  step: 'storage' | 'crypto' | 'firebase_auth' | 'backend_register' | 'completed';
  status: 'pending' | 'in_progress' | 'done' | 'error';
  detail: string;
}

export interface DeviceSetupResult {
  success: boolean;
  identity: DeviceIdentitySummary | null;
  registeredInServer: boolean;
  requiresExternalConfig?: boolean;
  error?: string;
}

export interface DeviceSessionSyncResult {
  synced: boolean;
  identity: DeviceIdentitySummary;
  serverDevice?: DeviceRecord | null;
  revoked?: boolean;
  error?: string;
}

export interface DeviceIdentityDeps {
  storage?: VelStorageAdapter;
  ensureAnonymousAuth?: () => Promise<DeviceAnonymousAuthResult>;
  getFreshToken?: () => Promise<string | null>;
  signOutAnonymous?: () => Promise<void>;
  fetchFn?: typeof fetch;
}

function resolveBoundFetch(customFetch?: typeof fetch): typeof fetch {
  if (!customFetch || (typeof globalThis !== 'undefined' && customFetch === globalThis.fetch)) {
    return (...args: Parameters<typeof fetch>) => globalThis.fetch(...args);
  }
  return (...args: Parameters<typeof fetch>) => customFetch(...args);
}

export function toIdentitySummary(record: LocalDeviceIdentityRecord): DeviceIdentitySummary {
  return {
    deviceId: record.deviceId,
    role: record.role,
    fingerprint: record.fingerprint,
    publicKeySpkiBase64: record.publicKeySpkiBase64,
    signingPublicKeySpkiBase64: record.signingPublicKeySpkiBase64,
    firebaseAuthUid: record.firebaseAuthUid,
    registrationStatus: record.registrationStatus,
    activeLinkId: record.activeLinkId,
    pairedPeerDeviceId: record.pairedPeerDeviceId,
    lastServerError: record.lastServerError,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/**
 * Carga la identidad técnica persistida localmente en IndexedDB al abrir la PWA.
 * Verifica que las claves privadas sigan protegidas (extractable: false).
 */
export async function loadPersistedDeviceIdentity(
  deps: DeviceIdentityDeps = {}
): Promise<DeviceIdentitySummary | null> {
  const storage = deps.storage || velDb;
  const record = await storage.getIdentity();
  if (!record) return null;

  if (
    !isPrivateKeyProtected(record.privateEcdhKey) ||
    !isPrivateKeyProtected(record.privateSigningKey)
  ) {
    throw new Error('Integridad comprometida: las claves privadas locales no cumplen extractable=false.');
  }

  return toIdentitySummary(record);
}

/**
 * Configura automáticamente una nueva instalación de VEL (CORE o MÓVIL):
 * 1. Verifica persistencia IndexedDB.
 * 2. Genera identificador aleatorio y claves Web Crypto API no exportables.
 * 3. Persiste localmente de inmediato para proteger las claves en el navegador.
 * 4. Autentica de forma anónima con Firebase Auth técnico.
 * 5. Registra la identidad y claves públicas en Firestore mediante Netlify Function (/api/register-device).
 */
export async function setupNewDeviceIdentity(
  role: DeviceRole,
  onProgress?: (steps: SetupProgressStep[]) => void,
  deps: DeviceIdentityDeps = {}
): Promise<DeviceSetupResult> {
  const storage = deps.storage || velDb;
  const ensureAuth = deps.ensureAnonymousAuth || ensureDeviceAnonymousSession;
  const fetchFn = resolveBoundFetch(deps.fetchFn);

  const steps: SetupProgressStep[] = [
    { step: 'storage', status: 'in_progress', detail: 'Preparando almacenamiento local seguro (IndexedDB)...' },
    { step: 'crypto', status: 'pending', detail: 'Generando identidad única y claves Web Crypto protegidas...' },
    { step: 'firebase_auth', status: 'pending', detail: 'Estableciendo sesión técnica anónima sin contraseña...' },
    { step: 'backend_register', status: 'pending', detail: 'Registrando identidad pública en Firebase/Firestore...' }
  ];
  const emit = () => onProgress?.(steps.map((s) => ({ ...s })));
  emit();

  // Protección contra reescritura accidental si ya existe identidad persistida
  const existing = await storage.getIdentity();
  if (existing) {
    return {
      success: true,
      identity: toIdentitySummary(existing),
      registeredInServer: existing.registrationStatus === 'registered' || existing.registrationStatus === 'paired'
    };
  }

  // Paso 1 + 2: Generar material criptográfico no exportable e ID único
  steps[0] = { step: 'storage', status: 'done', detail: 'Almacenamiento local IndexedDB listo.' };
  steps[1] = { step: 'crypto', status: 'in_progress', detail: 'Generando par ECDH/ECDSA P-256 no exportable...' };
  emit();

  const material = await generateDeviceCryptoMaterial(role);
  const nowIso = new Date().toISOString();

  let localRecord: LocalDeviceIdentityRecord = {
    id: 'current',
    deviceId: material.deviceId,
    role,
    fingerprint: material.fingerprint,
    publicKeySpkiBase64: material.publicKeySpkiBase64,
    signingPublicKeySpkiBase64: material.signingPublicKeySpkiBase64,
    privateEcdhKey: material.ecdhKeyPair.privateKey,
    privateSigningKey: material.signingKeyPair.privateKey,
    firebaseAuthUid: null,
    registrationStatus: 'pending_local',
    activeLinkId: null,
    pairedPeerDeviceId: null,
    lastServerError: null,
    createdAt: nowIso,
    updatedAt: nowIso
  };

  await storage.saveIdentity(localRecord);
  steps[1] = {
    step: 'crypto',
    status: 'done',
    detail: `Identidad técnica generada: ${material.deviceId} (claves privadas protegidas en dispositivo).`
  };

  // Paso 3: Sesión técnica anónima Firebase (sin contraseña)
  steps[2] = { step: 'firebase_auth', status: 'in_progress', detail: 'Autenticando sesión técnica en Firebase...' };
  emit();

  const authRes = await ensureAuth();
  if (!authRes.success || !authRes.idToken || !authRes.uid) {
    const errMsg =
      authRes.errorMessage || 'No se pudo iniciar la sesión técnica anónima en Firebase Authentication.';
    localRecord = {
      ...localRecord,
      lastServerError: errMsg,
      updatedAt: new Date().toISOString()
    };
    await storage.saveIdentity(localRecord);

    steps[2] = { step: 'firebase_auth', status: 'error', detail: errMsg };
    steps[3] = { step: 'backend_register', status: 'error', detail: 'Registro en Firestore en espera de sesión Firebase válida.' };
    emit();

    return {
      success: false,
      identity: toIdentitySummary(localRecord),
      registeredInServer: false,
      requiresExternalConfig: Boolean(authRes.providerDisabled),
      error: errMsg
    };
  }

  localRecord = {
    ...localRecord,
    firebaseAuthUid: authRes.uid,
    updatedAt: new Date().toISOString()
  };
  await storage.saveIdentity(localRecord);
  steps[2] = {
    step: 'firebase_auth',
    status: 'done',
    detail: 'Sesión técnica autenticada en Firebase (sin contraseña).'
  };

  // Paso 4: Registro seguro en Firestore vía Netlify Function (/api/register-device)
  steps[3] = {
    step: 'backend_register',
    status: 'in_progress',
    detail: 'Registrando clave pública y huella en Firestore...'
  };
  emit();

  return registerLocalIdentityOnServer(localRecord, authRes.idToken, steps, onProgress, {
    storage,
    fetchFn
  });
}

async function registerLocalIdentityOnServer(
  localRecord: LocalDeviceIdentityRecord,
  idToken: string,
  steps?: SetupProgressStep[],
  onProgress?: (steps: SetupProgressStep[]) => void,
  deps: { storage: VelStorageAdapter; fetchFn?: typeof fetch } = { storage: velDb }
): Promise<DeviceSetupResult> {
  const safeFetch = resolveBoundFetch(deps.fetchFn);
  try {
    const response = await safeFetch('/api/register-device', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      // Solo se envían identificadores y claves públicas. Nunca claves privadas ni datos personales.
      body: JSON.stringify({
        deviceId: localRecord.deviceId,
        role: localRecord.role,
        publicKeySpkiBase64: localRecord.publicKeySpkiBase64,
        signingPublicKeySpkiBase64: localRecord.signingPublicKeySpkiBase64,
        fingerprint: localRecord.fingerprint
      })
    });

    const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      const errMsg =
        'El endpoint /api/register-device no está activo en este despliegue estático (Netlify Drop no publica Netlify Functions). Para registrar el dispositivo en Firestore se requiere Netlify Functions con FIREBASE_SERVICE_ACCOUNT.';
      const updated: LocalDeviceIdentityRecord = {
        ...localRecord,
        lastServerError: errMsg,
        updatedAt: new Date().toISOString()
      };
      await deps.storage.saveIdentity(updated);
      if (steps && steps[3]) {
        steps[3] = { step: 'backend_register', status: 'error', detail: errMsg };
        onProgress?.(steps.map((s) => ({ ...s })));
      }
      return {
        success: false,
        identity: toIdentitySummary(updated),
        registeredInServer: false,
        requiresExternalConfig: true,
        error: errMsg
      };
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      const errMsg =
        data.error || `Error registrando dispositivo en el servidor (HTTP ${response.status}).`;
      const updated: LocalDeviceIdentityRecord = {
        ...localRecord,
        lastServerError: errMsg,
        updatedAt: new Date().toISOString()
      };
      await deps.storage.saveIdentity(updated);

      if (steps && steps[3]) {
        steps[3] = { step: 'backend_register', status: 'error', detail: errMsg };
        onProgress?.(steps.map((s) => ({ ...s })));
      }

      return {
        success: false,
        identity: toIdentitySummary(updated),
        registeredInServer: false,
        requiresExternalConfig: Boolean(data.pendingConfig),
        error: errMsg
      };
    }

    const confirmed: LocalDeviceIdentityRecord = {
      ...localRecord,
      registrationStatus: (data.device?.status as LocalDeviceIdentityRecord['registrationStatus']) || 'registered',
      lastServerError: null,
      updatedAt: new Date().toISOString()
    };
    await deps.storage.saveIdentity(confirmed);

    if (steps && steps[3]) {
      steps[3] = {
        step: 'backend_register',
        status: 'done',
        detail: 'Identidad pública registrada y verificada en Cloud Firestore.'
      };
      onProgress?.(steps.map((s) => ({ ...s })));
    }

    return {
      success: true,
      identity: toIdentitySummary(confirmed),
      registeredInServer: true
    };
  } catch (err: any) {
    const errMsg = err?.message || 'No se pudo contactar al servicio de registro de VEL.';
    const updated: LocalDeviceIdentityRecord = {
      ...localRecord,
      lastServerError: errMsg,
      updatedAt: new Date().toISOString()
    };
    await deps.storage.saveIdentity(updated);

    if (steps && steps[3]) {
      steps[3] = { step: 'backend_register', status: 'error', detail: errMsg };
      onProgress?.(steps.map((s) => ({ ...s })));
    }

    return {
      success: false,
      identity: toIdentitySummary(updated),
      registeredInServer: false,
      error: errMsg
    };
  }
}

/**
 * Reintenta el registro en Firebase/Firestore de una identidad ya creada localmente.
 * Conserva exactamente el mismo deviceId y las mismas claves privadas no exportables.
 */
export async function retryPendingDeviceRegistration(
  deps: DeviceIdentityDeps = {}
): Promise<DeviceSetupResult> {
  const storage = deps.storage || velDb;
  const ensureAuth = deps.ensureAnonymousAuth || ensureDeviceAnonymousSession;
  const fetchFn = resolveBoundFetch(deps.fetchFn);

  const existing = await storage.getIdentity();
  if (!existing) {
    return {
      success: false,
      identity: null,
      registeredInServer: false,
      error: 'No hay una identidad técnica local pendiente de registro.'
    };
  }

  const authRes = await ensureAuth();
  if (!authRes.success || !authRes.idToken || !authRes.uid) {
    const errMsg = authRes.errorMessage || 'Sesión técnica de Firebase no disponible.';
    const updated: LocalDeviceIdentityRecord = {
      ...existing,
      lastServerError: errMsg,
      updatedAt: new Date().toISOString()
    };
    await storage.saveIdentity(updated);
    return {
      success: false,
      identity: toIdentitySummary(updated),
      registeredInServer: false,
      requiresExternalConfig: Boolean(authRes.providerDisabled),
      error: errMsg
    };
  }

  const withUid: LocalDeviceIdentityRecord = {
    ...existing,
    firebaseAuthUid: authRes.uid,
    updatedAt: new Date().toISOString()
  };
  await storage.saveIdentity(withUid);

  return registerLocalIdentityOnServer(withUid, authRes.idToken, undefined, undefined, {
    storage,
    fetchFn
  });
}

/**
 * Sincroniza la identidad persistida al reabrir la PWA con el servidor (/api/device-session).
 * Actualiza lastSeenAt y refleja el estado real (registered, paired o revoked).
 */
export async function syncPersistedDeviceSession(
  deps: DeviceIdentityDeps = {}
): Promise<DeviceSessionSyncResult | null> {
  const storage = deps.storage || velDb;
  const ensureAuth = deps.ensureAnonymousAuth || ensureDeviceAnonymousSession;
  const getToken = deps.getFreshToken || getFreshDeviceAuthToken;
  const fetchFn = resolveBoundFetch(deps.fetchFn);

  const existing = await storage.getIdentity();
  if (!existing) return null;

  let token = await getToken();
  if (!token) {
    const authRes = await ensureAuth();
    if (!authRes.success || !authRes.idToken) {
      return {
        synced: false,
        identity: toIdentitySummary(existing),
        error: authRes.errorMessage || 'Sin sesión técnica activa en Firebase.'
      };
    }
    token = authRes.idToken;
  }

  if (existing.registrationStatus === 'pending_local') {
    const retryRes = await retryPendingDeviceRegistration(deps);
    return {
      synced: retryRes.registeredInServer,
      identity: retryRes.identity || toIdentitySummary(existing),
      error: retryRes.error
    };
  }

  try {
    const res = await fetchFn(
      `/api/device-session?deviceId=${encodeURIComponent(existing.deviceId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const contentType = (res.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      return {
        synced: false,
        identity: toIdentitySummary(existing),
        error: 'El endpoint /api/device-session no está disponible en un despliegue estático sin Netlify Functions.'
      };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success || !data.device) {
      return {
        synced: false,
        identity: toIdentitySummary(existing),
        error: data.error || `No se pudo verificar el estado en Firestore (HTTP ${res.status}).`
      };
    }

    const serverDevice = data.device as DeviceRecord;
    const updated: LocalDeviceIdentityRecord = {
      ...existing,
      registrationStatus: serverDevice.status,
      activeLinkId: serverDevice.activeLinkId || null,
      pairedPeerDeviceId: serverDevice.pairedPeerDeviceId || null,
      lastServerError: null,
      updatedAt: new Date().toISOString()
    };
    await storage.saveIdentity(updated);

    return {
      synced: true,
      identity: toIdentitySummary(updated),
      serverDevice,
      revoked: serverDevice.status === 'revoked'
    };
  } catch (err: any) {
    return {
      synced: false,
      identity: toIdentitySummary(existing),
      error: err?.message || 'Error de conexión verificando el estado del dispositivo.'
    };
  }
}

/**
 * Procedimiento controlado para cambiar el rol de este navegador/instalación.
 * Exige confirmación explícita textual ("CAMBIAR ROL"), revoca la identidad anterior
 * en Firestore si estaba registrada y limpia el almacenamiento local antes de permitir otro rol.
 */
export async function executeControlledRoleChange(
  confirmationInput: string,
  deps: DeviceIdentityDeps = {}
): Promise<{ success: boolean; error?: string }> {
  if (confirmationInput.trim().toUpperCase() !== ROLE_CHANGE_CONFIRMATION_KEYWORD) {
    return {
      success: false,
      error: `Para confirmar el cambio de rol debes escribir exactamente: ${ROLE_CHANGE_CONFIRMATION_KEYWORD}`
    };
  }

  const storage = deps.storage || velDb;
  const getToken = deps.getFreshToken || getFreshDeviceAuthToken;
  const ensureAuth = deps.ensureAnonymousAuth || ensureDeviceAnonymousSession;
  const signOutFn = deps.signOutAnonymous || signOutDeviceAuth;
  const fetchFn = resolveBoundFetch(deps.fetchFn);

  const existing = await storage.getIdentity();
  if (existing && existing.registrationStatus !== 'pending_local') {
    let token = await getToken();
    if (!token) {
      const authRes = await ensureAuth();
      token = authRes.idToken || null;
    }

    if (token) {
      try {
        await fetchFn('/api/device-session', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            action: 'deactivate_for_role_change',
            deviceId: existing.deviceId
          })
        });
      } catch {
        // Si no hay conectividad transitoria, se limpia localmente para permitir reconfiguración explícita
      }
    }
  }

  await storage.clearIdentity();
  try {
    await signOutFn();
  } catch {
    // Silencioso
  }

  return { success: true };
}
