const EMPTY_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

export class McpGtwProvider {
    constructor({
        url,
        reconnect = true,
        reconnectMinDelayMs = 500,
        reconnectMaxDelayMs = 10_000,
        heartbeatIntervalMs = 20_000,
        onStatusChange = null,
    }) {
        if (!url) {
            throw new Error("A WebSocket URL is required");
        }

        this.url = url;
        this.reconnect = reconnect;
        this.reconnectMinDelayMs = reconnectMinDelayMs;
        this.reconnectMaxDelayMs = reconnectMaxDelayMs;
        this.heartbeatIntervalMs = heartbeatIntervalMs;
        this.onStatusChange = onStatusChange;

        this.socket = null;
        this.tools = new Map();
        this.resources = new Map();
        this.resourceTemplates = new Map();
        this.prompts = new Map();
        this.onComplete = null;
        this.onSubscribe = null;
        this.onUnsubscribe = null;

        this.runningCalls = new Map();
        this.outgoingCalls = new Map();
        this.outgoingId = 0;
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.connectPromise = null;
    }

    get connected() {
        return this.socket?.readyState === WebSocket.OPEN;
    }

    registerTool(definition, handler) {
        return this.#register(this.tools, "tools", definition, "name", handler, {
            title: definition.title,
            description: definition.description ?? "",
            inputSchema: definition.inputSchema ?? EMPTY_INPUT_SCHEMA,
            ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
            ...(definition.annotations ? { annotations: definition.annotations } : {}),
        });
    }

    registerResource(definition, reader) {
        return this.#register(this.resources, "resources", definition, "uri", reader, {
            name: definition.name,
            ...(definition.title ? { title: definition.title } : {}),
            ...(definition.description ? { description: definition.description } : {}),
            ...(definition.mimeType ? { mimeType: definition.mimeType } : {}),
        });
    }

    registerResourceTemplate(definition) {
        return this.#register(
            this.resourceTemplates,
            "resourceTemplates",
            definition,
            "uriTemplate",
            null,
            {
                name: definition.name,
                ...(definition.title ? { title: definition.title } : {}),
                ...(definition.description ? { description: definition.description } : {}),
                ...(definition.mimeType ? { mimeType: definition.mimeType } : {}),
            },
        );
    }

    registerPrompt(definition, handler) {
        return this.#register(this.prompts, "prompts", definition, "name", handler, {
            ...(definition.title ? { title: definition.title } : {}),
            ...(definition.description ? { description: definition.description } : {}),
            ...(definition.arguments ? { arguments: definition.arguments } : {}),
        });
    }

    #register(registry, kind, definition, key, handler, extra) {
        const identifier = definition[key];

        if (!identifier || typeof identifier !== "string") {
            throw new Error(`A ${kind} entry needs a string ${key}`);
        }

        registry.set(identifier, { definition: { [key]: identifier, ...extra }, handler });
        this.#publish(kind);

        return () => {
            registry.delete(identifier);
            this.#publish(kind);
        };
    }

    async requestSampling(params) {
        return this.#callClient("sampling/createMessage", params);
    }

    async requestElicit(message, requestedSchema) {
        return this.#callClient("elicitation/create", { message, requestedSchema });
    }

    notifyResourceUpdated(uri) {
        this.#notify("notifications/resources/updated", { uri });
    }

    log(level, data, logger) {
        this.#notify("notifications/message", { level, data, logger });
    }

    async connect() {
        if (this.connected) {
            return;
        }

        if (this.connectPromise) {
            return this.connectPromise;
        }

        this.connectPromise = this.#openSocket();

        try {
            await this.connectPromise;
        } finally {
            this.connectPromise = null;
        }
    }

    disconnect() {
        this.#clearReconnectTimer();
        this.#stopHeartbeat();
        this.#abortAllCalls("Provider disconnected");

        if (this.socket) {
            this.socket.close(1000, "Provider disconnected");
            this.socket = null;
        }
    }

    async #openSocket() {
        const socket = new WebSocket(this.url);
        this.socket = socket;

        await new Promise((resolve, reject) => {
            const handleOpen = () => {
                cleanup();
                resolve();
            };

            const handleError = () => {
                cleanup();
                reject(new Error("Could not connect to the MCP gateway"));
            };

            const handleClose = () => {
                cleanup();
                reject(new Error("The MCP gateway connection closed before it opened"));
            };

            const cleanup = () => {
                socket.removeEventListener("open", handleOpen);
                socket.removeEventListener("error", handleError);
                socket.removeEventListener("close", handleClose);
            };

            socket.addEventListener("open", handleOpen, { once: true });
            socket.addEventListener("error", handleError, { once: true });
            socket.addEventListener("close", handleClose, { once: true });
        });

        if (socket !== this.socket) {
            throw new Error("The MCP gateway connection was replaced before it opened");
        }

        this.reconnectAttempt = 0;
        this.#installSocketListeners(socket);
        this.#publishAll();
        this.#startHeartbeat();
        this.#emitStatus("connected");
    }

    #installSocketListeners(socket) {
        socket.addEventListener("message", (event) => {
            void this.#handleMessage(event).catch((error) => {
                console.error("Failed to handle gateway message:", error);
            });
        });

        socket.addEventListener("close", () => {
            if (socket !== this.socket) {
                return;
            }

            this.socket = null;
            this.#stopHeartbeat();
            this.#abortAllCalls("Gateway connection closed");
            this.#emitStatus("disconnected");

            if (this.reconnect) {
                this.#scheduleReconnect();
            }
        });

        socket.addEventListener("error", (error) => {
            console.error("Gateway WebSocket error:", error);
        });
    }

    async #handleMessage(event) {
        const message = JSON.parse(event.data);

        switch (message.type) {
            case "hello.ack":
            case "ack":
            case "pong":
                return;
            case "request":
                void this.#handleRequest(message);
                return;
            case "cancel": {
                const controller = this.runningCalls.get(message.requestId);
                controller?.abort(message.reason ?? "Cancelled by MCP gateway");
                return;
            }
            case "response":
                this.#resolveOutgoing(message);
                return;
            case "protocol.error":
                console.error("MCP gateway protocol error:", message.message);
                return;
            default:
                console.warn("Unknown MCP gateway message:", message);
        }
    }

    async #handleRequest(message) {
        const { requestId, method, params } = message;
        const controller = new AbortController();
        this.runningCalls.set(requestId, controller);

        const context = {
            signal: controller.signal,
            requestId,
            progress: (progress, total, msg) =>
                this.#notify("notifications/progress", {
                    requestId,
                    progress,
                    total,
                    message: msg,
                }),
            requestSampling: (samplingParams) =>
                this.#callClient("sampling/createMessage", samplingParams, requestId),
            requestElicit: (message, requestedSchema) =>
                this.#callClient("elicitation/create", { message, requestedSchema }, requestId),
        };

        try {
            const result = await this.#dispatch(method, params, context);
            this.#send({ type: "result", requestId, result });
        } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);

            try {
                this.#send({ type: "result", requestId, error: messageText });
            } catch {
                // The socket vanished mid-request; the result can no longer be delivered.
            }
        } finally {
            this.runningCalls.delete(requestId);
        }
    }

    async #dispatch(method, params, context) {
        if (method === "tools/call") {
            const entry = this.#require(this.tools, params.name, "tool");

            const value = await entry.handler(params.arguments ?? {}, {
                ...context,
                toolName: params.name,
            });

            return normalizeToolResult(value);
        }

        if (method === "resources/read") {
            const entry = this.#require(this.resources, params.uri, "resource");
            const value = await entry.handler(params.uri, context);
            return normalizeResourceResult(params.uri, value);
        }

        if (method === "prompts/get") {
            const entry = this.#require(this.prompts, params.name, "prompt");
            return entry.handler(params.arguments ?? {}, { ...context, promptName: params.name });
        }

        if (method === "completion/complete") {
            if (!this.onComplete) {
                return { values: [] };
            }

            return normalizeCompletion(
                await this.onComplete(params.ref, params.argument, params.context),
            );
        }

        if (method === "resources/subscribe") {
            await this.onSubscribe?.(params.uri);
            return {};
        }

        if (method === "resources/unsubscribe") {
            await this.onUnsubscribe?.(params.uri);
            return {};
        }

        throw new Error(`Unsupported method: ${method}`);
    }

    #require(registry, identifier, kind) {
        const entry = registry.get(identifier);

        if (!entry) {
            throw new Error(`Unknown ${kind}: ${identifier}`);
        }

        return entry;
    }

    async #callClient(method, params, originatingRequestId = null) {
        this.outgoingId += 1;
        const requestId = `c${this.outgoingId}`;

        const promise = new Promise((resolve, reject) => {
            this.outgoingCalls.set(requestId, { resolve, reject });
        });

        const frame = { type: "call", requestId, method, params };

        if (originatingRequestId !== null) {
            frame.originatingRequestId = originatingRequestId;
        }

        try {
            this.#send(frame);
        } catch (error) {
            this.outgoingCalls.delete(requestId);
            throw error;
        }

        return promise;
    }

    #resolveOutgoing(message) {
        const pending = this.outgoingCalls.get(message.requestId);

        if (!pending) {
            return;
        }

        this.outgoingCalls.delete(message.requestId);

        if (message.error != null) {
            pending.reject(new Error(message.error));
        } else {
            pending.resolve(message.result);
        }
    }

    #publishAll() {
        for (const kind of ["tools", "resources", "resourceTemplates", "prompts"]) {
            if (this[kind].size > 0) {
                this.#publish(kind);
            }
        }
    }

    #publish(kind) {
        if (!this.connected) {
            return;
        }

        const registry = this[kind];
        const items = Array.from(registry.values(), (entry) => entry.definition);
        this.#send({ type: "register", registry: kind, items });
    }

    #notify(method, params) {
        if (this.connected) {
            this.#send({ type: "notify", method, params });
        }
    }

    #send(message) {
        if (!this.connected) {
            throw new Error("MCP gateway WebSocket is not connected");
        }

        this.socket.send(JSON.stringify(message));
    }

    #startHeartbeat() {
        this.#stopHeartbeat();

        this.heartbeatTimer = setInterval(() => {
            if (this.connected) {
                this.#send({ type: "ping" });
            }
        }, this.heartbeatIntervalMs);
    }

    #stopHeartbeat() {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    #scheduleReconnect() {
        this.#clearReconnectTimer();
        const exponentialDelay = this.reconnectMinDelayMs * 2 ** this.reconnectAttempt;
        const delay = Math.min(exponentialDelay, this.reconnectMaxDelayMs);
        const jitteredDelay = Math.round(delay * (0.8 + Math.random() * 0.4));
        this.reconnectAttempt += 1;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;

            void this.connect().catch((error) => {
                console.error("MCP gateway reconnect failed:", error);
                this.#scheduleReconnect();
            });
        }, jitteredDelay);
    }

    #clearReconnectTimer() {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    #abortAllCalls(reason) {
        for (const controller of this.runningCalls.values()) {
            controller.abort(reason);
        }

        this.runningCalls.clear();

        for (const pending of this.outgoingCalls.values()) {
            pending.reject(new Error(reason));
        }

        this.outgoingCalls.clear();
    }

    #emitStatus(status) {
        this.onStatusChange?.(status);
    }
}

function normalizeToolResult(value) {
    if (value && typeof value === "object" && Array.isArray(value.content)) {
        return value;
    }

    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    const result = { content: [{ type: "text", text }], isError: false };

    if (value && typeof value === "object" && !Array.isArray(value)) {
        result.structuredContent = value;
    }

    return result;
}

function normalizeResourceResult(uri, value) {
    if (value && typeof value === "object" && Array.isArray(value.contents)) {
        return value;
    }

    if (Array.isArray(value)) {
        return { contents: value };
    }

    if (typeof value === "string") {
        return { contents: [{ uri, text: value }] };
    }

    return { contents: [{ uri, ...value }] };
}

function normalizeCompletion(value) {
    if (Array.isArray(value)) {
        return { values: value };
    }

    return value;
}
