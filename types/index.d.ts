export type ProviderStatus = "connected" | "disconnected";

export interface McpGtwProviderOptions {
    /** WebSocket URL of the gateway's private `/provider` endpoint, including the `token`. */
    url: string;
    /** Reconnect automatically after an unexpected close. Defaults to `true`. */
    reconnect?: boolean;
    /** Minimum backoff before the first reconnect attempt, in milliseconds. Defaults to `500`. */
    reconnectMinDelayMs?: number;
    /** Maximum backoff between reconnect attempts, in milliseconds. Defaults to `10000`. */
    reconnectMaxDelayMs?: number;
    /** Interval between `ping` heartbeats while connected, in milliseconds. Defaults to `20000`. */
    heartbeatIntervalMs?: number;
    /** Called on every connection state transition. */
    onStatusChange?: ((status: ProviderStatus) => void) | null;
}

/** A JSON Schema object describing a tool's input or output. */
export type JsonSchema = Record<string, unknown>;

/** Removes a previously registered entry and republishes its list. */
export type Unregister = () => void;

/** Reports incremental progress for the running request. */
export type ProgressReporter = (progress: number, total?: number, message?: string) => void;

export interface RequestContext {
    /** Aborts when the gateway cancels the request or the connection drops. */
    signal: AbortSignal;
    /** Correlation id of this request. */
    requestId: string;
    /** Emits a `notifications/progress` frame for this request. */
    progress: ProgressReporter;
    /** Asks the initiating client's LLM to sample a completion, routed back to that client. */
    requestSampling(params: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Asks the initiating client's user for structured input, routed back to that client. */
    requestElicit(message: string, requestedSchema: JsonSchema): Promise<Record<string, unknown>>;
}

export interface ToolDefinition {
    /** Unique tool name advertised to MCP clients. */
    name: string;
    /** Optional human-readable title. */
    title?: string;
    /** Human-readable description. Defaults to an empty string. */
    description?: string;
    /** JSON Schema for the arguments. Defaults to an empty object schema. */
    inputSchema?: JsonSchema;
    /** Optional JSON Schema for the structured result. */
    outputSchema?: JsonSchema;
    /** Optional MCP tool annotations. */
    annotations?: Record<string, unknown>;
}

export interface ToolHandlerContext extends RequestContext {
    /** Name of the tool being invoked. */
    toolName: string;
}

/** A single MCP content block returned to the client. */
export interface ToolResultContent {
    type: string;
    [key: string]: unknown;
}

/** A fully formed MCP tool result. Return this to control the content blocks exactly. */
export interface ToolResult {
    content: ToolResultContent[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
}

/**
 * A tool handler. Return a {@link ToolResult} to control the payload exactly, or return any
 * JSON-serializable value and it is wrapped into a text (and structured, for objects) result.
 */
export type ToolHandler = (
    args: Record<string, unknown>,
    context: ToolHandlerContext,
) => ToolResult | unknown | Promise<ToolResult | unknown>;

export interface ResourceDefinition {
    /** Concrete resource URI advertised to MCP clients. */
    uri: string;
    /** Human-readable name. */
    name: string;
    /** Optional human-readable title. */
    title?: string;
    /** Optional description. */
    description?: string;
    /** Optional MIME type of the resource contents. */
    mimeType?: string;
}

/** A single MCP resource contents block. */
export interface ResourceContents {
    uri?: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    [key: string]: unknown;
}

/** A fully formed MCP resource read result. */
export interface ResourceReadResult {
    contents: ResourceContents[];
}

/**
 * A resource reader. Return a full {@link ResourceReadResult}, an array of contents, a string
 * (wrapped as text), or a single contents object; all are normalized for the client.
 */
export type ResourceReader = (
    uri: string,
    context: RequestContext,
) =>
    | ResourceReadResult
    | ResourceContents[]
    | ResourceContents
    | string
    | Promise<ResourceReadResult | ResourceContents[] | ResourceContents | string>;

export interface ResourceTemplateDefinition {
    /** RFC 6570 URI template advertised to MCP clients. */
    uriTemplate: string;
    /** Human-readable name. */
    name: string;
    /** Optional human-readable title. */
    title?: string;
    /** Optional description. */
    description?: string;
    /** Optional MIME type of the resources the template produces. */
    mimeType?: string;
}

export interface PromptArgument {
    name: string;
    description?: string;
    required?: boolean;
    [key: string]: unknown;
}

export interface PromptDefinition {
    /** Unique prompt name advertised to MCP clients. */
    name: string;
    /** Optional human-readable title. */
    title?: string;
    /** Optional description. */
    description?: string;
    /** Optional declared arguments. */
    arguments?: PromptArgument[];
}

export interface PromptHandlerContext extends RequestContext {
    /** Name of the prompt being requested. */
    promptName: string;
}

/** A fully formed MCP `prompts/get` result. */
export interface PromptResult {
    description?: string;
    messages: Array<Record<string, unknown>>;
}

export type PromptHandler = (
    args: Record<string, unknown>,
    context: PromptHandlerContext,
) => PromptResult | Promise<PromptResult>;

/** A fully formed MCP completion result. */
export interface CompletionResult {
    values: string[];
    total?: number;
    hasMore?: boolean;
}

/**
 * Completion handler. Return a {@link CompletionResult} or a bare array of strings (wrapped as
 * `{ values }`). Assign it to `onComplete`; when unset, completion returns no candidates.
 */
export type CompletionHandler = (
    ref: Record<string, unknown>,
    argument: Record<string, unknown>,
    context: Record<string, unknown> | undefined,
) => CompletionResult | string[] | Promise<CompletionResult | string[]>;

/** Called when the client subscribes to (or unsubscribes from) a resource URI. */
export type SubscriptionHandler = (uri: string) => void | Promise<void>;

/** MCP logging levels, from least to most severe. */
export type LogLevel =
    | "debug"
    | "info"
    | "notice"
    | "warning"
    | "error"
    | "critical"
    | "alert"
    | "emergency";

/**
 * Connects a web application to an MCP gateway over the private WebSocket, publishes its MCP
 * capabilities, and runs their handlers. Framework agnostic: no React, Vue or DOM framework is
 * required.
 */
export class McpGtwProvider {
    constructor(options: McpGtwProviderOptions);

    readonly url: string;
    reconnect: boolean;
    reconnectMinDelayMs: number;
    reconnectMaxDelayMs: number;
    heartbeatIntervalMs: number;
    onStatusChange: ((status: ProviderStatus) => void) | null;

    /** Handles `completion/complete`. When `null`, completion returns no candidates. */
    onComplete: CompletionHandler | null;
    /** Called on `resources/subscribe`. Optional. */
    onSubscribe: SubscriptionHandler | null;
    /** Called on `resources/unsubscribe`. Optional. */
    onUnsubscribe: SubscriptionHandler | null;

    /** Whether the underlying socket is currently open. */
    get connected(): boolean;

    /** Registers (or replaces) a tool and republishes the list if connected. Returns an unregister fn. */
    registerTool(definition: ToolDefinition, handler: ToolHandler): Unregister;

    /** Registers (or replaces) a concrete resource and its reader. Returns an unregister fn. */
    registerResource(definition: ResourceDefinition, reader: ResourceReader): Unregister;

    /** Registers (or replaces) a resource template (listing only). Returns an unregister fn. */
    registerResourceTemplate(definition: ResourceTemplateDefinition): Unregister;

    /** Registers (or replaces) a prompt and its handler. Returns an unregister fn. */
    registerPrompt(definition: PromptDefinition, handler: PromptHandler): Unregister;

    /**
     * Out-of-band sampling (`sampling/createMessage`), routed to the most recently active client.
     * Inside a handler, prefer `context.requestSampling` so the call reaches the initiating client.
     */
    requestSampling(params: Record<string, unknown>): Promise<Record<string, unknown>>;

    /**
     * Out-of-band elicitation (`elicitation/create`), routed to the most recently active client.
     * Inside a handler, prefer `context.requestElicit` so the call reaches the initiating client.
     */
    requestElicit(
        message: string,
        requestedSchema: JsonSchema,
    ): Promise<Record<string, unknown>>;

    /** Notifies subscribed clients that a resource changed (`notifications/resources/updated`). */
    notifyResourceUpdated(uri: string): void;

    /** Sends a log message to the client (`notifications/message`). */
    log(level: LogLevel, data: unknown, logger?: string): void;

    /** Opens the WebSocket and publishes the current registries. Idempotent while connected. */
    connect(): Promise<void>;

    /** Closes the socket, stops reconnecting, and aborts every in-flight call. */
    disconnect(): void;
}
