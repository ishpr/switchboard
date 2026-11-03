import WebSocket from "ws";
import type { ClientFrame, ClientHello, ServerFrame } from "./types.ts";

export class BusClient {
  private socket: WebSocket | null = null;
  private pending: ((frame: ServerFrame) => void) | null = null;
  private waiters: Array<(frame: ServerFrame) => void> = [];
  onMessage: ((frame: Extract<ServerFrame, { type: "message" }>) => void) | null = null;

  async connect(url: string, hello: ClientHello): Promise<Extract<ServerFrame, { type: "welcome" }>> {
    const socket = new WebSocket(url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      if (frame.type === "message") {
        this.onMessage?.(frame);
        return;
      }
      const waiter = this.pending;
      this.pending = this.waiters.shift() ?? null;
      waiter?.(frame);
    });
    const welcome = await this.request(hello);
    if (welcome.type !== "welcome") {
      throw new Error(welcome.type === "error" ? welcome.error : "expected welcome");
    }
    return welcome;
  }

  send(frame: ClientFrame): void {
    this.socket?.send(JSON.stringify(frame));
  }

  request(frame: ClientFrame): Promise<ServerFrame> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("not connected"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("bus timeout")), 5_000);
      const done = (response: ServerFrame) => {
        clearTimeout(timer);
        if (response.type === "error") reject(new Error(response.error));
        else resolve(response);
      };
      if (this.pending) this.waiters.push(done);
      else this.pending = done;
      socket.send(JSON.stringify(frame));
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
