import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { BUILD } from "./build.ts";
import type { ClientFrame, ClientHello, ServerFrame } from "./types.ts";

type Waiter = { socket: WebSocket; done: (frame: ServerFrame) => void; fail: (err: Error) => void };

export class BusClient {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Waiter>();
  private legacyOnly = false;
  private legacyTail: Promise<unknown> = Promise.resolve();
  private requestTimeoutMs: number;
  private lastUrl: string | null = null;
  private lastHello: ClientHello | null = null;
  private subscribedTopics = new Set<string>();
  private closed = false;
  private reconnecting: Promise<void> | null = null;
  endpointResolver: (() => Promise<{ url: string; token: string }>) | null = null;
  onMessage: ((frame: Extract<ServerFrame, { type: "message" }>) => void) | null = null;

  constructor(options: { requestTimeoutMs?: number } = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
  }

  async connect(url: string, hello: ClientHello): Promise<Extract<ServerFrame, { type: "welcome" }>> {
    this.closed = false;
    this.lastUrl = url;
    this.lastHello = { ...hello, build: hello.build ?? BUILD };
    return this.openSocket(url, this.lastHello);
  }

  private async openSocket(url: string, hello: ClientHello): Promise<Extract<ServerFrame, { type: "welcome" }>> {
    const socket = new WebSocket(url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    let handshake = true;
    socket.on("message", (data) => {
      let frame: ServerFrame;
      try { frame = JSON.parse(data.toString()) as ServerFrame; } catch { return; }
      if (!frame || typeof frame !== "object") return;
      if (frame.type === "message") { this.onMessage?.(frame); return; }
      let id = frame.reqId;
      // Only the handshake and a serialized legacy connection may consume an untagged response.
      if (!id && (handshake || this.legacyOnly)) {
        const waiting = [...this.pending.entries()].filter(([, waiter]) => waiter.socket === socket);
        if (waiting.length === 1) id = waiting[0]![0];
      }
      const waiter = id ? this.pending.get(id) : undefined;
      if (waiter?.socket !== socket) return; // late, unknown, or previous-socket response
      if (frame.type === "welcome") { this.legacyOnly = !frame.reqId; handshake = false; }
      this.pending.delete(id!);
      const { reqId: _reqId, ...response } = frame;
      waiter.done(response as ServerFrame);
    });
    const drop = (reason: string) => {
      if (this.socket === socket) this.socket = null;
      for (const [id, waiter] of this.pending) {
        if (waiter.socket !== socket) continue;
        this.pending.delete(id);
        waiter.fail(new Error(reason));
      }
    };
    socket.on("close", () => drop("socket closed"));
    socket.on("error", () => drop("socket error"));
    const welcome = await this.rawRequest(socket, hello);
    if (welcome.type !== "welcome") throw new Error("expected welcome");
    if (this.subscribedTopics.size) await this.rawRequest(socket, { type: "subscribe", topics: [...this.subscribedTopics] });
    return welcome;
  }

  private async ensureConnected(): Promise<WebSocket> {
    if (this.reconnecting) await this.reconnecting;
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.closed || !this.lastHello || !this.lastUrl) throw new Error("not connected");
    if (!this.reconnecting) {
      this.reconnecting = (async () => {
        const target = this.endpointResolver ? await this.endpointResolver() : { url: this.lastUrl!, token: this.lastHello!.token };
        if (this.closed) throw new Error("client closed");
        this.lastUrl = target.url;
        this.lastHello = { ...this.lastHello!, token: target.token };
        await this.openSocket(this.lastUrl, this.lastHello);
      })().finally(() => { this.reconnecting = null; });
    }
    await this.reconnecting;
    const reconnected = this.socket as WebSocket | null;
    if (reconnected?.readyState !== WebSocket.OPEN) throw new Error("not connected");
    return reconnected;
  }

  send(frame: ClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify(frame)); return; }
    if (!this.closed && this.lastHello) void this.ensureConnected().then((socket) => socket.send(JSON.stringify(frame))).catch(() => {});
  }

  async request(frame: ClientFrame): Promise<ServerFrame> {
    if (frame.type === "subscribe") for (const topic of frame.topics) this.subscribedTopics.add(topic);
    if (frame.type === "unsubscribe") for (const topic of frame.topics) this.subscribedTopics.delete(topic);
    const socket = await this.ensureConnected();
    if (!this.legacyOnly) return this.rawRequest(socket, frame);
    const operation = this.legacyTail.then(async () => this.rawRequest(await this.ensureConnected(), frame));
    this.legacyTail = operation.catch(() => {});
    return operation;
  }

  private rawRequest(socket: WebSocket, frame: ClientFrame): Promise<ServerFrame> {
    const reqId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (response?: ServerFrame, error?: Error) => {
        clearTimeout(timer);
        this.pending.delete(reqId);
        if (error) reject(error);
        else if (response?.type === "error") reject(new Error(response.error));
        else resolve(response!);
      };
      const timer = setTimeout(() => {
        finish(undefined, new Error("bus timeout"));
        // Untagged late responses cannot safely share a legacy connection with another request.
        if (this.legacyOnly) socket.terminate();
      }, this.requestTimeoutMs);
      this.pending.set(reqId, { socket, done: (response) => finish(response), fail: (error) => finish(undefined, error) });
      try { socket.send(JSON.stringify({ ...frame, reqId })); } catch (error) { finish(undefined, error as Error); }
    });
  }

  close(): void {
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    for (const [id, waiter] of this.pending) { this.pending.delete(id); waiter.fail(new Error("client closed")); }
  }
}
