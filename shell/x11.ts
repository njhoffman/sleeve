import x11 from 'x11';

// The two X requests Electron has no API for, made over a connection of our own (the pure-JS x11 package, as
// backdrop uses): making the window unmanaged and marking it for backdrop.
//
// Override-redirect keeps i3 from managing the window at all, as GLava's and xwinwrap's windows are: no tiling,
// no frame, on every workspace, and left where backdrop stacks it. It only counts if set before the window first
// maps, so this runs while the window is still hidden.

const STRING = 31;
const PROP_MODE_REPLACE = 0;
export const OVERLAY_PROPERTY = '_BACKDROP_OVERLAY';

function call<T>(client: x11.Client, request: 'InternAtom', ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    (client[request] as (...rest: unknown[]) => void)(...args, (error: unknown, result: T) => (error ? reject(error) : resolve(result)));
  });
}

export async function markOverlay(window: number, position: 'below' | 'above'): Promise<void> {
  const display = await new Promise<x11.Display>((resolve, reject) => {
    x11.createClient((error, result) => (error ? reject(error) : resolve(result)));
  });
  const client = display.client;
  const errors: unknown[] = [];
  client.on('error', error => errors.push(error));
  try {
    client.ChangeWindowAttributes(window, { overrideRedirect: 1 });
    const atom = await call<number>(client, 'InternAtom', false, OVERLAY_PROPERTY);
    client.ChangeProperty(PROP_MODE_REPLACE, window, atom, STRING, 8, position);
    // Requests without replies report errors as events; sync() is the barrier after which any have arrived
    await client.sync();
    if (errors.length) throw new Error(`X request failed: ${String((errors[0] as Error)?.message ?? errors[0])}`);
  } finally {
    await new Promise<void>(resolve => client.close(() => resolve()));
  }
}
