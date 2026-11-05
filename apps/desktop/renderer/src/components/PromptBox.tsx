import { MAX_PROMPT } from '../draft';

interface PromptBoxProps {
  value: string;
  error: string | null;
  showReset: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
}

export function PromptBox({ value, error, showReset, onChange, onReset }: PromptBoxProps) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label htmlFor="prompt" className="text-lg font-medium">
          Prompt
        </label>
        {showReset && (
          <button type="button" onClick={onReset} className="text-sm underline">
            Reset to category default
          </button>
        )}
      </div>
      <textarea
        id="prompt"
        rows={4}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error !== null}
        aria-describedby={error ? 'prompt-error prompt-hint' : 'prompt-hint'}
        className="w-full rounded border border-slate-300 p-2 text-sm"
      />
      <p id="prompt-hint" className="text-xs text-slate-600">
        {value.length}/{MAX_PROMPT} characters. Leave it empty to use the category default.
      </p>
      {error && (
        <p id="prompt-error" role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
