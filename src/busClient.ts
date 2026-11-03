import WebSocket from "ws";
import type { ClientFrame, ClientHello, ServerFrame } from "./types.ts";

type Waiter = {
  done: (frame: ServerFrame) => void;
  fail: (err: Error) => void;
};

export class BusClient {
  private socket: WebSocket | null = null;
  private pending: Waiter | null = null;
  private waiters: Waiter[] = [];
  private lastUrl: string | null = null;
  private lastHello: ClientHello | null = null;
  private subscribedTopics = new Set<string>();
  private closed = false;
  private reconnecting: Promise<void> | null = null;
  endpointResolver: (() => Promise<{ url: string; token: string }>) | null = null;
  onMessage: ((frame: Extract<ServerFrame, { type: "message" }>) => void) | null = null;

  async connect(url: string, hello: ClientHello): Promise<Extract<ServerFrame, { type: "welcome" }>> {
    this.closed = false;
    this.lastUrl = url;
    this.lastHello = hello;
    return this.openSocket(url, hello);
  }

  private async openSocket(url: string, hello: ClientHello): Promise<Extract<ServerFrame, { type: "welcome" }>> {
    const socket = new WebSocket(url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.on("message", (data) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data.toString()) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "message") {
        this.onMessage?.(frame);
        return;
      }
      const waiter = this.pending;
      this.pending = this.waiters.shift() ?? null;
      waiter?.done(frame);
    });
    const drop = (reason: string) => {
      if (this.socket === socket) {
        this.socket = null;
      }
      const err = new Error(reason);
      const current = this.pending;
      const queued = this.waiters.splice(0);
      this.pending = null;
      current?.fail(err);
      for (const w of queued) w.fail(err);
    };
    socket.on("close", () => drop("socket closed"));
    socket.on("error", () => drop("socket error"));

    const welcome = await this.rawRequest(socket, hello);
    if (welcome.type !== "welcome") {
      throw new Error(welcome.type === "error" ? welcome.error : "expected welcome");
    }
    if (this.subscribedTopics.size > 0) {
      await this.rawRequest(socket, { type: "subscribe", topics: [...this.subscribedTopics] });
    }
    return welcome;
  }

  private async ensureConnected(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return this.socket;
    }
    if (this.closed || !this.lastHello || !this.lastUrl) {
      throw new Error("not connected");
    }
    if (!this.reconnecting) {
      this.reconnecting = (async () => {
        const target = this.endpointResolver
          ? await this.endpointResolver()
          : { url: this.lastUrl!, token: this.lastHello!.token };
        this.lastUrl = target.url;
        this.lastHello = { ...this.lastHello!, token: target.token };
        await this.openSocket(this.lastUrl, this.lastHello);
      })().finally(() => {
        this.reconnecting = null;
      });
    }
    await this.reconnecting;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    return this.socket;
  }

  send(frame: ClientFrame): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return;
    }
    if (!this.closed && this.lastHello) {
      void this.ensureConnected()
        .then((sock) => sock.send(JSON.stringify(frame)))
        .catch(() => {});
    }
  }

  async request(frame: ClientFrame): Promise<ServerFrame> {
    if (frame.type === "subscribe") {
      for (const t of frame.topics) this.subscribedTopics.add(t);
    } else if (frame.type === "unsubscribe") {
      for (const t of frame.topics) this.subscribedTopics.delete(t);
    }
    const socket = await this.ensureConnected();
    return this.rawRequest(socket, frame);
  }

  private rawRequest(socket: WebSocket, frame: ClientFrame): Promise<ServerFrame> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        done: (response: ServerFrame) => {
          clearTimeout(timer);
          if (response.type === "error") reject(new Error(response.error));
          else resolve(response);
        },
        fail: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        if (this.pending === waiter) {
          this.pending = this.waiters.shift() ?? null;
        } else {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
        }
        reject(new Error("bus timeout"));
      }, 5_000);
      if (this.pending) this.waiters.push(waiter);
      else this.pending = waiter;
      socket.send(JSON.stringify(frame));
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }
}
