import React, { useRef, useState } from 'react';
import { Upload, RefreshCw, Trash2 } from 'lucide-react';
import { setDoc, deleteDoc } from '../lib/store';
import { apiPost } from '../lib/api';
import { saveSealedSecrets, updateAccount } from '../lib/accounts';
import { addLog } from '../lib/logs';
import { useData } from '../lib/data';
import type { SteamAccount } from '../lib/types';
import { Modal } from './ui';

// maFile stores SteamID64 as a bare number (17 digits > 2^53), so JSON.parse
// would round it to a different account. Quote long numeric IDs before parsing.
export function parseMaFile(text: string) {
  const safeText = text.replace(/("(?:SteamID|steamid|steam_id)"\s*:\s*)(\d{15,})/g, '$1"$2"');
  return JSON.parse(safeText);
}

function ProxySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { proxies } = useData();
  const known = value === '' || proxies.some((p) => p.url === value);
  const [custom, setCustom] = useState(!known);
  return (
    <div className="space-y-2">
      <select className="input w-full" value={custom ? '__custom' : value} onChange={(e) => {
        const next = e.target.value;
        setCustom(next === '__custom');
        if (next !== '__custom') onChange(next);
      }}>
        <option value="">Без прокси</option>
        {proxies.map((p) => <option key={p.id} value={p.url}>{p.label}</option>)}
        <option value="__custom">Свой адрес…</option>
      </select>
      {custom && (
        <input
          className="input w-full font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="socks5://user:pass@host:port (необязательно)"
        />
      )}
    </div>
  );
}

export function EditAccountModal({ account, onClose }: { account: SteamAccount; onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Never prefilled: the password is only used once to get a refresh token and is not stored
  const [password, setPassword] = useState('');
  const [proxy, setProxy] = useState(account.proxy || '');

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    try {
      await updateAccount(account, { proxy, lastUpdate: new Date().toISOString() });

      if (password) {
        const result = await apiPost('/api/accounts/seal', {
          accountName: account.accountName,
          password,
          sealed: account.secrets,
          // Legacy accounts: move plaintext maFile secrets into the encrypted blob too
          sharedSecret: account.secrets ? undefined : account.maFileData?.shared_secret,
          identitySecret: account.secrets ? undefined : account.maFileData?.identity_secret,
          revocationCode: account.secrets ? undefined : account.maFileData?.revocation_code,
          proxy: proxy || undefined
        });
        await saveSealedSecrets(account, result);
        await addLog({ level: 'success', type: 'token', message: 'Получен новый Steam-токен', accountName: account.accountName, steamId: account.steamId });
      }
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Удалить аккаунт ${account.accountName} из списка? Секреты и токен будут удалены.`)) return;
    try {
      await deleteDoc('accounts', account.id);
      await addLog({ level: 'warning', type: 'account', message: 'Аккаунт удалён из списка', accountName: account.accountName });
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal
      title="Настройки аккаунта"
      subtitle={account.accountName}
      onClose={onClose}
      footer={
        <>
          <button onClick={handleDelete} className="btn-danger mr-auto"><Trash2 size={15} /> Удалить</button>
          <button onClick={onClose} className="btn-ghost">Отмена</button>
          <button onClick={handleSave} disabled={loading} className="btn-primary">
            {loading && <RefreshCw size={14} className="animate-spin" />} Сохранить
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <label className="label">Пароль Steam</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input w-full"
            placeholder={account.hasToken ? 'Оставьте пустым, токен уже есть' : 'Нужен для получения токена'}
            autoComplete="new-password"
          />
          <p className="text-xs text-faint">
            Пароль не сохраняется: приложение один раз входит в Steam и хранит только зашифрованный токен.
            {account.tokenExpires ? ` Текущий токен действует до ${new Date(account.tokenExpires).toLocaleDateString()}.` : ''}
          </p>
        </div>

        <div className="space-y-2">
          <label className="label">Прокси для этого аккаунта</label>
          <ProxySelect value={proxy} onChange={setProxy} />
        </div>

        {error && <div className="p-3 rounded-xl bg-bad/10 border border-bad/30 text-bad text-sm">{error}</div>}
      </div>
    </Modal>
  );
}

type ImportRow = { fileName: string; data: any; password: string; status?: string; error?: string };

// Imports one or many maFiles at once
export function AddAccountModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [proxy, setProxy] = useState('');
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const next: ImportRow[] = [];
    for (const file of Array.from(files)) {
      try {
        const data = parseMaFile(await file.text());
        next.push({ fileName: file.name, data, password: data.password || '' });
      } catch {
        next.push({ fileName: file.name, data: null, password: '', error: 'Не JSON / не maFile' });
      }
    }
    setRows((r) => [...r, ...next]);
  };

  const updateRow = (i: number, patch: Partial<ImportRow>) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const importAll = async () => {
    setLoading(true);
    let ok = 0;
    for (let i = 0; i < rows.length; i++) {
      const { data, password, status } = rows[i];
      if (!data || status === 'ok') continue;
      const accountName = data.account_name || data.accountName;
      if (!accountName || !data.shared_secret) {
        updateRow(i, { error: 'Нет account_name или shared_secret' });
        continue;
      }
      updateRow(i, { status: 'busy', error: undefined });
      try {
        // Secrets are encrypted by the app core; with a password it also logs in once
        // and returns the real SteamID plus a refresh token. The password is not stored.
        const sealedResult = await apiPost('/api/accounts/seal', {
          accountName,
          password: password || undefined,
          sharedSecret: data.shared_secret,
          identitySecret: data.identity_secret,
          revocationCode: data.revocation_code,
          proxy: proxy || undefined
        });

        const steamId = String(sealedResult.steamId || data.Session?.SteamID || data.steamid || '');
        const accountId = steamId || `acc_${Date.now()}`;
        await setDoc('accounts', accountId, {
          steamId,
          accountName,
          personaName: accountName,
          walletBalance: '0.00',
          walletCurrency: '',
          status: 'active',
          proxy,
          automation: false,
          secrets: sealedResult.sealed,
          hasToken: sealedResult.hasToken,
          tokenExpires: sealedResult.tokenExpires ?? null,
          lastCheck: new Date().toISOString()
        });
        await addLog({ level: 'success', type: 'import', message: 'maFile импортирован', accountName, steamId });
        updateRow(i, { status: 'ok' });
        ok++;
      } catch (err: any) {
        updateRow(i, { status: 'error', error: err.message });
      }
    }
    setLoading(false);
    if (ok > 0 && rows.every((r) => r.status === 'ok' || !r.data)) onClose();
  };

  return (
    <Modal
      title="Импорт maFile"
      subtitle="Можно выбрать сразу несколько файлов"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">Закрыть</button>
          <button onClick={importAll} disabled={loading || rows.every((r) => !r.data || r.status === 'ok')} className="btn-primary">
            {loading && <RefreshCw size={14} className="animate-spin" />} Импортировать
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
          className="border-2 border-dashed border-line-strong rounded-2xl p-8 flex flex-col items-center gap-3 cursor-pointer hover:border-accent/60 hover:bg-accent/5 transition-colors"
        >
          <input type="file" ref={fileInputRef} onChange={(e) => handleFiles(e.target.files)} accept=".maFile,.json" multiple className="hidden" />
          <div className="w-12 h-12 rounded-xl bg-accent/15 text-accent flex items-center justify-center"><Upload size={22} /></div>
          <div className="text-center">
            <p className="font-bold text-ink">Выберите или перетащите maFile</p>
            <p className="text-xs text-muted">Файлы читаются локально, секреты шифруются на этом компьютере</p>
          </div>
        </div>

        {rows.length > 0 && (
          <div className="space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="card-inset p-3 space-y-2">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-semibold text-ink truncate">{row.data?.account_name || row.fileName}</span>
                  <span className={`chip ${row.status === 'ok' ? 'bg-ok/15 text-ok' : row.error ? 'bg-bad/15 text-bad' : 'bg-raised text-muted'}`}>
                    {row.status === 'ok' ? 'готово' : row.status === 'busy' ? 'вход…' : row.error ? 'ошибка' : 'ожидает'}
                  </span>
                </div>
                {row.data && row.status !== 'ok' && (
                  <input
                    type="password"
                    className="input w-full"
                    value={row.password}
                    onChange={(e) => updateRow(i, { password: e.target.value })}
                    placeholder="Пароль Steam (один раз, для токена; не сохраняется)"
                    autoComplete="new-password"
                  />
                )}
                {row.error && <p className="text-xs text-bad">{row.error}</p>}
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <label className="label">Прокси для импортируемых аккаунтов</label>
          <ProxySelect value={proxy} onChange={setProxy} />
        </div>
      </div>
    </Modal>
  );
}
