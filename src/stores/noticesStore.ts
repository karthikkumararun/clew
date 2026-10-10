import { create } from "zustand";

export interface Notice {
  id: number;
  message: string;
}

let next = 1;

interface NoticesState {
  notices: Notice[];
  push: (message: string) => number;
  dismiss: (id: number) => void;
}

/** Non-blocking notices (toasts). */
export const useNotices = create<NoticesState>((set) => ({
  notices: [],
  push: (message) => {
    const id = next++;
    set((s) => ({ notices: [...s.notices, { id, message }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}));
