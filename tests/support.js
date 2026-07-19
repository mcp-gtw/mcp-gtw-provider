export class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    static instances = [];

    static reset() {
        FakeWebSocket.instances = [];
    }

    static get last() {
        return FakeWebSocket.instances.at(-1);
    }

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.listeners = { open: [], error: [], message: [], close: [] };
        this.sent = [];
        this.closes = [];
        FakeWebSocket.instances.push(this);
    }

    addEventListener(type, handler, options) {
        this.listeners[type].push({ handler, once: options?.once ?? false });
    }

    removeEventListener(type, handler) {
        this.listeners[type] = this.listeners[type].filter((entry) => entry.handler !== handler);
    }

    send(data) {
        this.sent.push(JSON.parse(data));
    }

    close(code, reason) {
        this.readyState = FakeWebSocket.CLOSED;
        this.closes.push({ code, reason });
    }

    #emit(type, event) {
        for (const entry of [...this.listeners[type]]) {
            if (entry.once) {
                this.removeEventListener(type, entry.handler);
            }

            entry.handler(event);
        }
    }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.#emit("open", {});
    }

    failToOpen() {
        this.#emit("error", {});
    }

    errorEvent(error = {}) {
        this.#emit("error", error);
    }

    deliver(payload) {
        this.#emit("message", { data: JSON.stringify(payload) });
    }

    deliverRaw(data) {
        this.#emit("message", { data });
    }

    serverClose() {
        this.readyState = FakeWebSocket.CLOSED;
        this.#emit("close", {});
    }
}

export async function connectProvider(provider) {
    const promise = provider.connect();
    FakeWebSocket.last.open();
    await promise;
    return FakeWebSocket.last;
}
