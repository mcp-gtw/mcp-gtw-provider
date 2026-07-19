# Frameworks

`McpGtwProvider` has no framework dependency. The same class works in a bare HTML page and inside
any framework — you own when to `connect()`, `registerTool()`, and `disconnect()`.

## Vanilla JavaScript

Import the module directly in a page, no bundler required:

```html
<script type="module">
    import { McpGtwProvider } from "https://esm.sh/mcp-gtw-provider";

    const provider = new McpGtwProvider({ url: sessionUrl });
    provider.registerTool({ name: "ping" }, () => "pong");
    await provider.connect();
</script>
```

With a bundler, `import { McpGtwProvider } from "mcp-gtw-provider"` works the same way.

## React

Create the provider once, connect on mount, and disconnect on unmount. Register tools in effects so
their handlers close over current state:

```jsx
import { useEffect, useRef, useState } from "react";
import { McpGtwProvider } from "mcp-gtw-provider";

function useMcpProvider(url) {
    const providerRef = useRef(null);
    const [status, setStatus] = useState("disconnected");

    if (providerRef.current === null) {
        providerRef.current = new McpGtwProvider({ url, onStatusChange: setStatus });
    }

    useEffect(() => {
        const provider = providerRef.current;
        provider.connect().catch((error) => console.error(error));
        return () => provider.disconnect();
    }, []);

    return { provider: providerRef.current, status };
}

function Board({ url }) {
    const { provider, status } = useMcpProvider(url);
    const [count, setCount] = useState(0);

    useEffect(() => {
        const unregister = provider.registerTool(
            { name: "increment", description: "Add to the counter" },
            ({ by = 1 }) => {
                setCount((value) => value + by);
                return { count: count + by };
            },
        );
        return unregister;
    }, [provider, count]);

    return <p>Gateway: {status} — count {count}</p>;
}
```

## Vue

```vue
<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import { McpGtwProvider } from "mcp-gtw-provider";

const props = defineProps({ url: String });
const status = ref("disconnected");
const count = ref(0);

const provider = new McpGtwProvider({
    url: props.url,
    onStatusChange: (next) => (status.value = next),
});

let unregister;

onMounted(() => {
    unregister = provider.registerTool(
        { name: "increment", description: "Add to the counter" },
        ({ by = 1 }) => {
            count.value += by;
            return { count: count.value };
        },
    );
    provider.connect().catch((error) => console.error(error));
});

onUnmounted(() => {
    unregister?.();
    provider.disconnect();
});
</script>

<template>
    <p>Gateway: {{ status }} — count {{ count }}</p>
</template>
```

## Anything else

The pattern is always the same: construct with a `url`, register capabilities (`registerTool`,
`registerResource`, `registerResourceTemplate`, `registerPrompt`, plus the `onComplete` /
`onSubscribe` callbacks), `connect()` when ready, and `disconnect()` to tear down. Handlers are plain
functions, so any state management — signals, stores, plain variables — works.
