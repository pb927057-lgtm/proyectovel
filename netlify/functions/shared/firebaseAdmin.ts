import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getAuth, Auth } from 'firebase-admin/auth';

// Correos electrónicos autorizados para administración comercial de precios
export const AUTHORIZED_ADMIN_EMAILS = [
  'admin@vel.com',
  'soporte@vel.com',
  'pb927057@gmail.com'
];

export class FirebaseAdminConfigError extends Error {
  public readonly code = 'FIREBASE_ADMIN_CONFIG_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'FirebaseAdminConfigError';
  }
}

interface ParsedServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

function normalizePemPrivateKey(rawKey: string): string {
  let key = String(rawKey || '').trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  key = key.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  return key;
}

function hasPemMarkers(privateKey: string): boolean {
  return (
    privateKey.includes('-----BEGIN PRIVATE KEY-----') &&
    privateKey.includes('-----END PRIVATE KEY-----')
  );
}

function resolveServiceAccountCredentials(): {
  ok: boolean;
  credentials?: ParsedServiceAccount;
  error?: string;
} {
  const defaultProjectId = String(process.env.FIREBASE_PROJECT_ID || 'proyecto-vel').trim() || 'proyecto-vel';
  const serviceAccountEnv = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();

  if (serviceAccountEnv) {
    try {
      const parsed = serviceAccountEnv.startsWith('{')
        ? JSON.parse(serviceAccountEnv)
        : JSON.parse(Buffer.from(serviceAccountEnv, 'base64').toString('utf8'));

      const clientEmail = String(parsed?.client_email || '').trim();
      const privateKey = normalizePemPrivateKey(String(parsed?.private_key || ''));
      const projectId = String(parsed?.project_id || defaultProjectId).trim() || defaultProjectId;

      if (!clientEmail || !privateKey || !hasPemMarkers(privateKey)) {
        return {
          ok: false,
          error:
            'FIREBASE_SERVICE_ACCOUNT no contiene un client_email o una clave privada PEM válida.'
        };
      }

      return {
        ok: true,
        credentials: { projectId, clientEmail, privateKey }
      };
    } catch {
      return {
        ok: false,
        error: 'No se pudo interpretar FIREBASE_SERVICE_ACCOUNT (JSON/Base64 inválido).'
      };
    }
  }

  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const rawPrivateKey = String(process.env.FIREBASE_PRIVATE_KEY || '').trim();

  if (clientEmail || rawPrivateKey) {
    if (!clientEmail || !rawPrivateKey) {
      return {
        ok: false,
        error:
          'Configuración incompleta en Netlify: debes definir tanto FIREBASE_CLIENT_EMAIL como FIREBASE_PRIVATE_KEY (o FIREBASE_SERVICE_ACCOUNT).'
      };
    }

    const privateKey = normalizePemPrivateKey(rawPrivateKey);
    if (!hasPemMarkers(privateKey)) {
      return {
        ok: false,
        error:
          'FIREBASE_PRIVATE_KEY no tiene formato PEM válido (faltan cabeceras BEGIN/END PRIVATE KEY).'
      };
    }

    return {
      ok: true,
      credentials: {
        projectId: defaultProjectId,
        clientEmail,
        privateKey
      }
    };
  }

  return {
    ok: false,
    error:
      'Configuración pendiente en Netlify: falta configurar FIREBASE_SERVICE_ACCOUNT o FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.'
  };
}

/**
 * Comprueba si existen credenciales de Firebase Admin SDK utilizables en el entorno
 * (ya sea FIREBASE_SERVICE_ACCOUNT o bien FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY).
 */
export function hasFirebaseAdminCredentials(): boolean {
  return resolveServiceAccountCredentials().ok;
}

export function initFirebaseAdmin(): App {
  const apps = getApps();
  if (apps.length > 0 && apps[0]) {
    return apps[0];
  }

  const resolved = resolveServiceAccountCredentials();
  if (!resolved.ok || !resolved.credentials) {
    throw new FirebaseAdminConfigError(
      resolved.error || 'Credenciales de Firebase Admin SDK no disponibles.'
    );
  }

  try {
    return initializeApp({
      credential: cert({
        projectId: resolved.credentials.projectId,
        clientEmail: resolved.credentials.clientEmail,
        privateKey: resolved.credentials.privateKey
      }),
      projectId: resolved.credentials.projectId
    });
  } catch (err: any) {
    throw new FirebaseAdminConfigError(
      `No se pudo inicializar Firebase Admin SDK con la clave configurada: ${err?.message || err}`
    );
  }
}

export function getAdminDb(): Firestore {
  const app = initFirebaseAdmin();
  return getFirestore(app);
}

export function getAdminAuth(): Auth {
  const app = initFirebaseAdmin();
  return getAuth(app);
}

export type TokenVerificationResult =
  | { authenticated: true; uid: string; email: string }
  | {
      authenticated: false;
      reason: 'missing_token' | 'invalid_token' | 'pending_config';
      message: string;
    };

/**
 * Verificación estricta de Firebase ID Token mediante Firebase Admin SDK.
 * Distingue errores de configuración/credencial del servidor (pending_config -> 503)
 * de tokens realmente inválidos o expirados (invalid_token -> 401).
 */
export async function verifyUserTokenStrict(authHeader?: string): Promise<TokenVerificationResult> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      authenticated: false,
      reason: 'missing_token',
      message: 'No autorizado. Debes iniciar sesión para continuar.'
    };
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return {
      authenticated: false,
      reason: 'missing_token',
      message: 'Token de sesión vacío.'
    };
  }

  let auth: Auth;
  try {
    auth = getAdminAuth();
  } catch (err: any) {
    console.warn('Error de configuración Firebase Admin SDK:', err?.message || err);
    return {
      authenticated: false,
      reason: 'pending_config',
      message:
        err?.message ||
        'Configuración pendiente en Netlify: falta configurar FIREBASE_SERVICE_ACCOUNT (o FIREBASE_CLIENT_EMAIL y FIREBASE_PRIVATE_KEY) para verificar tokens en el servidor.'
    };
  }

  try {
    const decoded = await auth.verifyIdToken(token);
    if (!decoded || !decoded.uid) {
      return {
        authenticated: false,
        reason: 'invalid_token',
        message: 'Token de Firebase inválido.'
      };
    }

    return {
      authenticated: true,
      uid: decoded.uid,
      email: decoded.email || ''
    };
  } catch (err: any) {
    console.warn('Rechazo de ID Token de Firebase:', err?.message || err);
    return {
      authenticated: false,
      reason: 'invalid_token',
      message: 'Token de Firebase inválido o expirado.'
    };
  }
}

/**
 * Compatibilidad para funciones existentes: retorna { uid, email } o null si no es válido.
 */
export async function verifyUserToken(authHeader?: string): Promise<{ uid: string; email?: string } | null> {
  const result = await verifyUserTokenStrict(authHeader);
  if (!result.authenticated) {
    return null;
  }
  return {
    uid: result.uid,
    email: result.email
  };
}

/**
 * Valida si un usuario posee privilegios de administración comercial
 */
export function isUserAdmin(email?: string, customClaims?: any): boolean {
  if (customClaims && customClaims.admin === true) {
    return true;
  }
  if (!email) return false;
  const cleanEmail = email.toLowerCase().trim();
  return AUTHORIZED_ADMIN_EMAILS.includes(cleanEmail);
}
