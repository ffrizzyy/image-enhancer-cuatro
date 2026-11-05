import { useEffect, useRef } from 'react';

import { Nav } from './components/Nav';
import { RiskNotice } from './components/RiskNotice';
import { ROUTES } from './routes';
import { needsRiskNotice, useShellStore } from './store';

export function App() {
  const route = useShellStore((s) => s.route);
  const settings = useShellStore((s) => s.settings);
  const settingsError = useShellStore((s) => s.settingsError);
  const loadSettings = useShellStore((s) => s.loadSettings);
  const acknowledgeRisk = useShellStore((s) => s.acknowledgeRisk);
  const subscribeStatus = useShellStore((s) => s.subscribeStatus);
  const subscribeJobs = useShellStore((s) => s.subscribeJobs);
  const current = ROUTES.find((r) => r.id === route) ?? ROUTES[0];
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  useEffect(() => {
    void loadSettings();
    // Both live feeds belong to the whole app, not to a screen, so leaving the Run screen loses nothing.
    const offStatus = subscribeStatus();
    const offJobs = subscribeJobs();
    return () => {
      offStatus();
      offJobs();
    };
  }, [loadSettings, subscribeStatus, subscribeJobs]);

  // Move focus to the screen heading on navigation so keyboard/screen-reader users land on new content.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [route]);

  if (!settings) {
    return (
      <p role={settingsError ? 'alert' : 'status'} className="p-6">
        {settingsError ?? 'Loading…'}
      </p>
    );
  }
  if (needsRiskNotice(settings)) return <RiskNotice onAcknowledge={() => void acknowledgeRisk()} error={settingsError} />;
  if (!current) return null;
  const { label, Screen } = current;

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <Nav />
      <main className="p-6">
        <h1 ref={heading} tabIndex={-1} className="mb-4 text-2xl font-semibold">
          {label}
        </h1>
        <Screen />
      </main>
    </div>
  );
}
