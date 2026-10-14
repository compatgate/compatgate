// A local `Intl` is not the global one: no finding.
const Intl = {
  Segmenter: class {},
};

export const segmenter = new Intl.Segmenter();
