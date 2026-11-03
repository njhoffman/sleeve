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

  describe('a service\'s own rate limit', () => {
    // Real time, short gaps: a request is answered when the test says so
    const serial = (gapMs: number, limitMs: number) => {
      const answers: Array<() => void> = [];
      const sent: Array<{ url: string; at: number }> = [];
      const started = performance.now();
      const base = (input: string | URL | Request) => new Promise<Response>(resolve => {
        sent.push({ url: String(input), at: performance.now() - started });
        answers.push(() => resolve(new Response('')));
      });
      const fetch = throttledFetch(base as typeof globalThis.fetch, { gapMs, limits: [{ host: 'lrclib.net', gapMs: limitMs, serial: true }] });
      return { fetch, sent, answer: () => answers.shift()!() };
    };
    const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

    it('sends one request at a time, the next only once the last is answered and its gap has passed', async () => {
      const { fetch, sent, answer } = serial(0, 40);
      const requests = [fetch('https://lrclib.net/a'), fetch('https://lrclib.net/b'), fetch('https://music.163.com/c')];
      await tick(60);
      // b waits for a's answer, however long; the other host goes at once
      expect(sent.map(item => item.url)).to.have.members(['https://lrclib.net/a', 'https://music.163.com/c']);
      answer();
      answer();
      await tick(5);
      expect(sent.map(item => item.url)).to.have.length(3);
      expect(sent[2].url).to.equal('https://lrclib.net/b');
      answer();
      await Promise.all(requests);
    });

    it('keeps its gap even when answers are quick, and raises a smaller gap but never lowers a larger one', async () => {
      const quick = serial(10, 40);
      const done = Promise.all([quick.fetch('https://lrclib.net/a'), quick.fetch('https://lrclib.net/b')]);
      while (quick.sent.length < 1) await tick(2);
      quick.answer();
      while (quick.sent.length < 2) await tick(2);
      quick.answer();
      await done;
      expect(quick.sent[1].at - quick.sent[0].at).to.be.at.least(35);

      const slow = serial(80, 40);
      const both = Promise.all([slow.fetch('https://lrclib.net/a'), slow.fetch('https://lrclib.net/b')]);
      while (slow.sent.length < 1) await tick(2);
      slow.answer();
      while (slow.sent.length < 2) await tick(2);
      slow.answer();
      await both;
      expect(slow.sent[1].at - slow.sent[0].at).to.be.at.least(75);
    });

    it('lets a request that gives up while queued go without holding the rest up', async () => {
      const { fetch, sent, answer } = serial(0, 0);
      const first = fetch('https://lrclib.net/a');
      const controller = new AbortController();
      const gaveUp = fetch('https://lrclib.net/b', { signal: controller.signal }).catch((error: Error) => error.message);
      const third = fetch('https://lrclib.net/c');
      controller.abort(new Error('timed out'));
      expect(await gaveUp).to.equal('timed out');
      await tick(10);
      // c still waits for a, which is not answered yet
      expect(sent.map(item => item.url)).to.deep.equal(['https://lrclib.net/a']);
      answer();
      while (sent.length < 2) await tick(2);
      expect(sent.map(item => item.url)).to.deep.equal(['https://lrclib.net/a', 'https://lrclib.net/c']);
      answer();
      await Promise.all([first, third]);
    });
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
