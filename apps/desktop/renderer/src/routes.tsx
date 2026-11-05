import { Home } from './screens/Home';
import { Run } from './screens/Run';
import { Settings } from './screens/Settings';
import { Setup } from './screens/Setup';
import type { RouteId } from './store';

const stub = (text: string) =>
  function Stub() {
    return <p>{text}</p>;
  };

export interface RouteDef {
  id: RouteId;
  label: string;
  Screen: () => React.JSX.Element;
}

export const ROUTES: readonly RouteDef[] = [
  { id: 'home', label: 'Home', Screen: Home },
  { id: 'setup', label: 'Setup', Screen: Setup },
  { id: 'run', label: 'Run', Screen: Run },
  { id: 'result', label: 'Result', Screen: stub('Before/after comparison and export.') },
  { id: 'settings', label: 'Settings', Screen: Settings },
];
