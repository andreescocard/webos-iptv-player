import { foldSearchText } from '../utils/channel-search';
import { SearchCacheError } from './search-cache-reader';
import { sourceIndexValue, type SourceIndex } from './search-source-index';
import type {
  SearchCachedChannels,
  SearchCachedNames,
  SearchDocumentSamples,
} from './tasks';

// Documents here hold folded values: ranking only ever sees folded text, so a
// sample that folds to the same values ranks the same.
function verifySamples(documents: string[][], samples: SearchDocumentSamples): void {
  for (let i = 0; i < samples.indices.length; i++) {
    const actual = documents[samples.indices[i]];
    const expected = samples.documents[i];
    if (!actual || actual.length !== expected.length) {
      throw new SearchCacheError('sample_mismatch');
    }
    for (let field = 0; field < expected.length; field++) {
      if (actual[field] !== foldSearchText(expected[field])) {
        throw new SearchCacheError('sample_mismatch');
      }
    }
  }
}

function checkLength(index: SourceIndex, length: number): void {
  if (index.length !== length) throw new SearchCacheError('record_changed');
}

export function foldDocuments(documents: string[][]): string[][] {
  return documents.map(fields => fields.map(foldSearchText));
}

// Customization keeps the source values on `sourceName` / `sourceGroup`, so
// the index holds the uncustomized fields whatever was applied when the record
// was written; the main thread sends the customized documents as overrides.
export function cachedChannelDocuments(
  index: SourceIndex,
  request: SearchCachedChannels,
): string[][] {
  checkLength(index, request.length);
  const selection = request.selection;
  const documents: string[][] = new Array(selection.length);
  for (let i = 0; i < selection.length; i++) {
    const item = selection[i];
    if (item >= index.length) throw new SearchCacheError('selection_out_of_range');
    documents[i] = [sourceIndexValue(index, item, 0), sourceIndexValue(index, item, 1), ''];
  }
  if (request.overrideIndices.length !== request.overrides.length) {
    throw new SearchCacheError('override_invalid');
  }
  for (let i = 0; i < request.overrideIndices.length; i++) {
    const item = request.overrideIndices[i];
    if (item >= documents.length) throw new SearchCacheError('override_invalid');
    documents[item] = request.overrides[i].map(foldSearchText);
  }
  verifySamples(documents, request.samples);
  return documents;
}

export function cachedNameDocuments(
  index: SourceIndex,
  request: SearchCachedNames,
): string[] {
  checkLength(index, request.length);
  const selection = request.selection;
  const count = selection ? selection.length : index.length;
  const names: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const item = selection ? selection[i] : i;
    if (item >= index.length) throw new SearchCacheError('selection_out_of_range');
    names[i] = sourceIndexValue(index, item, 0);
  }
  for (let i = 0; i < request.samples.indices.length; i++) {
    const expected = request.samples.documents[i];
    if (expected.length !== 1
        || names[request.samples.indices[i]] !== foldSearchText(expected[0])) {
      throw new SearchCacheError('sample_mismatch');
    }
  }
  return names;
}

