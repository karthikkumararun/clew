/** What a collection tab on screen offers the shortcut registry. */
export interface CollectionActions {
  find(): void;
  save(): void;
}

const live = new Map<string, CollectionActions>();

export function setCollectionActions(tabId: string, actions: CollectionActions | null) {
  if (actions) live.set(tabId, actions);
  else live.delete(tabId);
}

export const collectionActions = (tabId: string) => live.get(tabId);
