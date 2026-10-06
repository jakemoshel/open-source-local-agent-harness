import { Children, forwardRef, isValidElement, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Copy, Loader2, X } from 'lucide-react'
import type { RunStatus } from '@shared/types'
import { cx } from '@/lib/cx'
import markUrl from '@/assets/mark.png'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }>(
  ({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'no-drag inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-8 px-3 text-sm',
        variant === 'primary' && 'bg-accent text-on-accent hover:bg-accent-hover',
        variant === 'secondary' && 'border border-line-2 bg-bg text-fg hover:bg-hover',
        variant === 'ghost' && 'text-fg-2 hover:bg-hover hover:text-fg',
        variant === 'danger' && 'bg-red text-white hover:opacity-90',
        className
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  )
)

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(({ className, mono, ...rest }, ref) => (
  <input
    ref={ref}
    className={cx(
      'h-8 w-full rounded-md border border-line-2 bg-bg px-2.5 text-sm text-fg placeholder:text-fg-3 focus:border-fg-3 focus:outline-none',
      mono && 'font-mono text-[13px]',
      className
    )}
    {...rest}
  />
))

/**
 * Whole-number field that only reports values within [min, max]. While typing, an empty or out-of-range entry stays
 * local (so a field can be cleared and retyped); leaving the field restores the last valid value.
 */
export function NumberInput({ value, onChange, min = 0, max = Number.MAX_SAFE_INTEGER, className }: { value: number; onChange: (n: number) => void; min?: number; max?: number; className?: string }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={1}
      className={className}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isInteger(n) && n >= min && n <= max && n !== value) onChange(n)
      }}
      onBlur={() => setText(String(value))}
    />
  )
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(({ className, mono, ...rest }, ref) => (
  <textarea
    ref={ref}
    className={cx(
      'w-full resize-y rounded-md border border-line-2 bg-bg px-2.5 py-2 text-sm text-fg placeholder:text-fg-3 focus:border-fg-3 focus:outline-none',
      mono && 'font-mono text-[13px] leading-relaxed',
      className
    )}
    {...rest}
  />
))

interface Opt { value: string; label: string; description?: string; disabled?: boolean }

function textOf(node: ReactNode): string {
  return Children.toArray(node).map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : isValidElement(c) ? textOf((c.props as { children?: ReactNode }).children) : '')).join('')
}

/** Reads <option> children (including fragments, arrays and conditionals) so callers keep native-select markup. */
function optionsOf(children: ReactNode): Opt[] {
  const out: Opt[] = []
  for (const c of Children.toArray(children)) {
    if (!isValidElement(c)) continue
    const props = c.props as { value?: string | number; title?: string; disabled?: boolean; children?: ReactNode }
    if (c.type === 'option') {
      const label = textOf(props.children)
      out.push({ value: props.value !== undefined ? String(props.value) : label, label, description: props.title || undefined, disabled: props.disabled })
    } else out.push(...optionsOf(props.children))
  }
  return out
}

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { compact?: boolean }

/** Themed dropdown with the native <select> API: <option> children, value, onChange(e.target.value). */
export function Select({ className, children, value, onChange, disabled, compact, title, ...rest }: SelectProps) {
  const options = optionsOf(children)
  const current = String(value ?? '')
  const selected = options.find((o) => o.value === current)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const choose = (o: Opt) => {
    if (o.disabled) return
    setOpen(false)
    button.current?.focus()
    if (o.value !== current) onChange?.({ target: { value: o.value }, currentTarget: { value: o.value } } as unknown as React.ChangeEvent<HTMLSelectElement>)
  }

  useLayoutEffect(() => {
    if (!open || !button.current) return
    const r = button.current.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 12
    const above = r.top - 12
    const up = below < 180 && above > below
    const width = Math.max(r.width, compact ? 180 : 0)
    setPos({ left: Math.min(r.left, Math.max(8, window.innerWidth - width - 8)), width, maxHeight: Math.min(320, up ? above : below), ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) })
    setActive(Math.max(0, options.findIndex((o) => o.value === current)))
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (e: Event) => { if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false) }
    const dismiss = (e: Event) => { if (!list.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true) }
  }, [open])

  useEffect(() => { if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active, open, pos])

  const move = (dir: 1 | -1) => {
    let i = active
    for (let n = 0; n < options.length; n++) { i = (i + dir + options.length) % options.length; if (!options[i].disabled) break }
    setActive(i)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); setOpen(true) }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (options[active]) choose(options[active]) }
    else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={rest['aria-label']}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className={cx(
          'no-drag inline-flex items-center justify-between gap-1.5 rounded-md text-left text-fg outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          compact ? 'h-7 bg-bg-2 px-2 text-xs hover:bg-hover' : 'h-8 border border-line-2 bg-bg px-2.5 text-sm hover:bg-hover focus-visible:border-fg-3',
          open && (compact ? 'bg-hover' : 'border-fg-3'),
          className
        )}
      >
        <span className={cx('min-w-0 flex-1 truncate', !selected && 'text-fg-3')}>{selected?.label ?? (current || 'Select…')}</span>
        <ChevronDown className={cx('size-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-180')} />
      </button>
      {/* In <body>: a modal's backdrop blur makes it the containing block for fixed elements, which shifted the list. */}
      {open && pos && createPortal(
        <div
          ref={list}
          role="listbox"
          style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width, maxHeight: pos.maxHeight }}
          className="no-drag z-[70] max-w-[min(28rem,calc(100vw-16px))] overflow-y-auto rounded-lg border border-line-2 bg-bg p-1 shadow-[var(--shadow)]"
        >
          {options.map((o, i) => (
            <div
              key={o.value + i}
              role="option"
              aria-selected={o.value === current}
              aria-disabled={o.disabled}
              data-active={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(o)}
              className={cx('flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm', i === active && 'bg-hover', o.disabled && 'cursor-not-allowed opacity-40')}
            >
              <Check className={cx('mt-0.5 size-3.5 shrink-0', o.value === current ? 'text-fg' : 'opacity-0')} />
              <span className="min-w-0">
                <span className="block truncate">{o.label}</span>
                {o.description && <span className="block text-xs leading-snug text-fg-3">{o.description}</span>}
              </span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('no-drag relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', checked ? 'bg-fg' : 'bg-line-2')}
    >
      <span className={cx('inline-block size-4 rounded-full bg-bg shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-line-2 bg-bg-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx('h-6 rounded px-2.5 text-[13px] font-medium transition-colors', value === o.value ? 'bg-bg text-fg shadow-[0_0_0_1px_var(--border-2)]' : 'text-fg-2 hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('rounded-lg border border-line bg-surface', className)} {...rest}>
      {children}
    </div>
  )
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold">{title}</div>
        {description && <div className="mt-0.5 text-[13px] text-fg-2">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.03em]">{title}</h1>
        {description && <p className="mt-1 text-sm text-fg-2">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

const statusStyle: Record<RunStatus, { color: string; label: string; pulse?: boolean }> = {
  queued: { color: 'bg-fg-3', label: 'Queued' },
  running: { color: 'bg-amber', label: 'Running', pulse: true },
  awaiting_approval: { color: 'bg-purple', label: 'Needs approval', pulse: true },
  succeeded: { color: 'bg-green', label: 'Ready' },
  failed: { color: 'bg-red', label: 'Error' },
  cancelled: { color: 'bg-fg-3', label: 'Canceled' }
}

export function StatusDot({ status, className }: { status: RunStatus; className?: string }) {
  const s = statusStyle[status]
  return <span className={cx('inline-block size-2.5 shrink-0 rounded-full', s.color, s.pulse && 'animate-pulse-dot', className)} />
}

export function Status({ status }: { status: RunStatus }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <StatusDot status={status} />
      {statusStyle[status].label}
    </span>
  )
}

export function Badge({ children, tone = 'gray', className }: { children: ReactNode; tone?: 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'purple'; className?: string }) {
  const tones = {
    gray: 'bg-bg-3 text-fg-2',
    blue: 'bg-accent-subtle text-accent',
    green: 'bg-green/12 text-green',
    amber: 'bg-amber/15 text-amber',
    red: 'bg-red/12 text-red',
    purple: 'bg-purple/12 text-purple'
  }
  return <span className={cx('inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-2 bg-bg-2 px-1 font-sans text-[11px] text-fg-2">{children}</kbd>
}

export function Empty({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-full border border-line text-fg-2">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {description && <div className="mt-1 max-w-sm text-[13px] text-fg-2">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <div className="mb-1.5 text-[13px] font-medium text-fg-2">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-fg-3">{hint}</div>}
    </label>
  )
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="no-drag fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 pt-[10vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div className={cx('w-full rounded-xl border border-line bg-bg shadow-[var(--shadow)]', wide ? 'max-w-3xl' : 'max-w-lg')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="text-base font-semibold">{title}</div>
          <button onClick={onClose} className="rounded p-1 text-fg-3 hover:bg-hover hover:text-fg">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 pb-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 rounded-b-xl border-t border-line bg-bg-2 px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={cx('rounded p-1 text-fg-3 hover:bg-hover hover:text-fg', className)}
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
      title="Copy"
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-4 animate-spin text-fg-3', className)} />
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="rounded-md border border-red/30 bg-red/8 px-3 py-2 text-[13px] text-red">{error}</div>
}

export function Meter({ value, max }: { value: number; max: number }) {
  const pct = Math.min(100, (value / max) * 100)
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
      <div className={cx('h-full rounded-full', pct > 95 ? 'bg-red' : pct > 80 ? 'bg-amber' : 'bg-fg')} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** The Jarvis mark: a Mac mini seen from above, with a HUD ring. */
export function Mark({ className }: { className?: string }) {
  return <img src={markUrl} alt="Jarvis" draggable={false} className={cx('rounded-[22%]', className)} />
}
