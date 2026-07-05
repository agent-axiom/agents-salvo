export class RemoteClient {
  constructor({ workerUrl, authToken = "", onMessage, onStatus, onError }) {
    this.workerUrl = (workerUrl || "").replace(/\/$/, "");
    if (!this.workerUrl) {
      throw new Error("Online service is not configured");
    }
    this.authToken = authToken;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onError = onError;
    this.socket = null;
    this.session = null;
    this.ready = null;
  }

  async createRoom() {
    const response = await fetch(`${this.workerUrl}/rooms`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    this.session = await readJson(response);
    await this.connect();
    return this.session;
  }

  async joinRoom(roomCode) {
    const response = await fetch(`${this.workerUrl}/rooms/${encodeURIComponent(roomCode)}/join`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    this.session = await readJson(response);
    await this.connect();
    return this.session;
  }

  connect() {
    if (!this.session) {
      throw new Error("No remote session");
    }

    this.close();
    const url = new URL(`${this.workerUrl}/rooms/${this.session.roomCode}/socket`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("playerId", this.session.playerId);
    url.searchParams.set("token", this.session.playerToken);

    this.socket = new WebSocket(url);
    this.onStatus?.("connecting");
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener(
        "open",
        () => {
          this.onStatus?.("connected");
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        () => {
          reject(new Error("WebSocket connection failed"));
        },
        { once: true },
      );
      this.socket.addEventListener(
        "close",
        () => {
          if (this.socket?.readyState !== WebSocket.OPEN) {
            reject(new Error("WebSocket connection closed"));
          }
        },
        { once: true },
      );
    });
    this.socket.addEventListener("message", (event) => {
      this.onMessage?.(JSON.parse(event.data));
    });
    this.socket.addEventListener("close", () => this.onStatus?.("disconnected"));
    this.socket.addEventListener("error", () => {
      this.onError?.(new Error("WebSocket connection failed"));
    });
    return this.ready;
  }

  async send(type, payload = {}) {
    await this.ready;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Socket is not connected");
    }
    this.socket.send(JSON.stringify({ type, ...payload }));
  }

  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  authHeaders() {
    return this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {};
  }
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}
