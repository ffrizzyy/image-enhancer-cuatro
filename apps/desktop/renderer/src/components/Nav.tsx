import { ROUTES } from '../routes';
import { useShellStore } from '../store';

export function Nav() {
  const route = useShellStore((s) => s.route);
  const navigate = useShellStore((s) => s.navigate);

  return (
    <nav aria-label="Main" className="flex gap-2 border-b border-slate-200 p-3">
      {ROUTES.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          aria-current={route === id ? 'page' : undefined}
          onClick={() => navigate(id)}
          className="rounded px-3 py-1.5 text-sm font-medium hover:bg-slate-100 aria-[current=page]:bg-slate-900 aria-[current=page]:text-white"
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
