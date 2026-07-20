import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpGtwProvider } from "../src/index.js";
import { connectProvider, FakeWebSocket } from "./support.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sentOf = (socket, type) => socket.sent.filter((message) => message.type === type);
const lastOf = (socket, type) => sentOf(socket, type).at(-1);

async function request(socket, method, params) {
    const requestId = `r-${method}-${socket.sent.length}`;
    socket.deliver({ type: "request", requestId, method, params });
    await flush();
    return socket.sent.find((m) => m.type === "result" && m.requestId === requestId);
}

beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("construction", () => {
    it("requires a url", () => {
        expect(() => new McpGtwProvider({})).toThrow("A WebSocket URL is required");
    });

    it("stores options", () => {
        const onStatusChange = () => {};

        const provider = new McpGtwProvider({
            url: "ws://x",
            reconnect: false,
            reconnectMinDelayMs: 1,
            reconnectMaxDelayMs: 2,
            heartbeatIntervalMs: 3,
            onStatusChange,
        });

        expect(provider.reconnect).toBe(false);
        expect(provider.onStatusChange).toBe(onStatusChange);
        expect(provider.connected).toBe(false);
    });
});

describe("connecting and registration", () => {
    it("publishes only non-empty registries and emits status", async () => {
        const statuses = [];

        const provider = new McpGtwProvider({
            url: "ws://x",
            onStatusChange: (s) => statuses.push(s),
        });

        provider.registerTool({ name: "add" }, () => 1);
        const socket = await connectProvider(provider);

        const register = lastOf(socket, "register");
        expect(register.registry).toBe("tools");
        expect(register.items[0].name).toBe("add");
        expect(sentOf(socket, "register")).toHaveLength(1);
        expect(statuses).toEqual(["connected"]);

        provider.disconnect();
        expect(statuses).toEqual(["connected", "disconnected"]);
    });

    it("registers every capability and republishes on unregister", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const socket = await connectProvider(provider);

        const unregister = provider.registerTool({ name: "t" }, () => "ok");
        provider.registerResource({ uri: "mem://a", name: "a" }, () => "x");
        provider.registerResourceTemplate({ uriTemplate: "mem://{id}", name: "tpl" });
        provider.registerPrompt({ name: "p" }, () => ({ messages: [] }));

        expect(lastOf(socket, "register")).toMatchObject({ registry: "prompts" });
        unregister();
        expect(lastOf(socket, "register")).toMatchObject({ registry: "tools", items: [] });
        provider.disconnect();
    });

    it("a stale unregister does not remove a replacement registration", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const socket = await connectProvider(provider);

        const unregisterFirst = provider.registerTool({ name: "t" }, () => "first");
        provider.registerTool({ name: "t" }, () => "second");
        socket.sent.length = 0;

        unregisterFirst();
        expect(sentOf(socket, "register")).toHaveLength(0);

        const answered = await request(socket, "tools/call", { name: "t" });
        expect(answered.result.content[0].text).toBe("second");
        provider.disconnect();
    });

    it("forwards every optional definition field", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const socket = await connectProvider(provider);

        provider.registerTool(
            {
                name: "full",
                title: "F",
                description: "d",
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
                annotations: { readOnlyHint: true },
            },
            () => "x",
        );

        provider.registerResource(
            { uri: "mem://a", name: "a", title: "A", description: "d", mimeType: "text/plain" },
            () => "x",
        );

        provider.registerResourceTemplate({
            uriTemplate: "mem://{id}",
            name: "tpl",
            title: "T",
            description: "d",
            mimeType: "text/plain",
        });

        provider.registerPrompt(
            { name: "p", title: "P", description: "d", arguments: [{ name: "who" }] },
            () => ({ messages: [] }),
        );

        expect(sentOf(socket, "register").find((f) => f.registry === "resources").items[0]).toEqual(
            {
                uri: "mem://a",
                name: "a",
                title: "A",
                description: "d",
                mimeType: "text/plain",
            },
        );

        expect(
            sentOf(socket, "register").find((f) => f.registry === "resourceTemplates").items[0],
        ).toMatchObject({ uriTemplate: "mem://{id}", title: "T", mimeType: "text/plain" });

        expect(sentOf(socket, "register").find((f) => f.registry === "prompts").items[0]).toEqual({
            name: "p",
            title: "P",
            description: "d",
            arguments: [{ name: "who" }],
        });

        provider.disconnect();
    });

    it("rejects a registration without a string key", () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        expect(() => provider.registerResource({ name: "no uri" }, () => {})).toThrow("string uri");
    });

    it("does not publish while disconnected", () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        provider.registerTool({ name: "t" }, () => {});
        expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it("is idempotent and returns the in-flight promise", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const first = provider.connect();
        const second = provider.connect();
        FakeWebSocket.last.open();
        await Promise.all([first, second]);
        await provider.connect();
        expect(FakeWebSocket.instances).toHaveLength(1);
        provider.disconnect();
    });

    it("rejects when the socket errors before opening", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const promise = provider.connect();
        FakeWebSocket.last.failToOpen();
        await expect(promise).rejects.toThrow("Could not connect");
    });

    it("rejects when the socket closes before opening", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const promise = provider.connect();
        FakeWebSocket.last.serverClose();
        await expect(promise).rejects.toThrow("closed before it opened");
    });

    it("aborts opening when the socket was replaced before it opened", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const promise = provider.connect();
        const first = FakeWebSocket.last;
        provider.socket = new FakeWebSocket();
        first.open();
        await expect(promise).rejects.toThrow("replaced before it opened");
    });
});

describe("tools", () => {
    it("wraps results and passes context", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        let received;

        provider.registerTool({ name: "echo" }, async (args, ctx) => {
            received = { args, ctx };
            return `hi ${args.n}`;
        });

        const socket = await connectProvider(provider);

        const reply = await request(socket, "tools/call", { name: "echo", arguments: { n: 1 } });
        expect(reply.result).toEqual({ content: [{ type: "text", text: "hi 1" }], isError: false });
        expect(received.ctx.toolName).toBe("echo");
        expect(received.ctx.signal).toBeInstanceOf(AbortSignal);
        provider.disconnect();
    });

    it("handles object, array, null and full results", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        provider.registerTool({ name: "obj" }, () => ({ a: 1 }));
        provider.registerTool({ name: "arr" }, () => [1, 2]);
        provider.registerTool({ name: "nil" }, () => null);
        provider.registerTool({ name: "raw" }, () => ({ content: [{ type: "text", text: "r" }] }));
        const socket = await connectProvider(provider);

        const obj = await request(socket, "tools/call", { name: "obj" });
        expect(obj.result.structuredContent).toEqual({ a: 1 });
        const arr = await request(socket, "tools/call", { name: "arr" });
        expect(arr.result.content[0].text).toBe("[1,2]");
        const nil = await request(socket, "tools/call", { name: "nil" });
        expect(nil.result.content[0].text).toBe("null");
        const raw = await request(socket, "tools/call", { name: "raw" });
        expect(raw.result).toEqual({ content: [{ type: "text", text: "r" }] });
        provider.disconnect();
    });

    it("reports unknown tools and handler failures", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });

        provider.registerTool({ name: "boom" }, () => {
            throw new Error("kaboom");
        });

        provider.registerTool({ name: "weird" }, () => {
            throw "nope";
        });

        const socket = await connectProvider(provider);

        expect((await request(socket, "tools/call", { name: "ghost" })).error).toContain(
            "Unknown tool",
        );

        expect((await request(socket, "tools/call", { name: "boom" })).error).toBe("kaboom");
        expect((await request(socket, "tools/call", { name: "weird" })).error).toBe("nope");
        provider.disconnect();
    });

    it("emits progress from the handler context", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });

        provider.registerTool({ name: "slow" }, async (_args, ctx) => {
            ctx.progress(0.5, 1, "half");
            return "done";
        });

        const socket = await connectProvider(provider);
        await request(socket, "tools/call", { name: "slow", arguments: {} });

        const progress = lastOf(socket, "notify");
        expect(progress.method).toBe("notifications/progress");
        expect(progress.params).toMatchObject({ progress: 0.5, total: 1, message: "half" });
        provider.disconnect();
    });

    it("aborts a running call on cancel", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const aborted = {};

        provider.registerTool(
            { name: "long" },
            (args, ctx) =>
                new Promise((resolve) => {
                    ctx.signal.addEventListener("abort", () => {
                        aborted[args.id] = ctx.signal.reason;
                        resolve("cancelled");
                    });
                }),
        );

        const socket = await connectProvider(provider);

        for (const id of ["r", "d"]) {
            socket.deliver({
                type: "request",
                requestId: id,
                method: "tools/call",
                params: { name: "long", arguments: { id } },
            });
        }

        await flush();
        socket.deliver({ type: "cancel", requestId: "r", reason: "stop" });
        socket.deliver({ type: "cancel", requestId: "d" });
        socket.deliver({ type: "cancel", requestId: "missing" });
        await flush();
        expect(aborted).toEqual({ r: "stop", d: "Cancelled by MCP gateway" });
        provider.disconnect();
    });
});

describe("resources", () => {
    it("normalizes contents, array, string and object readers", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });

        provider.registerResource({ uri: "mem://full", name: "f" }, () => ({
            contents: [{ uri: "mem://full", text: "F" }],
        }));

        provider.registerResource({ uri: "mem://arr", name: "a" }, () => [
            { uri: "mem://arr", text: "A" },
        ]);

        provider.registerResource({ uri: "mem://str", name: "s" }, () => "S");
        provider.registerResource({ uri: "mem://obj", name: "o" }, () => ({ text: "O" }));
        const socket = await connectProvider(provider);

        expect(
            (await request(socket, "resources/read", { uri: "mem://full" })).result.contents[0]
                .text,
        ).toBe("F");

        expect(
            (await request(socket, "resources/read", { uri: "mem://arr" })).result.contents[0].text,
        ).toBe("A");

        expect(
            (await request(socket, "resources/read", { uri: "mem://str" })).result.contents[0].text,
        ).toBe("S");

        expect(
            (await request(socket, "resources/read", { uri: "mem://obj" })).result.contents[0],
        ).toEqual({ uri: "mem://obj", text: "O" });

        expect((await request(socket, "resources/read", { uri: "mem://none" })).error).toContain(
            "Unknown resource",
        );

        provider.disconnect();
    });

    it("runs subscribe and unsubscribe handlers, with and without them", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const seen = [];
        provider.onSubscribe = (uri) => seen.push(["sub", uri]);
        provider.onUnsubscribe = (uri) => seen.push(["unsub", uri]);
        const socket = await connectProvider(provider);

        expect((await request(socket, "resources/subscribe", { uri: "mem://a" })).result).toEqual(
            {},
        );

        expect((await request(socket, "resources/unsubscribe", { uri: "mem://a" })).result).toEqual(
            {},
        );

        expect(seen).toEqual([
            ["sub", "mem://a"],
            ["unsub", "mem://a"],
        ]);

        provider.onSubscribe = null;
        provider.onUnsubscribe = null;

        expect((await request(socket, "resources/subscribe", { uri: "mem://b" })).result).toEqual(
            {},
        );

        expect((await request(socket, "resources/unsubscribe", { uri: "mem://b" })).result).toEqual(
            {},
        );

        provider.disconnect();
    });

    it("emits a resource-updated notification", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const socket = await connectProvider(provider);
        provider.notifyResourceUpdated("mem://a");

        expect(lastOf(socket, "notify")).toEqual({
            type: "notify",
            method: "notifications/resources/updated",
            params: { uri: "mem://a" },
        });

        provider.disconnect();
    });
});

describe("prompts, completion and logging", () => {
    it("gets a prompt", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });

        provider.registerPrompt({ name: "greet" }, (args) => ({
            messages: [{ role: "user", content: { type: "text", text: `hi ${args.who}` } }],
        }));

        const socket = await connectProvider(provider);

        const reply = await request(socket, "prompts/get", {
            name: "greet",
            arguments: { who: "x" },
        });

        expect(reply.result.messages[0].content.text).toBe("hi x");
        const noArgs = await request(socket, "prompts/get", { name: "greet" });
        expect(noArgs.result.messages[0].content.text).toBe("hi undefined");

        expect((await request(socket, "prompts/get", { name: "ghost" })).error).toContain(
            "Unknown prompt",
        );

        provider.disconnect();
    });

    it("completes with a handler, an array, and defaults to empty", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const socket = await connectProvider(provider);
        expect((await request(socket, "completion/complete", {})).result).toEqual({ values: [] });

        provider.onComplete = () => ({ values: ["a"], total: 1 });

        const answered = await request(socket, "completion/complete", {
            ref: 1,
            argument: 2,
            context: 3,
        });

        expect(answered.result).toEqual({ values: ["a"], total: 1 });

        provider.onComplete = () => ["b", "c"];

        expect((await request(socket, "completion/complete", {})).result).toEqual({
            values: ["b", "c"],
        });

        provider.onComplete = () => undefined;
        expect((await request(socket, "completion/complete", {})).result).toEqual({ values: [] });

        provider.disconnect();
    });

    it("logs and rejects an unsupported method", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const socket = await connectProvider(provider);
        provider.log("info", "hello", "app");

        expect(lastOf(socket, "notify")).toEqual({
            type: "notify",
            method: "notifications/message",
            params: { level: "info", data: "hello", logger: "app" },
        });

        expect((await request(socket, "resources/list", {})).error).toContain("Unsupported method");
        provider.disconnect();
    });
});

describe("sampling and elicitation", () => {
    it("resolves sampling and elicitation responses", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const socket = await connectProvider(provider);

        const sampling = provider.requestSampling({ messages: [], maxTokens: 10 });
        const call = lastOf(socket, "call");
        expect(call.method).toBe("sampling/createMessage");
        socket.deliver({ type: "response", requestId: call.requestId, result: { model: "m" } });
        expect(await sampling).toEqual({ model: "m" });

        const elicit = provider.requestElicit("Name?", { type: "object" });
        const elicitCall = lastOf(socket, "call");

        socket.deliver({
            type: "response",
            requestId: elicitCall.requestId,
            result: { action: "accept" },
        });

        expect(await elicit).toEqual({ action: "accept" });
        provider.disconnect();
    });

    it("rejects an error response and ignores unknown ids", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const socket = await connectProvider(provider);
        const sampling = provider.requestSampling({ messages: [], maxTokens: 10 });
        const call = lastOf(socket, "call");
        socket.deliver({ type: "response", requestId: "other", result: {} });
        socket.deliver({ type: "response", requestId: call.requestId, error: "refused" });
        await expect(sampling).rejects.toThrow("refused");
        provider.disconnect();
    });

    it("rejects and leaves no pending entry when called while disconnected", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });

        await expect(provider.requestSampling({ messages: [], maxTokens: 1 })).rejects.toThrow(
            "not connected",
        );

        expect(provider.outgoingCalls.size).toBe(0);
    });

    it("tags a handler's reverse calls with the originating requestId", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });

        provider.registerTool({ name: "ask" }, async (_args, ctx) => {
            const sampled = await ctx.requestSampling({ messages: [], maxTokens: 1 });
            const elicited = await ctx.requestElicit("Name?", { type: "object" });
            return `${sampled.model}:${elicited.action}`;
        });

        const socket = await connectProvider(provider);

        socket.deliver({
            type: "request",
            requestId: "req-1",
            method: "tools/call",
            params: { name: "ask" },
        });

        await flush();
        const sampleCall = lastOf(socket, "call");
        expect(sampleCall.method).toBe("sampling/createMessage");
        expect(sampleCall.originatingRequestId).toBe("req-1");

        socket.deliver({
            type: "response",
            requestId: sampleCall.requestId,
            result: { model: "m" },
        });

        await flush();

        const elicitCall = lastOf(socket, "call");
        expect(elicitCall.method).toBe("elicitation/create");
        expect(elicitCall.originatingRequestId).toBe("req-1");

        socket.deliver({
            type: "response",
            requestId: elicitCall.requestId,
            result: { action: "accept" },
        });

        await flush();

        const result = socket.sent.find((m) => m.type === "result" && m.requestId === "req-1");
        expect(result.result.content[0].text).toBe("m:accept");
        provider.disconnect();
    });
});

describe("inbound protocol messages", () => {
    it("ignores acks and pongs, logs errors and warns", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const socket = await connectProvider(provider);
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        socket.sent.length = 0;

        socket.deliver({ type: "hello.ack" });
        socket.deliver({ type: "ack", registry: "tools", count: 0 });
        socket.deliver({ type: "pong" });
        socket.deliver({ type: "protocol.error", message: "bad" });
        socket.deliver({ type: "mystery" });
        await flush();

        expect(socket.sent).toEqual([]);
        expect(error).toHaveBeenCalledWith("MCP gateway protocol error:", "bad");
        expect(warn).toHaveBeenCalled();
        provider.disconnect();
    });

    it("logs a malformed message and a socket error", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const socket = await connectProvider(provider);
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        socket.deliverRaw("not json");
        await flush();
        socket.errorEvent(new Error("boom"));
        expect(error).toHaveBeenCalledWith("Failed to handle gateway message:", expect.any(Error));
        expect(error).toHaveBeenCalledWith("Gateway WebSocket error:", expect.any(Error));
        provider.disconnect();
    });
});

describe("heartbeat, reconnect and disconnect", () => {
    it("pings while connected and skips when not open", async () => {
        vi.useFakeTimers();
        const provider = new McpGtwProvider({ url: "ws://x", heartbeatIntervalMs: 1000 });
        const promise = provider.connect();
        FakeWebSocket.last.open();
        await promise;
        const socket = FakeWebSocket.last;
        socket.sent.length = 0;
        vi.advanceTimersByTime(1000);
        expect(sentOf(socket, "ping")).toHaveLength(1);
        socket.readyState = FakeWebSocket.CLOSED;
        vi.advanceTimersByTime(1000);
        expect(sentOf(socket, "ping")).toHaveLength(1);
    });

    it("closes a half-open socket when a pong is missing", async () => {
        vi.useFakeTimers();
        const provider = new McpGtwProvider({
            url: "ws://x",
            heartbeatIntervalMs: 1000,
            reconnect: false,
        });
        const promise = provider.connect();
        FakeWebSocket.last.open();
        await promise;
        const socket = FakeWebSocket.last;

        vi.advanceTimersByTime(1000);
        expect(sentOf(socket, "ping")).toHaveLength(1);

        vi.advanceTimersByTime(1000);
        expect(socket.closes).toContainEqual({ code: 4000, reason: "Heartbeat timed out" });
    });

    it("keeps the heartbeat alive while pongs arrive", async () => {
        vi.useFakeTimers();
        const provider = new McpGtwProvider({ url: "ws://x", heartbeatIntervalMs: 1000 });
        const promise = provider.connect();
        FakeWebSocket.last.open();
        await promise;
        const socket = FakeWebSocket.last;

        vi.advanceTimersByTime(1000);
        socket.deliver({ type: "pong" });
        vi.advanceTimersByTime(1000);

        expect(sentOf(socket, "ping")).toHaveLength(2);
        expect(socket.closes).toHaveLength(0);
        provider.disconnect();
    });

    it("does not reconnect when disabled", async () => {
        vi.useFakeTimers();
        const provider = new McpGtwProvider({ url: "ws://x", reconnect: false });
        const promise = provider.connect();
        FakeWebSocket.last.open();
        await promise;
        FakeWebSocket.last.serverClose();
        vi.advanceTimersByTime(60_000);
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("backs off, retries after failure, then reconnects", async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        const provider = new McpGtwProvider({
            url: "ws://x",
            reconnectMinDelayMs: 100,
            reconnectMaxDelayMs: 150,
        });

        const promise = provider.connect();
        FakeWebSocket.last.open();
        await promise;

        FakeWebSocket.last.serverClose();
        FakeWebSocket.last.serverClose();
        await vi.advanceTimersByTimeAsync(100);
        FakeWebSocket.last.failToOpen();
        await vi.advanceTimersByTimeAsync(0);
        expect(error).toHaveBeenCalledWith("MCP gateway reconnect failed:", expect.any(Error));
        await vi.advanceTimersByTimeAsync(150);
        FakeWebSocket.last.open();
        await vi.advanceTimersByTimeAsync(0);
        expect(provider.connected).toBe(true);
        provider.disconnect();
    });

    it("clears a scheduled reconnect on disconnect", async () => {
        vi.useFakeTimers();
        const provider = new McpGtwProvider({ url: "ws://x", reconnectMinDelayMs: 100 });
        const promise = provider.connect();
        FakeWebSocket.last.open();
        await promise;
        FakeWebSocket.last.serverClose();
        provider.disconnect();
        vi.advanceTimersByTime(60_000);
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("does not resurrect when disconnected during an in-flight reconnect", async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        vi.spyOn(console, "error").mockImplementation(() => {});

        const statuses = [];
        const provider = new McpGtwProvider({
            url: "ws://x",
            reconnectMinDelayMs: 100,
            onStatusChange: (s) => statuses.push(s),
        });
        const promise = provider.connect();
        FakeWebSocket.last.open();
        await promise;

        FakeWebSocket.last.serverClose();
        await vi.advanceTimersByTimeAsync(100);
        const reconnecting = FakeWebSocket.last;
        expect(reconnecting.readyState).toBe(FakeWebSocket.CONNECTING);

        provider.disconnect();
        reconnecting.serverClose();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(provider.connected).toBe(false);
        expect(statuses).toEqual(["connected", "disconnected"]);
    });

    it("aborts running and outgoing calls on disconnect", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });

        provider.registerTool(
            { name: "long" },
            (_args, ctx) =>
                new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve("x"))),
        );

        const socket = await connectProvider(provider);

        socket.deliver({
            type: "request",
            requestId: "r",
            method: "tools/call",
            params: { name: "long" },
        });

        await flush();
        const sampling = provider.requestSampling({ messages: [], maxTokens: 1 });

        provider.disconnect();
        await expect(sampling).rejects.toThrow("Provider disconnected");
        expect(socket.closes).toEqual([{ code: 1000, reason: "Provider disconnected" }]);
        expect(() => provider.disconnect()).not.toThrow();
    });

    it("throws when sending on a closed socket", async () => {
        const provider = new McpGtwProvider({ url: "ws://x" });
        const socket = await connectProvider(provider);
        provider.registerTool({ name: "t" }, () => "ok");
        socket.sent.length = 0;
        const connected = vi.spyOn(McpGtwProvider.prototype, "connected", "get");
        connected.mockReturnValueOnce(false).mockReturnValue(true);
        const reply = await request(socket, "tools/call", { name: "t" });
        expect(reply.error).toBe("MCP gateway WebSocket is not connected");
    });
});
