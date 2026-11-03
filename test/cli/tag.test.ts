import { expect } from 'chai';
import { forBatch } from '../../src/cli/tag.ts';
import { DEFAULT_PROVIDERS } from '../../src/core/fetchLyrics.ts';
import type { ProviderContext } from '../../src/core/providers/provider.ts';
import { musicMetadataReader } from '../../src/core/tags/musicMetadata.ts';
import { fakeFetch, fixture } from '../helpers/fetch.ts';

describe('sleeve tag providers', () => {
  it('asks LRCLIB once when it is overloaded, leaving the retry to a later run, and keeps the other providers', async () => {
    const providers = forBatch(DEFAULT_PROVIDERS);
    expect(providers.map(provider => provider.name)).to.deep.equal(DEFAULT_PROVIDERS.map(provider => provider.name));
    expect(providers.filter(provider => provider.name !== 'lrclib')).to.deep.equal(DEFAULT_PROVIDERS.filter(provider => provider.name !== 'lrclib'));

    const fake = fakeFetch([{ match: /\/api\/get\?/, status: 503, body: fixture('lrclib/overloaded.json') }]);
    const context: ProviderContext = { fetch: fake.fetch, signal: AbortSignal.timeout(5000), userAgent: 'test', tags: musicMetadataReader };
    const lrclib = providers.find(provider => provider.name === 'lrclib')!;
    let error: Error | null = null;
    await lrclib.search({ artist: 'Artist', title: 'Song', durationMs: 200_000 }, context).catch(caught => { error = caught; });
    expect(error!.message).to.include('503');
    expect(fake.calls).to.have.length(1);
  });
});
