export {
  BAG_FEATURE_MODEL,
  BAG_FEATURE_DIM,
  bagFeatures,
  extractBagFeature,
  type BagFeatureExtractor,
  type BagFeatureOptions
} from './features.js';

export { cosineSimilarity, rankBySimilarity, type RankedCandidate, type VectorLike } from './similarity.js';
export * from './scan.js';
