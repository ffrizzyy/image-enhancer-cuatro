import { ProviderStatus } from '../components/ProviderStatus';
import { PROVIDERS, useShellStore } from '../store';

export function Settings() {
  const providers = useShellStore((s) => s.providers);
  const providerError = useShellStore((s) => s.providerError);
  const openProvider = useShellStore((s) => s.openProvider);
  const clearProvider = useShellStore((s) => s.clearProvider);

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
    </>
  );
}
