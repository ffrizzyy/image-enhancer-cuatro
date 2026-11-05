interface RiskNoticeProps {
  onAcknowledge: () => void;
  error?: string | null;
}

/** Blocks the app until acknowledged (first run, or when the notice text version changes). */
export function RiskNotice({ onAcknowledge, error }: RiskNoticeProps) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="mb-4 text-2xl font-semibold">Before you start</h1>
      <div className="space-y-3 text-sm">
        <p>
          Image Enhancer works by using the AI provider websites you log in to yourself (ChatGPT, Gemini, Grok). It
          drives those pages on your behalf, one tile at a time.
        </p>
        <p>
          Automating a provider&rsquo;s website may go against its terms of service, and providers can rate-limit,
          challenge or suspend accounts that they see as automated. You use your own accounts at your own risk.
        </p>
        <p>
          The app never reads, stores or sends your password, and never solves captchas for you. Your images are sent
          only to the provider you choose.
        </p>
      </div>
      {error && (
        <p role="alert" className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onAcknowledge}
        className="mt-6 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white"
      >
        I understand and accept the risk
      </button>
    </main>
  );
}
