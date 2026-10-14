// References to types are no use of a feature.
type Clone = typeof structuredClone;

export interface Shared {
  share: Navigator['share'];
  segmenter: Intl.Segmenter;
}

let observer: ResizeObserver | undefined;

export function setObserver(next: ResizeObserver, clone: Clone): Clone {
  observer = next;
  return clone;
}

export const current = (): ResizeObserver | undefined => observer;

// A use after the types: the bundlers strip them, and the message still names the line of the source.
export const copyShared = (shared: Shared): Shared => structuredClone(shared);
