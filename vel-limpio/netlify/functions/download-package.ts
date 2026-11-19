import {
  verifyUserTokenStrict,
  getAdminDb,
  TokenVerificationResult
} from './shared/firebaseAdmin';
import {
  buildBloggerCorsHeaders,
  isOriginAllowedForBlogger
} from './shared/corsBlogger';
import {
  createSubscriptionPass,
  evaluateSubscriberAccess,
  GRACE_PERIOD_MS
} from './shared/subscriptionAccess';
import { SuscriptorAdminRecord } from './shared/types';

export { GRACE_PERIOD_MS };

export interface DownloadPackageDeps {
  verifyToken?: (authHeader?: string) => Promise<TokenVerificationResult>;
  getSubscriber?: (uid: string) => Promise<SuscriptorAdminRecord | null>;
  updateSubscriberStatus?: (uid: string, patch: Partial<SuscriptorAdminRecord>) => Promise<void>;
  nowProvider?: () => Date;
}

async function defaultGetSubscriber(uid: string): Promise<SuscriptorAdminRecord | null> {
  const db = getAdminDb();
  const snap = await db.collection('suscriptores').doc(uid).get();
  return snap.exists ? (snap.data() as SuscriptorAdminRecord) : null;
}

async function defaultUpdateSubscriberStatus(
  uid: string,
  patch: Partial<SuscriptorAdminRecord>
): Promise<void> {
  const db = getAdminDb();
  await db.collection('suscriptores').doc(uid).update(patch);
}

function resolvePwaAccessUrl(host?: string, velPass?: string | null): string {
  const envBase = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  const cleanHost = String(host || '').trim().replace(/\/+$/, '');
  let baseUrl = '/';
  if (envBase) {
    baseUrl = `${envBase}/`;
  } else if (cleanHost) {
    const protocol = cleanHost.includes('localhost') || cleanHost.startsWith('127.0.0.1') ? 'http' : 'https';
    baseUrl = `${protocol}://${cleanHost}/`;
  }
  if (velPass) {
    return `${baseUrl}?vel_pass=${encodeURIComponent(velPass)}`;
  }
  return baseUrl;
}

export async function downloadPackageHandler(event: any, deps: DownloadPackageDeps = {}) {
  const origin = event.headers?.origin || event.headers?.Origin;
  const host = event.headers?.host || event.headers?.Host || '';
  const corsHeaders = buildBloggerCorsHeaders(origin, host || 'proyecto-vel.netlify.app');

  if (origin && !isOriginAllowedForBlogger(origin, host || 'proyecto-vel.netlify.app')) {
    return {
      statusCode: 403,
      headers: {
        'Content-Type': 'application/json',
        Vary: 'Origin'
      },
      body: JSON.stringify({
        authorized: false,
        error: 'Origen no autorizado por la política CORS de VEL.'
      })
    };
  }

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ''
    };
  }

  // 1. Extraer token de cabecera 'Authorization' o de parámetro 'token'
  let authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader && event.queryStringParameters?.token) {
    authHeader = `Bearer ${event.queryStringParameters.token}`;
  }

  const verifyTokenFn = deps.verifyToken || verifyUserTokenStrict;
  const tokenCheck = await verifyTokenFn(authHeader);

  if (!tokenCheck.authenticated) {
    if (tokenCheck.reason === 'pending_config') {
      return {
        statusCode: 503,
        headers: corsHeaders,
        body: JSON.stringify({
          authorized: false,
          pendingConfig: true,
          configReason: tokenCheck.configReason,
          missingVariables: tokenCheck.missingVariables ?? [],
          error: tokenCheck.message
        })
      };
    }

    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({
        authorized: false,
        error: 'No autenticado. Debes iniciar sesión con tu cuenta para acceder a la descarga de la aplicación.'
      })
    };
  }

  const uid = tokenCheck.uid;
  const now = deps.nowProvider ? deps.nowProvider() : new Date();
  const nowIso = now.toISOString();
  const wantsJson =
    event.queryStringParameters?.format === 'json' ||
    String(event.headers?.accept || event.headers?.Accept || '').includes('application/json');

  try {
    const getSubscriberFn = deps.getSubscriber || defaultGetSubscriber;
    const updateStatusFn = deps.updateSubscriberStatus || defaultUpdateSubscriberStatus;
    const subData = await getSubscriberFn(uid);

    const evalRes = evaluateSubscriberAccess(subData, now);
    if (!evalRes.active) {
      if (evalRes.shouldPersistEstado) {
        try {
          // La suspensión comercial no borra datos personales, VEL CORE ni revoca dispositivos
          await updateStatusFn(uid, {
            estado: evalRes.shouldPersistEstado,
            ultimaActualizacion: nowIso
          });
        } catch (err) {
          console.warn('Advertencia actualizando estado vencido/suspendido en Firestore:', err);
        }
      }

      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({
          authorized: false,
          estado: evalRes.estado,
          venceEl: evalRes.venceEl,
          error: evalRes.reason
        })
      };
    }

    const velPass = createSubscriptionPass(uid, now);
    const pwaAccessUrl = resolvePwaAccessUrl(host, velPass);

    // 3. Acceso/Descarga PWA autorizada (ilimitada durante todo el mes vigente)
    if (wantsJson) {
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          'Cache-Control': 'no-store'
        },
        body: JSON.stringify({
          authorized: true,
          estado: evalRes.estado,
          venceEl: evalRes.venceEl,
          downloadUrl: pwaAccessUrl
        })
      };
    }

    return {
      statusCode: 302,
      headers: {
        ...corsHeaders,
        Location: pwaAccessUrl,
        'Cache-Control': 'no-store'
      },
      body: ''
    };
  } catch (err: any) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        authorized: false,
        error: `Error validando autorización de descarga: ${err?.message || err}`
      })
    };
  }
}

export const handler = async (event: any) => {
  return downloadPackageHandler(event);
};
