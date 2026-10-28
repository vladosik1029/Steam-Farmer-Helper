import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Play, Package, ShieldCheck, Settings, RefreshCw, Wallet, ShieldAlert, Copy, Check, X, Zap } from 'lucide-react';
import { apiPost } from '../lib/api';
import { ensureSealed, loginSteamAccount, setAutomation } from '../lib/accounts';
import { useData } from '../lib/data';
import { useMask } from '../lib/prefs';
import { sessionState, type SteamAccount } from '../lib/types';
import { Avatar, SessionBadge, Toggle } from './ui';
import { EditAccountModal } from './AccountModals';

export function BanBadges({ account }: { account: SteamAccount }) {
  const badges: { text: string; cls: string }[] = [];
  if (account.vacBanned || (account.vacBans ?? 0) > 0) {
    badges.push({ text: `VAC${account.vacBans ? ` ×${account.vacBans}` : ''}`, cls: 'bg-bad/15 text-bad' });
  }
  if ((account.gameBans ?? 0) > 0) badges.push({ text: `Game ban ×${account.gameBans}`, cls: 'bg-bad/15 text-bad' });
  if (account.tradeBanState && !['None', 'none'].includes(account.tradeBanState)) {
    badges.push({ text: `Trade: ${account.tradeBanState}`, cls: 'bg-copper/15 text-copper' });
  }
  if (account.communityBanned) badges.push({ text: 'Community ban', cls: 'bg-bad/15 text-bad' });
  if (account.isLimitedAccount) badges.push({ text: 'Limited', cls: 'bg-raised text-muted' });
  if (badges.length === 0) return <span className="chip bg-ok/10 text-ok">Без блокировок</span>;
  return (
    <>
      {badges.map((b) => (
        <span key={b.text} className={`chip ${b.cls}`}><ShieldAlert size={11} />{b.text}</span>
      ))}
    </>
  );
}

export function AccountCard({ account, onOpenInventory }: { account: SteamAccount; onOpenInventory: () => void }) {
  const { sessions, refreshSessions } = useData();
  const mask = useMask();
  const session = account.steamId ? sessions[account.steamId] : undefined;
  const state = sessionState(account, session);

  const [code, setCode] = useState<{ value: string; validFor: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const flash = (text: string, ms = 4000) => {
    setStatus(text);
    setTimeout(() => setStatus(null), ms);
  };

  const generateCode = async () => {
    try {
      const sealed = await ensureSealed(account);
      const data = await apiPost('/api/steam/code', { sealed });
      setCode({ value: data.code, validFor: data.validFor ?? 30 });
      setTimeout(() => setCode(null), (data.validFor ?? 30) * 1000);
    } catch (e: any) {
      flash(`Ошибка: ${e.message}`);
    }
  };

  const connect = async () => {
    setBusy(true);
    try {
      await loginSteamAccount(account, setStatus);
      await refreshSessions();
      flash('Подключено', 2500);
    } catch (err: any) {
      flash(`Ошибка: ${err.message}`, 6000);
    } finally {
      setBusy(false);
    }
  };

  const toggleAutomation = async (enabled: boolean) => {
    try {
      await setAutomation(account, enabled, !!session?.loggedIn);
      await refreshSessions();
    } catch (err: any) {
      flash(`Ошибка: ${err.message}`);
    }
  };

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card p-5 relative overflow-hidden flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <Avatar src={account.avatar} size={52} />
        <div className="min-w-0 flex-1">
          <div className="font-bold text-ink truncate">{mask(account.personaName || account.accountName, 1)}</div>
          <div className="text-xs text-muted font-mono truncate">{mask(account.accountName)}</div>
          <div className="mt-1.5"><SessionBadge state={state} /></div>
        </div>
        <button onClick={() => setEditing(true)} className="btn-ghost btn-sm" title="Настройки аккаунта"><Settings size={16} /></button>
      </div>

      <div className="card-inset p-3.5 space-y-2.5 text-xs">
        <div className="flex justify-between items-center">
          <span className="text-faint">SteamID</span>
          <span className="font-mono text-muted">{mask(account.steamId || account.id, 4)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-faint flex items-center gap-1.5"><Wallet size={12} /> Баланс</span>
          <span className="font-bold text-ink">{mask(`${account.walletBalance || '0.00'} ${account.walletCurrency || ''}`.trim(), 0) || '—'}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-faint">Токен</span>
          <span className="text-muted">
            {account.tokenExpires ? `до ${new Date(account.tokenExpires).toLocaleDateString()}` : account.hasToken ? 'есть' : 'нет'}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1"><BanBadges account={account} /></div>
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-2 text-muted"><Zap size={13} className="text-accent" /> Автоподтверждение</span>
        <Toggle
          checked={!!account.automation}
          onChange={toggleAutomation}
          disabled={!account.hasToken}
          label="Автоподтверждение маркета и безопасных трейдов"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button onClick={connect} disabled={busy} className={state === 'active' ? 'btn-secondary' : 'btn-primary'}>
          {busy ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
          {busy ? 'Подключаю' : state === 'active' ? 'Обновить' : 'Войти'}
        </button>
        <button onClick={onOpenInventory} className="btn-secondary">
          <Package size={15} /> Инвентарь
        </button>
      </div>

      <button onClick={generateCode} className="btn-ghost btn-sm self-start -mt-1">
        <ShieldCheck size={14} className="text-accent" /> Код Steam Guard
      </button>

      {status && (
        <div className="absolute top-3 right-14 max-w-[60%] chip bg-accent/15 text-accent truncate">{status}</div>
      )}

      <AnimatePresence>
        {code && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-surface/95 backdrop-blur z-10 flex flex-col items-center justify-center gap-3 p-6"
          >
            <div className="text-xs font-semibold text-muted">Steam Guard · {mask(account.accountName)}</div>
            <div className="text-5xl font-mono font-bold text-accent tracking-[0.2em] select-all">{code.value}</div>
            <div className="w-40 h-1 bg-raised rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-accent"
                initial={{ width: `${(code.validFor / 30) * 100}%` }}
                animate={{ width: '0%' }}
                transition={{ duration: code.validFor, ease: 'linear' }}
              />
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(code.value);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="btn-secondary btn-sm"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Скопировано' : 'Скопировать'}
            </button>
            <button onClick={() => setCode(null)} className="absolute top-3 right-3 btn-ghost btn-sm"><X size={16} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {editing && <EditAccountModal account={account} onClose={() => setEditing(false)} />}
    </motion.div>
  );
}
