import React, { useState } from 'react';
import {
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  ExternalLink,
  Link2,
  RefreshCw,
  Shield,
  Smartphone,
  Unlink,
  X
} from 'lucide-react';
import { DeviceIdentitySummary } from '../contracts/velContracts';
import { LocalStorageStats, formatBytesHuman } from '../db/velLocalStore';
import { PWAInstallState } from '../hooks/usePWAInstall';
import { ROLE_CHANGE_CONFIRMATION_KEYWORD } from '../services/deviceIdentityService';
import { OFFICIAL_CONTRACT_URL } from '../services/firestore';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  identity: DeviceIdentitySummary;
  stats: LocalStorageStats;
  pwa: PWAInstallState;
  peerOnline: boolean;
  isPairingPending: boolean;
  onOpenInstallGuide: () => void;
  onStartPairing: () => void;
  onUnlinkPeer: () => Promise<{ success: boolean; error?: string }>;
  onConfirmRoleChange: (keyword: string) => Promise<{ success: boolean; error?: string }>;
  onRetryCloudSync: () => Promise<void>;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  identity,
  stats,
  pwa,
  peerOnline,
  isPairingPending,
  onOpenInstallGuide,
  onStartPairing,
  onUnlinkPeer,
  onConfirmRoleChange,
  onRetryCloudSync
}) => {
  const [showRoleChangeForm, setShowRoleChangeForm] = useState(false);
  const [roleKeyword, setRoleKeyword] = useState('');
  const [roleError, setRoleError] = useState<string | null>(null);
  const [isChangingRole, setIsChangingRole] = useState(false);

  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [isUnlinking, setIsUnlinking] = useState(false);
  const [unlinkFeedback, setUnlinkFeedback] = useState<string | null>(null);

  const [showTechInfo, setShowTechInfo] = useState(false);
  const [isSyncingCloud, setIsSyncingCloud] = useState(false);

  if (!open) return null;

  const isCore = identity.role === 'CORE';
  const isPaired = identity.registrationStatus === 'paired' && Boolean(identity.pairedPeerDeviceId);

  const handleUnlink = async () => {
    setIsUnlinking(true);
    setUnlinkFeedback(null);
    const res = await onUnlinkPeer();
    setIsUnlinking(false);
    setConfirmUnlink(false);
    if (!res.success && res.error) {
      setUnlinkFeedback(res.error);
    } else {
      onClose();
    }
  };

  const handleRoleChangeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsChangingRole(true);
    setRoleError(null);
    const res = await onConfirmRoleChange(roleKeyword);
    setIsChangingRole(false);
    if (!res.success) {
      setRoleError(res.error || 'Confirmación incorrecta.');
    } else {
      setShowRoleChangeForm(false);
      setRoleKeyword('');
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-[#111C2E] border-t sm:border border-[#22324C] rounded-t-3xl sm:rounded-3xl max-h-[88dvh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1.5 bg-[#22324C] rounded-full mx-auto mt-3 sm:hidden" />

        <div className="px-5 py-3.5 border-b border-[#22324C] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center border ${
                isCore
                  ? 'bg-[#00CFE8]/15 border-[#00CFE8]/40 text-[#00CFE8]'
                  : 'bg-[#10B981]/15 border-[#10B981]/40 text-[#10B981]'
              }`}
            >
              {isCore ? <Shield className="w-4 h-4" /> : <Smartphone className="w-4 h-4" />}
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">
                Opciones de {isCore ? 'VEL CORE' : 'VEL MÓVIL'}
              </h2>
              <p className="text-xs text-[#94A3B8]">
                {isCore ? 'Teléfono principal en casa' : 'Teléfono de uso diario'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] rounded-xl text-[#94A3B8] hover:text-white hover:bg-[#18263E] flex items-center justify-center cursor-pointer"
            aria-label="Cerrar opciones"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Instalar app si está abierto en el navegador */}
          {!pwa.isInstalled && (
            <button
              type="button"
              onClick={async () => {
                if (pwa.isInstallable) {
                  await pwa.promptInstall();
                } else {
                  onClose();
                  onOpenInstallGuide();
                }
              }}
              className="w-full min-h-[48px] px-4 rounded-2xl bg-[#10B981] hover:bg-[#059669] text-[#0B1220] font-bold text-sm flex items-center justify-center gap-2 cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Instalar ícono de VEL en este teléfono</span>
            </button>
          )}

          {/* Estado de conexión entre los dos teléfonos */}
          <div className="p-4 rounded-2xl bg-[#0B1220] border border-[#22324C] space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-white">Conexión con el otro teléfono</span>
              <span
                className={`text-xs font-semibold flex items-center gap-1 ${
                  isPaired ? (peerOnline ? 'text-[#10B981]' : 'text-[#F59E0B]') : 'text-[#94A3B8]'
                }`}
              >
                {isPaired ? (
                  <>
                    <CheckCircle className="w-3.5 h-3.5" />
                    <span>{peerOnline ? 'Conectado ahora' : 'Vinculado (en espera)'}</span>
                  </>
                ) : (
                  <span>Sin conectar</span>
                )}
              </span>
            </div>

            {isCore && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onStartPairing();
                  }}
                  className="w-full min-h-[44px] px-4 rounded-xl bg-[#00CFE8] hover:bg-[#00b8ce] text-[#0B1220] font-bold text-xs flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Link2 className="w-4 h-4" />
                  <span>{isPaired ? 'Conectar un nuevo VEL MÓVIL' : 'Generar código para VEL MÓVIL'}</span>
                </button>

                {isPaired && !confirmUnlink && (
                  <button
                    type="button"
                    onClick={() => setConfirmUnlink(true)}
                    className="w-full min-h-[44px] px-4 rounded-xl bg-[#18263E] hover:bg-[#EF4444]/15 border border-[#22324C] hover:border-[#EF4444]/40 text-[#EF4444] font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Unlink className="w-4 h-4" />
                    <span>Desvincular VEL MÓVIL actual</span>
                  </button>
                )}

                {isPaired && confirmUnlink && (
                  <div className="p-3 rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/40 space-y-2">
                    <p className="text-xs text-[#FCA5A5]">
                      El móvil actual ya no podrá enviar archivos a este CORE hasta que vuelvas a ingresar un código.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={isUnlinking}
                        onClick={() => void handleUnlink()}
                        className="flex-1 min-h-[44px] rounded-xl bg-[#EF4444] text-white font-bold text-xs cursor-pointer"
                      >
                        {isUnlinking ? 'Desvinculando...' : 'Sí, desvincular'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmUnlink(false)}
                        className="flex-1 min-h-[44px] rounded-xl bg-[#18263E] text-white font-semibold text-xs cursor-pointer"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}

                {unlinkFeedback && <p className="text-xs text-[#FCA5A5]">{unlinkFeedback}</p>}
              </div>
            )}

            {!isCore && !isPaired && (
              <button
                type="button"
                disabled={isPairingPending}
                onClick={() => {
                  onClose();
                  onStartPairing();
                }}
                className="w-full min-h-[44px] px-4 rounded-xl bg-[#10B981] hover:bg-[#059669] text-[#0B1220] font-bold text-xs flex items-center justify-center gap-2 cursor-pointer"
              >
                <Link2 className="w-4 h-4" />
                <span>Ingresar código de mi VEL CORE</span>
              </button>
            )}
          </div>

          {/* Almacenamiento local */}
          <div className="p-4 rounded-2xl bg-[#0B1220] border border-[#22324C] flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Database className="w-4 h-4 text-[#00CFE8]" />
              <div>
                <p className="text-xs font-bold text-white">Guardado en este teléfono</p>
                <p className="text-xs text-[#94A3B8]">
                  {stats.itemCount} elemento(s) · {formatBytesHuman(stats.totalBytes)}
                </p>
              </div>
            </div>
            {identity.registrationStatus === 'pending_local' && (
              <button
                type="button"
                disabled={isSyncingCloud}
                onClick={async () => {
                  setIsSyncingCloud(true);
                  await onRetryCloudSync();
                  setIsSyncingCloud(false);
                }}
                className="min-h-[40px] px-3 rounded-xl bg-[#F59E0B]/20 border border-[#F59E0B]/40 text-[#FCD34D] text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncingCloud ? 'animate-spin' : ''}`} />
                <span>Activar enlace</span>
              </button>
            )}
          </div>

          {/* Cambiar rol */}
          <div className="p-4 rounded-2xl bg-[#0B1220] border border-[#22324C] space-y-2.5">
            <button
              type="button"
              onClick={() => {
                setShowRoleChangeForm((v) => !v);
                setRoleError(null);
              }}
              className="w-full min-h-[44px] flex items-center justify-between text-left text-xs font-semibold text-[#CBD5E1] hover:text-white cursor-pointer"
            >
              <span>Cambiar función de este teléfono (CORE / MÓVIL)</span>
              {showRoleChangeForm ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {showRoleChangeForm && (
              <form onSubmit={(e) => void handleRoleChangeSubmit(e)} className="space-y-2.5 pt-1">
                <p className="text-xs text-[#94A3B8] leading-relaxed">
                  Para cambiar este teléfono a otro rol, escribe{' '}
                  <strong className="text-white">{ROLE_CHANGE_CONFIRMATION_KEYWORD}</strong>:
                </p>
                <input
                  type="text"
                  value={roleKeyword}
                  onChange={(e) => setRoleKeyword(e.target.value)}
                  placeholder={ROLE_CHANGE_CONFIRMATION_KEYWORD}
                  className="w-full h-11 px-3 rounded-xl bg-[#111C2E] border border-[#22324C] focus:border-[#00CFE8] text-sm text-white outline-none"
                />
                {roleError && <p className="text-xs text-[#FCA5A5]">{roleError}</p>}
                <button
                  type="submit"
                  disabled={isChangingRole}
                  className="w-full min-h-[44px] rounded-xl bg-[#F59E0B] hover:bg-[#d97706] text-[#0B1220] font-bold text-xs cursor-pointer"
                >
                  {isChangingRole ? 'Cambiando...' : 'Confirmar cambio de rol'}
                </button>
              </form>
            )}
          </div>

          {/* Términos e información técnica discreta */}
          <div className="pt-1 space-y-2">
            <a
              href={OFFICIAL_CONTRACT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full min-h-[44px] px-3 rounded-xl flex items-center justify-center gap-1.5 text-xs text-[#94A3B8] hover:text-[#00CFE8]"
            >
              <span>Términos y condiciones de VEL</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>

            <button
              type="button"
              onClick={() => setShowTechInfo((v) => !v)}
              className="w-full min-h-[36px] text-[11px] text-[#64748B] hover:text-[#94A3B8] cursor-pointer"
            >
              {showTechInfo ? 'Ocultar referencia técnica' : 'Ver referencia técnica'}
            </button>

            {showTechInfo && (
              <div className="p-3 rounded-xl bg-[#0B1220] border border-[#22324C] text-[11px] text-[#94A3B8] space-y-1 font-mono break-all">
                <div>ID: {identity.deviceId}</div>
                <div>Estado: {identity.registrationStatus}</div>
                {identity.pairedPeerDeviceId && <div>Par: {identity.pairedPeerDeviceId}</div>}
                {identity.lastServerError && (
                  <div className="text-[#F59E0B] font-sans">Aviso: {identity.lastServerError}</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
