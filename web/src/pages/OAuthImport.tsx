import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clipboard,
  ExternalLink,
  KeyRound,
  Loader2,
  MailPlus,
  Play,
  ShieldCheck,
  Square,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { oauthImportApi } from '../lib/api';
import { parseOAuthImportEmails } from '../lib/oauthImport';
import type { OAuthImportStartResult } from '../types';

type ItemStatus = 'queued' | 'starting' | 'waiting' | 'complete' | 'skipped' | 'failed' | 'cancelled';

interface ImportItem {
  email: string;
  status: ItemStatus;
  error?: string;
}

const statusLabels: Record<ItemStatus, string> = {
  queued: '等待处理',
  starting: '正在创建授权',
  waiting: '等待微软授权',
  complete: '导入成功',
  skipped: '账户已存在',
  failed: '导入失败',
  cancelled: '已停止',
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function StatusIcon({ status }: { status: ItemStatus }) {
  if (status === 'starting' || status === 'waiting') return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
  if (status === 'complete') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === 'skipped') return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  if (status === 'failed') return <XCircle className="h-4 w-4 text-red-500" />;
  if (status === 'cancelled') return <Square className="h-4 w-4 text-muted-foreground" />;
  return <Circle className="h-4 w-4 text-muted-foreground" />;
}

export default function OAuthImport() {
  const [content, setContent] = useState('');
  const [items, setItems] = useState<ImportItem[]>([]);
  const [current, setCurrent] = useState<OAuthImportStartResult | null>(null);
  const [running, setRunning] = useState(false);
  const runIdRef = useRef(0);

  const completedCount = useMemo(
    () => items.filter(item => ['complete', 'skipped', 'failed', 'cancelled'].includes(item.status)).length,
    [items],
  );

  const updateItem = (email: string, patch: Partial<ImportItem>) => {
    setItems(previous => previous.map(item => item.email === email ? { ...item, ...patch } : item));
  };

  const startImport = async () => {
    const { emails, invalidLines } = parseOAuthImportEmails(content);
    if (invalidLines.length > 0) {
      toast.error(`第 ${invalidLines.slice(0, 5).join('、')} 行邮箱格式无效`);
      return;
    }
    if (emails.length === 0) {
      toast.error('请至少输入一个 Outlook 邮箱');
      return;
    }

    const runId = ++runIdRef.current;
    setContent('');
    setItems(emails.map(email => ({ email, status: 'queued' })));
    setCurrent(null);
    setRunning(true);

    for (const email of emails) {
      if (runIdRef.current !== runId) break;
      updateItem(email, { status: 'starting', error: undefined });

      try {
        const started = await oauthImportApi.start(email);
        if (runIdRef.current !== runId) break;
        setCurrent(started);
        updateItem(email, { status: 'waiting' });

        while (runIdRef.current === runId) {
          const result = await oauthImportApi.status(started.sessionId);
          if (result.status === 'complete') {
            updateItem(email, { status: result.imported ? 'complete' : 'skipped' });
            break;
          }
          if (result.status === 'failed') {
            updateItem(email, { status: 'failed', error: result.error || '授权失败' });
            break;
          }
          await sleep(Math.max(result.retryAfterSeconds || started.intervalSeconds, 1) * 1000);
        }
      } catch (error: any) {
        updateItem(email, { status: 'failed', error: error.message || '导入失败' });
      } finally {
        if (runIdRef.current === runId) setCurrent(null);
      }
    }

    if (runIdRef.current === runId) {
      setRunning(false);
      setCurrent(null);
      toast.success('本批次处理完成');
    }
  };

  const stopImport = () => {
    runIdRef.current += 1;
    setRunning(false);
    setCurrent(null);
    setItems(previous => previous.map(item =>
      ['queued', 'starting', 'waiting'].includes(item.status) ? { ...item, status: 'cancelled' } : item
    ));
    toast.info('已停止继续处理，当前微软授权会话会自动过期');
  };

  const copyCode = async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.userCode);
      toast.success('授权码已复制');
    } catch {
      toast.error('复制失败，请手动复制授权码');
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Microsoft OAuth 导入</h1>
        <p className="mt-1 text-sm text-muted-foreground">只填写邮箱地址，在微软官方页面完成首次授权后自动导入。</p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {[
          { icon: MailPlus, title: '1. 粘贴邮箱', text: '每行一个邮箱，可一次提交多个。' },
          { icon: KeyRound, title: '2. 官方授权', text: '逐个打开微软页面登录并接受权限。' },
          { icon: ShieldCheck, title: '3. 自动导入', text: '校验登录身份后保存 OAuth refresh token。' },
        ].map(step => (
          <div key={step.title} className="rounded-xl border border-border bg-card p-4">
            <step.icon className="h-5 w-5 text-primary" />
            <h2 className="mt-3 text-sm font-semibold text-foreground">{step.title}</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.text}</p>
          </div>
        ))}
      </div>

      <section className="rounded-xl border border-border bg-card p-5">
        <label htmlFor="oauth-emails" className="text-sm font-semibold text-foreground">邮箱列表</label>
        <p className="mt-1 text-sm text-muted-foreground">不需要填写邮箱密码。兼容粘贴“邮箱----密码”或“邮箱|密码”，密码内容会被忽略。</p>
        <textarea
          id="oauth-emails"
          value={content}
          onChange={event => setContent(event.target.value)}
          disabled={running}
          rows={8}
          placeholder={'account1@outlook.com\naccount2@hotmail.com'}
          className="mt-4 w-full resize-y rounded-lg border border-border bg-background px-3 py-3 font-mono text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={startImport}
            disabled={running}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? '正在处理' : '开始 OAuth 导入'}
          </button>
          {running && (
            <button
              type="button"
              onClick={stopImport}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <Square className="h-4 w-4" />
              停止
            </button>
          )}
          <p className="text-xs text-muted-foreground">网站不会收集或保存邮箱密码。</p>
        </div>
      </section>

      {current && (
        <section className="rounded-xl border border-blue-200 bg-blue-50 p-5 dark:border-blue-900 dark:bg-blue-950/30" aria-live="polite">
          <div className="flex items-start gap-3">
            <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold text-blue-950 dark:text-blue-100">请授权：{current.email}</h2>
              <p className="mt-1 text-sm leading-6 text-blue-800 dark:text-blue-200">请确保微软页面登录的邮箱与上方目标邮箱完全一致。完成后本页会自动继续。</p>

              <div className="mt-4 flex flex-col gap-3 rounded-lg border border-blue-200 bg-white p-4 dark:border-blue-900 dark:bg-zinc-950 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">微软授权码</p>
                  <p className="mt-1 font-mono text-2xl font-bold tracking-widest text-foreground">{current.userCode}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={copyCode}
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <Clipboard className="h-4 w-4" />
                    复制授权码
                  </button>
                  <a
                    href={current.verificationUriComplete}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  >
                    <ExternalLink className="h-4 w-4" />
                    打开微软授权页
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {items.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">导入进度</h2>
              <p className="mt-1 text-xs text-muted-foreground">已处理 {completedCount} / {items.length}</p>
            </div>
            <div className="h-2 w-28 overflow-hidden rounded-full bg-secondary sm:w-48" aria-label={`导入进度 ${completedCount}/${items.length}`}>
              <div className="h-full bg-primary transition-all duration-300" style={{ width: `${items.length ? completedCount / items.length * 100 : 0}%` }} />
            </div>
          </div>
          <div className="divide-y divide-border">
            {items.map(item => (
              <div key={item.email} className="flex items-start gap-3 px-5 py-3.5">
                <StatusIcon status={item.status} />
                <div className="min-w-0 flex-1">
                  <p className="break-all text-sm font-medium text-foreground">{item.email}</p>
                  {item.error && <p className="mt-1 text-xs leading-5 text-red-600 dark:text-red-400">{item.error}</p>}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{statusLabels[item.status]}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
