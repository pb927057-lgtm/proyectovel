import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getAuth, Auth } from 'firebase-admin/auth';

// Correos autorizados para administración comercial
export const AUTHORIZED_ADMIN_EMAILS = [
  'admin@vel.com',
  'soporte@vel.com',
  'pb927057@gmail.com'
];

/**
 * Obtiene las credenciales desde una cuenta de servicio completa
 * o desde las variables independientes de Netlify.
 */
function getFirebaseCredentials(): any | null {
  const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (serviceAccountEnv?.trim()) {
    try {
      const value = serviceAccountEnv.trim();
      const parsed = value.startsWith('{')
        ? JSON.parse(value)
        : JSON.parse(Buffer.from(value, 'base64').toString('utf8'));

      if (parsed.client_email && parsed.private_key) {
        return {
          ...parsed,
          private_key: parsed.private_key.replace(/\\n/g, '\n')
        };
      }
    } catch (error) {
      console.error('FIREBASE_SERVICE_ACCOUNT no tiene un formato válido.');
      return null;
    }
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim();

  if (!clientEmail || !privateKey) {
    return null;
  }

  return {
    project_id: process.env.FIREBASE_PROJECT_ID || 'proyecto-vel',
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, '\n')
  };
}

/**
 * Comprueba si existen credenciales válidas en el entorno.
 */
export function hasFirebaseAdminCredentials(): boolean {
  const credentials = getFirebaseCredentials();

  return Boolean(
    credentials?.client_email &&
    credentials?.private_key &&
    credentials?.project_id
  );
}

/**
 * Inicializa Firebase Admin SDK.
 */
export function initFirebaseAdmin(): App {
  const apps = getApps();

  if (apps.length > 0 && apps[0]) {
    return apps[0];
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || 'proyecto-vel';
  const credentials = getFirebaseCredentials();

  if (credentials) {
    return initializeApp({
      credential: cert(credentials),
      projectId: credentials.project_id || projectId
    });
  }

  return initializeApp({ projectId });
}

export function getAdminDb(): Firestore {
  return getFirestore(initFirebaseAdmin());
}

export function getAdminAuth(): Auth {
  return getAuth(initFirebaseAdmin());
}

export type TokenVerificationResult =
  | { authenticated: true; uid: string; email: string }
  | {
      authenticated: false;
      reason: 'missing_token' | 'invalid_token' | 'pending_config';
      message: string;
    };

/**
 * Verificación estricta de Firebase ID Token.
 */
export async function verifyUserTokenStrict(
  authHeader?: string
): Promise<TokenVerificationResult> {
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

  if (!hasFirebaseAdminCredentials()) {
    return {
      authenticated: false,
      reason: 'pending_config',
      message:
        'Configuración pendiente en Netlify: faltan las credenciales de Firebase Admin.'
    };
  }

  try {
    const auth = getAdminAuth();
    const decoded = await auth.verifyIdToken(token);

    if (!decoded?.uid) {
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
  } catch (error: any) {
    console.warn(
      'Rechazo de ID Token de Firebase:',
      error?.message || 'Error de verificación'
    );

    return {
      authenticated: false,
      reason: 'invalid_token',
      message: 'Token de Firebase inválido o expirado.'
    };
  }
}

/**
 * Compatibilidad con funciones existentes.
 */
export async function verifyUserToken(
  authHeader?: string
): Promise<{ uid: string; email?: string } | null> {
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
 * Comprueba privilegios de administración.
 */
export function isUserAdmin(email?: string, customClaims?: any): boolean {
  if (customClaims?.admin === true) {
    return true;
  }

  if (!email) return false;

  return AUTHORIZED_ADMIN_EMAILS.includes(email.toLowerCase().trim());
}

