import { useEffect } from 'react';

import { DropZone } from '../components/DropZone';
import { RecentJobs } from '../components/RecentJobs';
import { useShellStore } from '../store';

export function Home() {
  const ping = useShellStore((s) => s.ping);
  const loadPing = useShellStore((s) => s.loadPing);
  const importFile = useShellStore((s) => s.importFile);
  const importing = useShellStore((s) => s.importing);
  const importError = useShellStore((s) => s.importError);
  const recentJobs = useShellStore((s) => s.recentJobs);
  const loadRecentJobs = useShellStore((s) => s.loadRecentJobs);
  const openJob = useShellStore((s) => s.openJob);
  const resumeJob = useShellStore((s) => s.resumeJob);

  useEffect(() => {
    void loadPing();
    void loadRecentJobs();
  }, [loadPing, loadRecentJobs]);

  return (
    <>
      <DropZone onFile={(file) => void importFile(file)} disabled={importing} />
      {importing && (
        <p role="status" className="mt-4 text-sm">
          Checking image…
        </p>
      )}
      {importError && (
        <p role="alert" className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {importError.message}
        </p>
      )}
      <RecentJobs jobs={recentJobs} onOpen={(id) => void openJob(id)} onResume={(id) => void resumeJob(id)} />
      <p role="status" className="mt-8 text-sm text-slate-600">
        {ping.status === 'ok' && `Main process ready: app ${ping.version}, IPC v${ping.ipcVersion}`}
        {ping.status === 'error' && `Main process error: ${ping.message}`}
        {(ping.status === 'idle' || ping.status === 'loading') && 'Pinging main process…'}
      </p>
    </>
  );
}
