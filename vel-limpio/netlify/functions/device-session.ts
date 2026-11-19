import {
  getAdminDb,
  getFirebaseAdminPendingConfigResponse,
  hasFirebaseAdminCredentials,
  TokenVerificationResult,
  verifyUserTokenStrict
} from './shared/firebaseAdmin';
import {
  bindDeviceSubscriptionAtomic,
  createFirestoreAdminDeviceStore,
  deactivateDeviceForRoleChangeAtomic,
  DeviceTransactionStore,
  getAndRefreshDeviceSessionAtomic
} from './shared/deviceAuthService';
import {
  evaluateSubscriberAccess,
  verifySubscriptionPass
} from './shared/subscriptionAccess';
import type { SubscriptionRuntimeStatus } from '../../src/contracts/velContracts';

export interface DeviceSessionDeps {
  verifyToken?: (authHeader?: string) => Promise<TokenVerificationResult>;
  hasDbCredentials?: () => boolean;
  getDeviceStore?: () => DeviceTransactionStore;
  nowProvider?: () => Date;
}

async function resolveSubscriptionStatusForSession(
  store: DeviceTransactionStore,
  subscriptionUid: string | null | undefined,
  now: Date
): Promise<SubscriptionRuntimeStatus> {
  if (!subscriptionUid || !store.getSubscriber) {
    return { linked: false, active: true };
  }
  try {
    const sub = await store.getSubscriber(subscriptionUid);
    const evalRes = evaluateSubscriberAccess(sub, now);
    if (!evalRes.active && evalRes.shouldPersistEstado && store.updateSubscriberStatus) {
      try {
        await store.updateSubscriberStatus(subscriptionUid, {
          estado: evalRes.shouldPersistEstado,
          ultimaActualizacion: now.toISOString()
        });
      } catch {}
    }
    return {
      linked: true,
      active: evalRes.active,
      estado: evalRes.estado,
      venceEl: evalRes.venceEl,
      reason: evalRes.reason
    };
  } catch {
    return { linked: true, active: true };
  }
}

export async function deviceSessionHandler(event: any, deps: DeviceSessionDeps = {}) {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Método no permitido. Utilizar GET o POST.' })
    };
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  const verifyTokenFn = deps.verifyToken || verifyUserTokenStrict;
  const tokenCheck = await verifyTokenFn(authHeader);

  if (!tokenCheck.authenticated) {
    if (tokenCheck.reason === 'pending_config') {
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          pendingConfig: true,
          configReason: tokenCheck.configReason,
          missingVariables: tokenCheck.missingVariables ?? [],
          error: tokenCheck.message
        })
      };
    }

    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
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

  const store = deps.getDeviceStore
    ? deps.getDeviceStore()
    : createFirestoreAdminDeviceStore(getAdminDb());
  const now = deps.nowProvider ? deps.nowProvider() : new Date();

  try {
    if (event.httpMethod === 'GET') {
      const deviceId = String(event.queryStringParameters?.deviceId || '').trim();
      const outcome = await getAndRefreshDeviceSessionAtomic(store, tokenCheck.uid, deviceId, now);
      const subUid = outcome.device?.subscriptionUid || outcome.activeLink?.subscriptionUid || null;
      const subscriptionStatus = outcome.ok
        ? await resolveSubscriptionStatusForSession(store, subUid, now)
        : undefined;

      return {
        statusCode: outcome.statusCode,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(
          outcome.ok
            ? {
                success: true,
                device: outcome.device,
                activeLink: outcome.activeLink || null,
                activeAuthorization: outcome.activeAuthorization || null,
                subscriptionStatus
              }
            : {
                success: false,
                code: outcome.code,
                error: outcome.reason
              }
        )
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

    const action = String(body.action || 'status').trim();
    const deviceId = String(body.deviceId || '').trim();

    if (action === 'deactivate_for_role_change') {
      const outcome = await deactivateDeviceForRoleChangeAtomic(store, tokenCheck.uid, deviceId, now);
      return {
        statusCode: outcome.statusCode,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(
          outcome.ok
            ? { success: true, device: outcome.device }
            : { success: false, code: outcome.code, error: outcome.reason }
        )
      };
    }

    if (action === 'bind_subscription') {
      const passRes = verifySubscriptionPass(String(body.subscriptionPass || ''), now);
      if (!passRes.valid || !passRes.uid) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          body: JSON.stringify({
            success: false,
            code: 'INVALID_SUBSCRIPTION_PASS',
            error: passRes.reason || 'Pase de suscripción inválido o expirado.'
          })
        };
      }

      const outcome = await bindDeviceSubscriptionAtomic(store, tokenCheck.uid, deviceId, passRes.uid, now);
      const subscriptionStatus = outcome.ok
        ? await resolveSubscriptionStatusForSession(store, passRes.uid, now)
        : undefined;

      return {
        statusCode: outcome.statusCode,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(
          outcome.ok
            ? {
                success: true,
                device: outcome.device,
                activeLink: outcome.activeLink || null,
                activeAuthorization: outcome.activeAuthorization || null,
                subscriptionStatus
              }
            : { success: false, code: outcome.code, error: outcome.reason }
        )
      };
    }

    const outcome = await getAndRefreshDeviceSessionAtomic(store, tokenCheck.uid, deviceId, now);
    const subUid = outcome.device?.subscriptionUid || outcome.activeLink?.subscriptionUid || null;
    const subscriptionStatus = outcome.ok
      ? await resolveSubscriptionStatusForSession(store, subUid, now)
      : undefined;

    return {
      statusCode: outcome.statusCode,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(
        outcome.ok
          ? {
              success: true,
              device: outcome.device,
              activeLink: outcome.activeLink || null,
              activeAuthorization: outcome.activeAuthorization || null,
              subscriptionStatus
            }
          : {
              success: false,
              code: outcome.code,
              error: outcome.reason
            }
      )
    };
  } catch (err: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: `Error en sesión técnica del dispositivo: ${err?.message || err}`
      })
    };
  }
}

export const handler = async (event: any) => {
  return deviceSessionHandler(event);
};
