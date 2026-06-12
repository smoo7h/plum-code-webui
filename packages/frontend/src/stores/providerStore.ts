import { create } from 'zustand';
import {
  applyProviderClass,
  getStoredUiProvider,
  setStoredUiProvider,
  type UiProvider,
} from '@/lib/providers';

interface ProviderState {
  uiProvider: UiProvider;
  setProvider: (provider: UiProvider) => void;
}

export const useProviderStore = create<ProviderState>((set) => ({
  uiProvider: getStoredUiProvider(),
  setProvider: (_provider) => {
    // Theme is locked to sevenwave; CLI-provider logic stays independent.
    const provider: UiProvider = 'sevenwave';
    setStoredUiProvider(provider);
    applyProviderClass(provider);
    set({ uiProvider: provider });
  },
}));
