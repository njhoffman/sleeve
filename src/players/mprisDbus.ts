import { sessionBus, Variant, type ClientInterface, type MessageBus } from '@jellybrick/dbus-next';
import type { MprisBus, MprisProxy, Properties } from './mpris.ts';

// MprisBus on the real session bus. The only file that imports the D-Bus library.

const PLAYER = 'org.mpris.MediaPlayer2.Player';
const PATH = '/org/mpris/MediaPlayer2';

// Variants unwrapped all the way down, 64-bit integers (bigint) as numbers
export function unwrap(value: unknown): unknown {
  if (value instanceof Variant) return unwrap(value.value);
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrap(item)]));
  }
  return value;
}

// The library types proxy interfaces loosely: methods and signals are found at run time
type Dynamic = ClientInterface & Record<string, (...args: unknown[]) => Promise<unknown>> & {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeAllListeners(): void;
};

export function dbusMprisBus(bus: MessageBus = sessionBus()): MprisBus {
  // Swallowed here: a bus that cannot connect fails each call instead
  (bus as unknown as NodeJS.EventEmitter).on('error', () => {});
  const daemon = bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
    .then(object => object.getInterface('org.freedesktop.DBus') as unknown as Dynamic);
  daemon.catch(() => {});

  return {
    async watchName(name, listener) {
      const dbus = await daemon;
      dbus.on('NameOwnerChanged', (changed, _old, owner) => {
        if (changed === name) listener(Boolean(owner));
      });
      return Boolean(await dbus.NameHasOwner(name));
    },

    async open(name): Promise<MprisProxy> {
      const object = await bus.getProxyObject(name, PATH);
      const properties = object.getInterface('org.freedesktop.DBus.Properties') as unknown as Dynamic;
      const player = object.getInterface(PLAYER) as unknown as Dynamic;
      return {
        properties: async () => unwrap(await properties.GetAll(PLAYER)) as Properties,
        position: async () => Number(unwrap(await properties.Get(PLAYER, 'Position'))),
        setPosition: async (trackId, positionUs) => { await player.SetPosition(trackId, BigInt(positionUs)); },
        onChanged(listener) {
          properties.on('PropertiesChanged', (iface, changed) => {
            if (iface === PLAYER) listener(unwrap(changed) as Properties);
          });
        },
        onSeeked(listener) {
          player.on('Seeked', position => listener(Number(position)));
        },
        close() {
          properties.removeAllListeners();
          player.removeAllListeners();
        }
      };
    },

    close() {
      bus.disconnect();
    }
  };
}
