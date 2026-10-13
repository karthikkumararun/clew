import { create } from "zustand";

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

export interface Notice {
  id: number;
  message: string;
  /** Buttons under the message (e.g. Roll back / Show). Choosing one dismisses the notice. */
  actions?: NoticeAction[];
}

let next = 1;

interface NoticesState {
  notices: Notice[];
  push: (message: string, actions?: NoticeAction[]) => number;
  dismiss: (id: number) => void;
}

/** Non-blocking notices (toasts). */
export const useNotices = create<NoticesState>((set) => ({
  notices: [],
  push: (message, actions) => {
    const id = next++;
    set((s) => ({ notices: [...s.notices, { id, message, actions }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}));
