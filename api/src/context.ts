/** Per-process context. Pure: no filesystem, no network at construction time. */
import { buildIndex, buildBehindTheNumbers, buildFact, buildFactTimeline, factVideos } from "./derive.ts";
import { selectEntry } from "./anatomy.ts";
import type { Context } from "./resolvers.ts";
import type { Dataset, FactDef } from "./sources.ts";

export function createContext(dataset: Dataset, embeddings: Context["embeddings"]): Context {
  const index = buildIndex(dataset);
  const factsByVideo = new Map<string, FactDef[]>();
  for (const fact of dataset.facts) {
    for (const video of factVideos(index, fact)) {
      const list = factsByVideo.get(video.id) ?? [];
      list.push(fact);
      factsByVideo.set(video.id, list);
    }
  }
  // Pay the derivation cost once per process instead of once per request.
  for (const fact of dataset.facts) {
    buildFact(index, fact);
    buildFactTimeline(index, fact, 3);
  }
  buildBehindTheNumbers(index, { limit: 6 });
  selectEntry(index, 6);

  return { dataset, index, embeddings, factsByVideo };
}
