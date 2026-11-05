// The part of the x11 package (no types of its own) that x11.ts uses
declare module 'x11' {
  namespace x11 {
    interface Event {
      name: string;
      wid?: number;
      wid1?: number;
      overrideRedirect?: boolean | number;
    }
    interface Client {
      ChangeWindowAttributes(window: number, values: { overrideRedirect?: number; eventMask?: number }): void;
      ConfigureWindow(window: number, values: { width?: number; height?: number; stackMode?: number; sibling?: number }): void;
      InternAtom(onlyIfExists: boolean, name: string, callback: (error: unknown, atom: number) => void): void;
      GetSelectionOwner(selection: number, callback: (error: unknown, owner: number) => void): void;
      ChangeProperty(mode: number, window: number, property: number, type: number, format: 8 | 16 | 32, data: string | Buffer | number[]): void;
      sync(): Promise<void>;
      close(callback: () => void): void;
      on(event: 'error', listener: (error: unknown) => void): void;
      on(event: 'event', listener: (event: Event) => void): void;
    }
    interface Display {
      client: Client;
      screen: Array<{ root: number }>;
    }
    function createClient(callback: (error: unknown, display: Display) => void): void;
  }
  export default x11;
}
