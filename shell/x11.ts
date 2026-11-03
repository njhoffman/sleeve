import x11 from 'x11';

// The X requests Electron has no API for, made over connections of our own (the pure-JS x11 package, as backdrop
// uses): making the window unmanaged, marking it for backdrop, telling whether a compositor runs, and stacking the
// overlay when backdrop does not.
//
// Override-redirect keeps i3 from managing the window at all, as GLava's and xwinwrap's windows are: no tiling,
// no frame, on every workspace, and left where it is stacked. It only counts if set before the window first maps,
// so this runs while the window is still hidden.

const STRING = 31;
const PROP_MODE_REPLACE = 0;
const STACK_ABOVE = 0;
const STACK_BELOW = 1;
const SUBSTRUCTURE_NOTIFY = 0x00080000;
export const OVERLAY_PROPERTY = '_BACKDROP_OVERLAY';

type Position = 'below' | 'above';

function call<T>(client: x11.Client, request: 'InternAtom' | 'GetSelectionOwner', ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    (client[request] as (...rest: unknown[]) => void)(...args, (error: unknown, result: T) => (error ? reject(error) : resolve(result)));
  });
}

function connect(): Promise<x11.Display> {
  return new Promise<x11.Display>((resolve, reject) => {
    x11.createClient((error, result) => (error ? reject(error) : resolve(result)));
  });
}

const close = (client: x11.Client) => new Promise<void>(resolve => client.close(() => resolve()));

// Runs fn over a connection of its own, failing on any X error its requests caused
async function withClient<T>(fn: (client: x11.Client, root: number) => Promise<T>): Promise<T> {
  const display = await connect();
  const client = display.client;
  const errors: unknown[] = [];
  client.on('error', error => errors.push(error));
  try {
    const result = await fn(client, display.screen[0].root);
    // Requests without replies report errors as events; sync() is the barrier after which any have arrived
    await client.sync();
    if (errors.length) throw new Error(`X request failed: ${String((errors[0] as Error)?.message ?? errors[0])}`);
    return result;
  } finally {
    await close(client);
  }
}

// Unmanaged, and marked for backdrop when it stacks the window (mark: where); unmarked when sleeve stacks it,
// so a backdrop started later leaves it alone
export async function markOverlay(window: number, mark: Position | null): Promise<void> {
  await withClient(async client => {
    client.ChangeWindowAttributes(window, { overrideRedirect: 1 });
    if (!mark) return;
    const atom = await call<number>(client, 'InternAtom', false, OVERLAY_PROPERTY);
    client.ChangeProperty(PROP_MODE_REPLACE, window, atom, STRING, 8, mark);
  });
}

// Whether a compositor runs on the screen: one owns the _NET_WM_CM_S0 selection (EWMH). Without one, a
// transparent window shows black.
export async function compositorRunning(): Promise<boolean> {
  return withClient(async client => {
    const atom = await call<number>(client, 'InternAtom', false, '_NET_WM_CM_S0');
    return (await call<number>(client, 'GetSelectionOwner', atom)) !== 0;
  });
}

export interface SelfStacking {
  // Puts the window where it belongs again (after the compositor and Chromium settle)
  restack(): void;
  close(): Promise<void>;
}

// Stacks the mapped overlay without backdrop. below: at the bottom, just above the root (and its wallpaper);
// windows mapped later go on top of it, so it stays there. above: over every window, raised again whenever a
// managed window maps or is restacked over it. Override-redirect windows (menus, notifications, launchers) are
// left over it.
export async function stackSelf(window: number, position: Position, log: (text: string) => void): Promise<SelfStacking> {
  const display = await connect();
  const client = display.client;
  client.on('error', error => log(`X error while stacking: ${String((error as Error)?.message ?? error)}`));
  const restack = () => client.ConfigureWindow(window, { stackMode: position === 'above' ? STACK_ABOVE : STACK_BELOW });
  restack();
  if (position === 'above') {
    let timer: NodeJS.Timeout | null = null;
    client.ChangeWindowAttributes(display.screen[0].root, { eventMask: SUBSTRUCTURE_NOTIFY });
    client.on('event', event => {
      if (event.name !== 'MapNotify' && event.name !== 'ConfigureNotify') return;
      // MapNotify names the window in wid, ConfigureNotify in wid1 (its wid is the root the event came through)
      const other = event.name === 'MapNotify' ? event.wid : event.wid1;
      if (other === window || event.overrideRedirect) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(restack, 50);
    });
  }
  return { restack, close: () => close(client) };
}
