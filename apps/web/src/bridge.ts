export type ClientPlatform = 'mobile-max' | 'mobile-web' | 'desktop-web';

interface MaxWebApp {
  initData?: string;
  platform?: 'ios' | 'android' | 'desktop' | 'web';
  version?: string;
  downloadFile?: (url: string, name: string) => void | Promise<void>;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
}

declare global {
  interface Window {
    WebApp?: MaxWebApp;
  }
}

function browserDownload(url: string, name: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.click();
}

export function createBridge() {
  const webApp = window.WebApp;
  const platform = webApp?.platform;
  const clientPlatform: ClientPlatform =
    platform === 'ios' || platform === 'android'
      ? 'mobile-max'
      : platform === 'desktop'
        ? 'desktop-web'
        : window.innerWidth < 700
          ? 'mobile-web'
          : 'desktop-web';
  return {
    clientPlatform,
    version: webApp?.version ?? 'browser',
    initData: webApp?.initData ?? '',
    isMax: Boolean(webApp),
    download(url: string, name: string) {
      if (typeof webApp?.downloadFile === 'function') return webApp.downloadFile(url, name);
      browserDownload(url, name);
      return undefined;
    },
    setUnsaved(enabled: boolean) {
      if (enabled) webApp?.enableClosingConfirmation?.();
      else webApp?.disableClosingConfirmation?.();
    },
  };
}
