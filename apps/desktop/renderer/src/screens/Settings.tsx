import { ProviderStatus } from '../components/ProviderStatus';
import { useState } from 'react';

import { RiskNoticeText } from '../components/RiskNotice';
import { TemplateEditor } from '../components/TemplateEditor';
import { ipc } from '../ipc';
import { PROVIDERS, useShellStore } from '../store';

export function Settings() {
  const providers = useShellStore((s) => s.providers);
  const providerError = useShellStore((s) => s.providerError);
  const openProvider = useShellStore((s) => s.openProvider);
  const clearProvider = useShellStore((s) => s.clearProvider);
  const settings = useShellStore((s) => s.settings);
  const setPacingPreset = useShellStore((s) => s.setPacingPreset);
  const [showRisk, setShowRisk] = useState(false);
  const [dataMessage, setDataMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function dataAction(run: () => Promise<{ ok: true; text: string } | { ok: false; code: string; text: string }>): Promise<void> {
    try {
      const r = await run();
      // Cancelling the confirmation is a choice, not a failure.
      setDataMessage(r.ok ? { kind: 'ok', text: r.text } : r.code === 'cancelled' ? null : { kind: 'error', text: r.text });
    } catch (error) {
      setDataMessage({ kind: 'error', text: String(error) });
    }
  }

  return (
    <>
      <p className="mb-4 text-sm text-slate-600">
        Provider windows use this app&rsquo;s built-in browser. The app never opens your system default browser, and
        you log in yourself in the provider window.
      </p>
      {providerError && (
        <p role="alert" className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {providerError}
        </p>
      )}
      <ul className="space-y-3">
        {PROVIDERS.map((provider) => (
          <ProviderStatus
            key={provider}
            provider={provider}
            status={providers[provider]}
            onOpenLogin={() => void openProvider(provider, true)}
            onCheck={() => void openProvider(provider, false)}
            onClear={() => void clearProvider(provider)}
          />
        ))}
      </ul>
    
      <section aria-labelledby="pacing-heading" className="mt-8">
        <h2 id="pacing-heading" className="mb-2 text-base font-semibold">Pacing</h2>
        <fieldset className="space-y-2 text-sm">
          <legend className="sr-only">How fast tiles are sent</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="pacing" checked={settings?.pacingPreset !== 'normal'} onChange={() => void setPacingPreset('safe')} />
            <span><strong>Safe</strong> &mdash; one tile at a time, 8&ndash;25 seconds apart. Least likely to trigger a provider&rsquo;s checks.</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="pacing" checked={settings?.pacingPreset === 'normal'} onChange={() => void setPacingPreset('normal')} />
            <span><strong>Normal</strong> &mdash; up to two tiles at once, 3&ndash;10 seconds apart. Faster, with a higher chance of being challenged. Applies to the next run.</span>
          </label>
        </fieldset>
      </section>
      <section aria-labelledby="data-heading" className="mt-8">
        <h2 id="data-heading" className="mb-2 text-base font-semibold">Your data</h2>
        <p className="text-sm text-slate-600">
          Jobs, tiles and results are kept in <code className="break-all">{settings?.dataFolder ?? ''}</code> until you delete them; nothing is removed automatically.
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1 text-sm"
            onClick={() => void dataAction(async () => { const r = await ipc.data.openFolder(); return r.ok ? { ok: true, text: 'Opened the data folder.' } : { ok: false, code: r.error.code, text: r.error.message }; })}
          >
            Open data folder
          </button>
          <button
            type="button"
            className="rounded border border-red-300 px-3 py-1 text-sm text-red-800"
            onClick={() => void dataAction(async () => { const r = await ipc.data.clearJobs(); return r.ok ? { ok: true, text: `Removed ${r.value.removed} job${r.value.removed === 1 ? '' : 's'}.` } : { ok: false, code: r.error.code, text: r.error.message }; })}
          >
            Clear job data&hellip;
          </button>
        </div>
        {dataMessage && (
          <p role={dataMessage.kind === 'error' ? 'alert' : 'status'} className={`mt-2 text-sm ${dataMessage.kind === 'error' ? 'text-red-800' : 'text-green-800'}`}>
            {dataMessage.text}
          </p>
        )}
      </section>
      <section aria-labelledby="templates-heading" className="mt-8">
        <h2 id="templates-heading" className="mb-2 text-base font-semibold">Prompt templates</h2>
        <TemplateEditor />
      </section>
      <section aria-labelledby="risk-heading" className="mt-8">
        <h2 id="risk-heading" className="mb-2 text-base font-semibold">Risk notice</h2>
        <button type="button" aria-expanded={showRisk} onClick={() => setShowRisk((v) => !v)} className="rounded border border-slate-300 px-3 py-1 text-sm">
          {showRisk ? 'Hide the notice' : 'Read the notice again'}
        </button>
        {showRisk && <div className="mt-3 space-y-3 text-sm"><RiskNoticeText /></div>}
      </section>
    </>
  );
}
