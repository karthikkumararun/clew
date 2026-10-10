import { useNotices } from "../../stores/noticesStore";

/** Small facade so console code can say something without importing the store everywhere. */
export const useNoticesStore = {
  push: (message: string) => useNotices.getState().push(message),
};
