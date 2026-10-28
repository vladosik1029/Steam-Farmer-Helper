import React, { useState } from 'react';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { Plus, RefreshCw, Activity, Trash2, Palette, EyeOff, Percent, Network, KeyRound, Check } from 'lucide-react';
import { db } from '../lib/firebase';
import { apiPost } from '../lib/api';
import { useData } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import type { ProxyConfig } from '../lib/types';
import { PageHeader, Toggle } from '../components/ui';
import { BACKGROUNDS, BackgroundPreview } from '../components/Background';

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="card p-6">
      <h3 className="text-lg font-bold text-ink mb-4 flex items-center gap-2"><span className="text-accent">{icon}</span>{title}</h3>
      {children}
    </section>
  );
}

export function SettingsView() {
  const { user, proxies } = useData();
  const { prefs, setPrefs } = usePrefs();
  const [newLabel, setNewLabel] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const testProxy = async (proxy: ProxyConfig) => {
    setTesting(proxy.id);
    try {
      const data = await apiPost('/api/proxy/test', { proxy: proxy.url });
      setTestResult((r) => ({ ...r, [proxy.id]: `OK, IP ${data.ip}` }));
    } catch (e: any) {
      setTestResult((r) => ({ ...r, [proxy.id]: `Ошибка: ${e.message}` }));
    } finally {
      setTesting(null);
    }
  };

  const addProxy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel || !newUrl) return;
    setLoading(true);
    try {
      const proxyId = `proxy_${Date.now()}`;
      await setDoc(doc(db, 'users', user.uid, 'proxies', proxyId), {
        label: newLabel,
        url: newUrl.trim(),
        status: 'active',
        createdAt: serverTimestamp()
      });
      setNewLabel('');
      setNewUrl('');
    } catch (err: any) {
      alert(`Не удалось сохранить: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const deleteProxy = async (id: string) => {
    if (!window.confirm('Удалить этот прокси?')) return;
    await setDoc(doc(db, 'users', user.uid, 'proxies', id), { deleted: true }, { merge: true }).catch(console.error);
  };

  const maskUrl = (url: string) => url.replace(/\/\/([^:@/]+):([^@]+)@/, '//$1:••••@');

  return (
    <div className="space-y-6 max-w-4xl">
      <PageHeader title="Настройки" subtitle="Внешний вид, приватность, комиссии и прокси" />

      <Section icon={<Palette size={18} />} title="Фон">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {BACKGROUNDS.map((bg) => (
            <button
              key={bg.id}
              onClick={() => setPrefs({ background: bg.id })}
              className={`text-left rounded-2xl p-2 border transition-colors ${prefs.background === bg.id ? 'border-accent bg-accent/8' : 'border-line hover:border-line-strong'}`}
            >
              <BackgroundPreview id={bg.id} />
              <div className="flex items-center justify-between mt-2 px-1">
                <span className="text-sm font-semibold text-ink">{bg.name}</span>
                {prefs.background === bg.id ? <Check size={14} className="text-accent" /> : bg.animated && <span className="chip bg-raised text-faint">анимация</span>}
              </div>
            </button>
          ))}
        </div>
      </Section>

      <Section icon={<EyeOff size={18} />} title="Приватность">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="font-semibold text-ink">Скрывать логины и данные аккаунтов</div>
            <div className="text-sm text-muted">Логины, SteamID и балансы показываются звёздочками. Удобно для стримов и скриншотов.</div>
          </div>
          <Toggle checked={prefs.hideSensitive} onChange={(v) => setPrefs({ hideSensitive: v })} label="Скрывать данные" />
        </div>
      </Section>

      <Section icon={<Percent size={18} />} title="Комиссии">
        <div className="grid sm:grid-cols-2 gap-4 text-sm">
          <div className="card-inset p-4">
            <div className="font-semibold text-ink">Steam Market</div>
            <div className="text-muted">15% (5% Steam + 10% игра). «К получению» = цена / 1.15.</div>
          </div>
          <div className="card-inset p-4 space-y-2">
            <div className="font-semibold text-ink">market.csgo, комиссия продавца</div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={30}
                step={0.5}
                className="input w-24"
                value={prefs.csgoFeePercent}
                onChange={(e) => setPrefs({ csgoFeePercent: Math.min(30, Math.max(0, Number(e.target.value) || 0)) })}
              />
              <span className="text-muted">%</span>
            </div>
          </div>
        </div>
      </Section>

      <Section icon={<Network size={18} />} title="Прокси">
        <form onSubmit={addProxy} className="grid md:grid-cols-[200px_1fr_auto] gap-3 mb-4">
          <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} className="input" placeholder="Название" />
          <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} className="input font-mono text-xs" placeholder="socks5://user:pass@1.2.3.4:1080" />
          <button type="submit" disabled={loading} className="btn-primary">
            {loading ? <RefreshCw className="animate-spin" size={15} /> : <Plus size={15} />} Добавить
          </button>
        </form>
        <div className="space-y-2">
          {proxies.map((px) => (
            <div key={px.id} className="card-inset p-3 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-ink">{px.label}</div>
                <div className="text-[11px] font-mono text-faint truncate">{maskUrl(px.url)}</div>
                {testResult[px.id] && <div className={`text-xs ${testResult[px.id].startsWith('OK') ? 'text-ok' : 'text-bad'}`}>{testResult[px.id]}</div>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => testProxy(px)} disabled={testing === px.id} className="btn-secondary btn-sm">
                  {testing === px.id ? <RefreshCw size={13} className="animate-spin" /> : <Activity size={13} />} Проверить
                </button>
                <button onClick={() => deleteProxy(px.id)} className="btn-ghost btn-sm text-bad"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
          {proxies.length === 0 && <p className="text-sm text-faint">Прокси не добавлены.</p>}
        </div>
      </Section>

      <Section icon={<KeyRound size={18} />} title="Безопасность">
        <ul className="text-sm text-muted space-y-2 list-disc pl-5">
          <li>Пароли Steam не хранятся: после первого входа остаётся только зашифрованный refresh-токен (около 200 дней).</li>
          <li>Ключ шифрования лежит в файле <code className="text-accent">.env.local</code> на сервере (<code>SECRETS_KEY</code>). Сохраните его копию: без него все токены придётся получать заново.</li>
          <li>Все запросы к серверу проверяются по вашему входу в Firebase.</li>
        </ul>
      </Section>
    </div>
  );
}
