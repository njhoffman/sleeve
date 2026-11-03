import { expect } from 'chai';
import { throttledFetch, wait } from '../../src/core/throttle.ts';

describe('throttledFetch', () => {
  // A clock that only moves when the test moves it; sleeping records the wait
  const setup = (gapMs = 300) => {
    let clock = 1000;
    const slept: number[] = [];
    const sent: Array<{ url: string; at: number }> = [];
    const base = (async (input: string | URL | Request) => {
      sent.push({ url: String(input), at: clock });
      return new Response('');
    }) as typeof globalThis.fetch;
    const fetch = throttledFetch(base, {
      gapMs, now: () => clock,
      sleep: async (ms, signal) => {
        slept.push(ms);
        if (signal?.aborted) throw signal.reason;
      }
    });
    return { fetch, slept, sent, advance: (ms: number) => { clock += ms; } };
  };

  it('spaces requests to one host by the gap, and lets other hosts go at once', async () => {
    const { fetch, slept, sent } = setup();
    await Promise.all([
      fetch('https://lrclib.net/api/get?a'),
      fetch('https://lrclib.net/api/get?b'),
      fetch('https://music.163.com/api/search'),
      fetch('https://lrclib.net/api/search?c')
    ]);
    const at = (pattern: RegExp) => sent.filter(item => pattern.test(item.url)).map(item => item.at);
    expect(at(/lrclib/)).to.have.length(3);
    expect(at(/163/)).to.have.length(1);
    // The second and third lrclib requests, the 163 one waits for nothing
    expect(slept).to.deep.equal([300, 600]);
  });

  it('does not wait once the gap has passed, and never makes up for idle time', async () => {
    const { fetch, slept, advance } = setup();
    await fetch('https://lrclib.net/a');
    advance(5000);
    await fetch('https://lrclib.net/b');
    await fetch('https://lrclib.net/c');
    expect(slept).to.deep.equal([300]);
  });

  it('does not send a request whose signal ended', async () => {
    const { fetch, slept, sent } = setup();
    const signal = AbortSignal.abort(new Error('stop'));
    let error: Error | null = null;
    await fetch('https://lrclib.net/a', { signal }).catch(caught => { error = caught; });
    expect(error!.message).to.equal('stop');
    await fetch('https://lrclib.net/b');
    await fetch('https://lrclib.net/c', { signal }).catch(caught => { error = caught; });
    expect(sent.map(item => item.url)).to.deep.equal(['https://lrclib.net/b']);
  });

  it('waits for real, and stops waiting when the signal ends', async () => {
    const started = performance.now();
    await wait(20);
    expect(performance.now() - started).to.be.at.least(15);
    const controller = new AbortController();
    const waiting = wait(10_000, controller.signal);
    controller.abort(new Error('gone'));
    let error: Error | null = null;
    await waiting.catch(caught => { error = caught; });
    expect(error!.message).to.equal('gone');
  });
});
