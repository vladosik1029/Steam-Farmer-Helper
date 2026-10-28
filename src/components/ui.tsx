import React from 'react';
import { motion } from 'motion/react';
import { X, Users } from 'lucide-react';
import type { SessionState } from '../lib/types';

export function Modal({ title, subtitle, onClose, children, footer, wide }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className={`bg-surface border border-line rounded-2xl w-full ${wide ? 'max-w-5xl h-[85vh]' : 'max-w-lg max-h-[90vh]'} flex flex-col overflow-hidden shadow-2xl shadow-black/40`}
      >
        <div className="px-6 py-4 border-b border-line flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-ink truncate">{title}</h3>
            {subtitle && <p className="text-xs text-muted truncate">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="btn-ghost btn-sm" aria-label="Закрыть"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-line flex justify-end gap-3">{footer}</div>}
      </motion.div>
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, label }: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 cursor-pointer ${
        checked ? 'bg-accent border-accent' : 'bg-raised border-line-strong'
      }`}
    >
      <span className={`inline-block h-4 w-4 rounded-full transition-transform ${checked ? 'translate-x-6 bg-accent-ink' : 'translate-x-1 bg-muted'}`} />
    </button>
  );
}

const SESSION_LABELS: Record<SessionState, { text: string; cls: string }> = {
  'active': { text: 'Сессия активна', cls: 'bg-ok/15 text-ok' },
  'stale': { text: 'Сессия устарела', cls: 'bg-warn/15 text-warn' },
  'token-expired': { text: 'Токен истёк', cls: 'bg-bad/15 text-bad' },
  'no-token': { text: 'Нужен пароль', cls: 'bg-bad/15 text-bad' },
  'unsealed': { text: 'Не зашифрован', cls: 'bg-copper/15 text-copper' }
};

export function SessionBadge({ state }: { state: SessionState }) {
  const { text, cls } = SESSION_LABELS[state];
  return (
    <span className={`chip ${cls}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {text}
    </span>
  );
}

export function Avatar({ src, size = 48 }: { src?: string; size?: number }) {
  return (
    <div className="rounded-xl bg-raised overflow-hidden border border-line shrink-0 flex items-center justify-center text-faint" style={{ width: size, height: size }}>
      {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : <Users size={size / 2.2} />}
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: React.ReactNode; title: string; text?: string; action?: React.ReactNode }) {
  return (
    <div className="card p-12 flex flex-col items-center justify-center text-center gap-3">
      <div className="w-14 h-14 rounded-2xl bg-raised text-faint flex items-center justify-center">{icon}</div>
      <h3 className="text-lg font-bold text-ink">{title}</h3>
      {text && <p className="text-sm text-muted max-w-md">{text}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
      <div>
        <h2 className="text-2xl font-extrabold text-ink tracking-tight">{title}</h2>
        {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function formatRub(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}
