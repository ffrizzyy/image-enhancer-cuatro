import { useEffect, useId, useState } from 'react';

import { ipc } from '../ipc';
import { useShellStore } from '../store';

/** Edit a category's prompt template and default prompt. Changes are saved as overrides; "Reset" restores the shipped text. */
export function TemplateEditor() {
  const categories = useShellStore((s) => s.categories);
  const loadCategories = useShellStore((s) => s.loadCategories);
  const editable = categories.filter((c) => c.kind === 'prompt');

  const [categoryId, setCategoryId] = useState('');
  const [template, setTemplate] = useState('');
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [customized, setCustomized] = useState<string[]>([]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const ids = { select: useId(), template: useId(), prompt: useId() };

  useEffect(() => {
    if (categories.length === 0) void loadCategories();
  }, [categories.length, loadCategories]);

  useEffect(() => {
    void ipc.presets.overrides().then((r) => r.ok && setCustomized(r.value));
  }, []);

  const category = editable.find((c) => c.id === categoryId);
  useEffect(() => {
    setTemplate(category?.template ?? '');
    setDefaultPrompt(category?.defaultPrompt ?? '');
    setMessage(null);
    // Reload the fields only when a different category is chosen.
  }, [categoryId]);

  async function refresh(): Promise<void> {
    await loadCategories();
    const r = await ipc.presets.overrides();
    if (r.ok) setCustomized(r.value);
  }

  async function save(): Promise<void> {
    setPending(true);
    setMessage(null);
    try {
      const result = await ipc.presets.saveOverride({ categoryId, template, defaultPrompt });
      if (result.ok) {
        setMessage({ kind: 'ok', text: 'Saved. It applies to the next job you start.' });
        await refresh();
      } else {
        setMessage({ kind: 'error', text: result.error.message });
      }
    } catch (error) {
      setMessage({ kind: 'error', text: `Could not save: ${String(error)}` });
    } finally {
      setPending(false);
    }
  }

  async function reset(): Promise<void> {
    setPending(true);
    setMessage(null);
    try {
      const result = await ipc.presets.resetOverride(categoryId);
      if (result.ok) {
        setTemplate(result.value.template ?? '');
        setDefaultPrompt(result.value.defaultPrompt ?? '');
        setMessage({ kind: 'ok', text: 'Reset to the built-in template.' });
        await refresh();
      } else {
        setMessage({ kind: 'error', text: result.error.message });
      }
    } catch (error) {
      setMessage({ kind: 'error', text: `Could not reset: ${String(error)}` });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <div>
        <label htmlFor={ids.select} className="mb-1 block font-medium">Category</label>
        <select id={ids.select} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full rounded border border-slate-300 p-2">
          <option value="">Choose a category&hellip;</option>
          {editable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {customized.includes(c.id) ? ' (customized)' : ''}
            </option>
          ))}
        </select>
      </div>
      {category && (
        <>
          <div>
            <label htmlFor={ids.prompt} className="mb-1 block font-medium">Default prompt</label>
            <textarea id={ids.prompt} value={defaultPrompt} onChange={(e) => setDefaultPrompt(e.target.value)} rows={3} maxLength={2000} className="w-full rounded border border-slate-300 p-2" />
          </div>
          <div>
            <label htmlFor={ids.template} className="mb-1 block font-medium">Template</label>
            <p className="mb-1 text-xs text-slate-600">
              Must contain <code>{'{{userPrompt}}'}</code> and <code>{'{{fidelityClause}}'}</code>; <code>{'{{tileRole}}'}</code> is optional.
            </p>
            <textarea id={ids.template} value={template} onChange={(e) => setTemplate(e.target.value)} rows={10} maxLength={8000} className="w-full rounded border border-slate-300 p-2 font-mono text-xs" />
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={() => void save()} className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50">
              Save changes
            </button>
            <button type="button" disabled={pending || !customized.includes(categoryId)} onClick={() => void reset()} className="rounded border border-slate-300 px-3 py-1 disabled:opacity-50">
              Reset to default
            </button>
          </div>
        </>
      )}
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'text-red-800' : 'text-green-800'}>
          {message.text}
        </p>
      )}
    </div>
  );
}
