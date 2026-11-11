import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * The most the UNDECLARED tools/call arguments of one call may weigh: the UTF-8
 * bytes of each undeclared key plus its value's JSON serialization, summed.
 * Keys count too, or a megabyte-long key name with a tiny value would slip by.
 *
 * Undeclared arguments are never read: zod strips them before a handler runs.
 * So no legitimate input is lost by refusing a large one -- the big inputs this
 * server does take (an aws_call policy document, an aws_lambda_invoke payload up
 * to ~6 MB, aws_script code, an aws_resource_* desired state) all ride on
 * DECLARED keys, which this guard never measures. A small stray key (a client
 * that sends `{"verbose": true}` a tool does not know) still goes through and is
 * ignored as before; only a bulky one is refused, and it costs the caller one
 * clear error instead of shipping megabytes the server would throw away.
 */
export const UNDECLARED_ARGUMENTS_LIMIT_BYTES = 64 * 1024;

/** How many undeclared key names a refusal lists, and how much of each. */
const MAX_NAMES_SHOWN = 10;
const MAX_NAME_CHARS = 64;

/** JSON-RPC "Invalid params". */
const INVALID_PARAMS = -32602;

/**
 * The JSON-RPC error to answer `message` with, or undefined to let it through.
 *
 * Only a `tools/call` REQUEST for a known tool is judged; anything else (an
 * unknown tool, a non-object `arguments`, a notification) is left to the SDK,
 * which already has an answer for each.
 *
 * Why a JSON-RPC error and not a validation failure inside the tool: McpServer
 * turns every error thrown on the tools/call path -- its own zod failures
 * included -- into an `isError: true` RESULT, and a result is what an MCP
 * client reads as "the server processed this". Refusing the request has to
 * happen before McpServer sees it.
 */
export function rejectOversizedUndeclaredArguments(
  message: JSONRPCMessage,
  declaredArguments: ReadonlyMap<string, ReadonlySet<string>>,
  limitBytes: number = UNDECLARED_ARGUMENTS_LIMIT_BYTES,
): JSONRPCMessage | undefined {
  if (!("method" in message) || message.method !== "tools/call" || !("id" in message)) return undefined;
  const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
  if (typeof params?.name !== "string") return undefined;
  const declared = declaredArguments.get(params.name);
  const args = params.arguments;
  if (!declared || !args || typeof args !== "object" || Array.isArray(args)) return undefined;

  const undeclared: string[] = [];
  let bytes = 0;
  for (const [key, value] of Object.entries(args)) {
    if (declared.has(key)) continue;
    undeclared.push(key);
    bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  }
  if (bytes <= limitBytes) return undefined;

  // Bounded, so a refusal over many or huge key names does not echo them back.
  const shown = undeclared
    .slice(0, MAX_NAMES_SHOWN)
    .map((k) => JSON.stringify(k.length > MAX_NAME_CHARS ? `${k.slice(0, MAX_NAME_CHARS)}...` : k));
  const more = undeclared.length - shown.length;
  const names = shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: INVALID_PARAMS,
      message:
        `Invalid arguments for tool ${params.name}: undeclared argument(s) ${names} carry ${bytes} bytes, ` +
        `past the ${limitBytes}-byte limit for arguments the tool does not take. ` +
        `They would be ignored; remove them. Declared arguments: ${[...declared].join(", ") || "(none)"}.`,
    },
  };
}

/**
 * Install {@link rejectOversizedUndeclaredArguments} in front of whatever
 * handler the protocol layer attaches to `transport.onmessage`.
 *
 * An accessor on the instance rather than a wrap after `connect()`: the
 * protocol assigns `onmessage` during connect, and an accessor intercepts that
 * assignment whenever it happens, so no message can arrive in a window before
 * the guard is in place.
 */
export function guardUndeclaredArguments(
  transport: Transport,
  declaredArguments: ReadonlyMap<string, ReadonlySet<string>>,
  limitBytes: number = UNDECLARED_ARGUMENTS_LIMIT_BYTES,
): void {
  let guarded: Transport["onmessage"];
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    enumerable: true,
    get: () => guarded,
    set: (inner: Transport["onmessage"]) => {
      guarded =
        inner &&
        ((message, extra) => {
          const refusal = rejectOversizedUndeclaredArguments(message, declaredArguments, limitBytes);
          if (!refusal) {
            inner(message, extra);
            return;
          }
          transport.send(refusal).catch((err: unknown) => transport.onerror?.(err as Error));
        });
    },
  });
}
