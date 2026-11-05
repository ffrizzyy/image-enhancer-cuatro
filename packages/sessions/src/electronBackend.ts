import { app, BrowserWindow, session, WebContentsView } from 'electron';

import type { ProviderView, SessionBackend } from './types';

/** Real backend: each provider view is a WebContentsView on its own persistent partition. */
export function createElectronBackend(): SessionBackend {
  return {
    createView(partition, { visible }): ProviderView {
      const win = new BrowserWindow({ show: visible, width: 1000, height: 800 });
      const view = new WebContentsView({
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.contentView.addChildView(view);

      const fit = () => {
        const { width, height } = win.getContentBounds();
        view.setBounds({ x: 0, y: 0, width, height });
      };
      fit();
      win.on('resize', fit);

      // Closing the window by hand only hides it, so the logged-in view survives until clear().
      // On app quit it must be allowed to close, or the quit would be cancelled.
      let closing = false;
      app.once('before-quit', () => {
        closing = true;
      });
      win.on('close', (event) => {
        if (closing) return;
        event.preventDefault();
        win.hide();
      });

      return {
        partition,
        setVisible: (v) => (v ? win.show() : win.hide()),
        isVisible: () => win.isVisible(),
        loadURL: (url) => view.webContents.loadURL(url),
        evaluate: <T>(script: string) => view.webContents.executeJavaScript(script) as Promise<T>,
        close: () => {
          closing = true;
          win.destroy();
        },
      };
    },

    async clearPartition(partition) {
      const target = session.fromPartition(partition);
      await target.clearStorageData();
      await target.clearCache();
    },
  };
}
