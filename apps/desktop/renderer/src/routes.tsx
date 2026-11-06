import { Home } from './screens/Home';
import { Result } from './screens/Result';
import { Run } from './screens/Run';
import { Settings } from './screens/Settings';
import { Setup } from './screens/Setup';
import type { RouteId } from './store';

export interface RouteDef {
  id: RouteId;
  label: string;
  Screen: () => React.JSX.Element;
}

export const ROUTES: readonly RouteDef[] = [
  { id: 'home', label: 'Home', Screen: Home },
  { id: 'setup', label: 'Setup', Screen: Setup },
  { id: 'run', label: 'Run', Screen: Run },
  { id: 'result', label: 'Result', Screen: Result },
  { id: 'settings', label: 'Settings', Screen: Settings },
];
