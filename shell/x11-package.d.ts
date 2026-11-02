// The part of the x11 package (no types of its own) that x11.ts uses
declare module 'x11' {
  namespace x11 {
    interface Client {
      ChangeWindowAttributes(window: number, values: { overrideRedirect?: number }): void;
      InternAtom(onlyIfExists: boolean, name: string, callback: (error: unknown, atom: number) => void): void;
      ChangeProperty(mode: number, window: number, property: number, type: number, format: 8 | 16 | 32, data: string | Buffer | number[]): void;
      sync(): Promise<void>;
      close(callback: () => void): void;
      on(event: 'error', listener: (error: unknown) => void): void;
    }
    interface Display {
      client: Client;
    }
    function createClient(callback: (error: unknown, display: Display) => void): void;
  }
  export default x11;
}
