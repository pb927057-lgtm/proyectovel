import {
  getAdminDb,
  getFirebaseAdminPendingConfigResponse,
  hasFirebaseAdminCredentials,
  TokenVerificationResult,
  verifyUserTokenStrict
} from './shared/firebaseAdmin';
import {
  createFirestoreAdminDeviceStore,
  DeviceTransactionStore,
  revokeDeviceAuthorizationAtomic
} from './shared/deviceAuthService';

export interface RevokeDeviceDeps {
  verifyToken?: (authHeader?: string) => Promise<TokenVerificationResult>;
  hasDbCredentials?: () => boolean;
  getDeviceStore?: () => DeviceTransactionStore;
  nowProvider?: () => Date;
}

export async function revokeDeviceHandler(event: any, deps: RevokeDeviceDeps = {}) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Método no permitido. Utilizar POST.' })
    };
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  const verifyTokenFn = deps.verifyToken || verifyUserTokenStrict;
  const tokenCheck = await verifyTokenFn(authHeader);

  if (!tokenCheck.authenticated) {
    const isPending = tokenCheck.reason === 'pending_config';
    return {
      statusCode: isPending ? 503 : 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        pendingConfig: isPending,
        ...(isPending
          ? {
              configReason: tokenCheck.configReason,
              missingVariables: tokenCheck.missingVariables ?? []
            }
          : {}),
        error: tokenCheck.message
      })
    };
  }

  const checkDbCreds = deps.hasDbCredentials || hasFirebaseAdminCredentials;
  if (!checkDbCreds()) {
    const pending = getFirebaseAdminPendingConfigResponse();
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        pendingConfig: true,
        configReason: pending.configReason,
        missingVariables: pending.missingVariables,
        error: pending.error
      })
    };
  }

  let body: Record<string, any>;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Cuerpo JSON inválido.' })
    };
  }

  try {
    const store = deps.getDeviceStore
      ? deps.getDeviceStore()
      : createFirestoreAdminDeviceStore(getAdminDb());
    const now = deps.nowProvider ? deps.nowProvider() : new Date();

    const outcome = await revokeDeviceAuthorizationAtomic(
      store,
      tokenCheck.uid,
      {
        coreDeviceId: String(body.coreDeviceId || '').trim(),
        targetTerminalId: body.targetTerminalId ? String(body.targetTerminalId).trim() : null,
        reason: body.reason ? String(body.reason) : undefined
      },
      now
    );

    if (!outcome.ok) {
      return {
        statusCode: outcome.statusCode,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          success: false,
          code: outcome.code,
          error: outcome.reason
        })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        success: true,
        revokedTerminalId: outcome.revokedTerminalId,
        revokedLinkId: outcome.revokedLinkId,
        coreDevice: outcome.coreDevice
      })
    };
  } catch (err: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: `Error revocando autorización en Firestore: ${err?.message || err}`
      })
    };
  }
}

export const handler = async (event: any) => {
  return revokeDeviceHandler(event);
};
