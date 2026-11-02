import type { MpdAddress } from './mpd.ts';
import type { MusicmanPaths } from './musicman.ts';

// Where MPD is and where its files live, from (first wins) sleeve's options, MPD's own MPD_HOST and MPD_PORT,
// musicman's paths.json, and MPD's defaults

export interface MpdSettings extends MpdAddress {
  musicDirectory?: string;
}

export interface SettingsInput {
  // "host", "host:port", "password@host:port", or a socket path
  mpd?: string;
  musicDirectory?: string;
  env?: NodeJS.ProcessEnv;
  musicman?: MusicmanPaths | null;
}

// MPD_HOST's forms: host, password@host, /socket, @abstract-socket
function parseHost(text: string): Pick<MpdAddress, 'host' | 'password' | 'socket'> & { port?: number } {
  const at = text.lastIndexOf('@');
  const password = at > 0 ? text.slice(0, at) : undefined;
  let host = at > 0 ? text.slice(at + 1) : text;
  if (host.startsWith('/') || host.startsWith('@')) return { host: 'localhost', socket: host, ...(password ? { password } : {}) };
  let port: number | undefined;
  const colon = /^(.*):(\d+)$/.exec(host);
  if (colon) {
    host = colon[1];
    port = Number(colon[2]);
  }
  return { host: host || 'localhost', ...(port ? { port } : {}), ...(password ? { password } : {}) };
}

export function mpdSettings({ mpd, musicDirectory, env = process.env, musicman }: SettingsInput = {}): MpdSettings {
  const given = mpd ?? env.MPD_HOST;
  const parsed = given ? parseHost(given) : { host: musicman?.mpd.host ?? 'localhost' };
  const port = parsed.port ?? (env.MPD_PORT ? Number(env.MPD_PORT) : undefined) ?? musicman?.mpd.port ?? 6600;
  const directory = musicDirectory ?? musicman?.mpd.baseDirectory;
  return { ...parsed, port, ...(directory ? { musicDirectory: directory } : {}) };
}
