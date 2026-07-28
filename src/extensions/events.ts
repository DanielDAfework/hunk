import type {
  ExtensionChangeset,
  ExtensionDiffFile,
  ExtensionEventName,
  ExtensionEventPayloads,
  ExtensionLoadResult,
} from "./types";
import type { ExtensionVcsFileChangeType } from "../extension-api/types";

/**
 * How long `shutdown` handlers may run before Hunk exits anyway.
 *
 * Quitting must feel instant, so shutdown is best-effort: handlers get a short
 * window to flush whatever they were doing and are then abandoned.
 */
export const EXTENSION_SHUTDOWN_TIMEOUT_MS = 250;

/** Read an error's message without assuming handlers throw `Error` instances. */
function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}

/**
 * Build the read-only changeset view lifecycle handlers receive.
 *
 * Handlers are observers, not transforms — `transformChangeset` is the
 * supported way to change what gets reviewed, and it works by returning a new
 * changeset. Passing the live object to a handler instead means one
 * `payload.changeset.files.push(...)` corrupts the array the review UI renders
 * from, and the app dies on the next render, far from the extension that did it.
 *
 * So handlers get frozen shallow copies: the changeset, its `files` array, and
 * each file. A mutating handler now throws *inside itself*, where the isolation
 * contract already turns it into a warning naming the extension. Copies are
 * frozen rather than the originals, so nothing internal — which legitimately
 * rebuilds and reassigns these objects — is affected. The shared nested state
 * (`metadata`, `stats`, `agent`) is guarded by `toReadOnlyDeepView` instead of
 * a deep freeze, which would cost a walk of the whole diff model per emit.
 */
export function toReadOnlyChangesetView(changeset: ExtensionChangeset): ExtensionChangeset {
  const files = Array.isArray(changeset.files) ? changeset.files : [];
  return Object.freeze({ ...changeset, files: toReadOnlyFileViews(files) });
}

/**
 * Read the change type Hunk's diff engine recorded for one file, if any.
 *
 * `metadata` is opaque in the public contract, but the change type inside it is
 * exactly the vocabulary adapters already speak (`ExtensionVcsFileChangeType`),
 * so the read-only views surface it as a first-class field instead of asking
 * extensions to poke into an object Hunk promised not to describe.
 */
export function readMetadataChangeType(metadata: unknown): ExtensionVcsFileChangeType | undefined {
  const type = (metadata as { type?: unknown } | null | undefined)?.type;
  return type === "change" ||
    type === "rename-pure" ||
    type === "rename-changed" ||
    type === "new" ||
    type === "deleted"
    ? type
    : undefined;
}

/**
 * Read how many hunks Hunk's diff engine parsed for one file, if any.
 *
 * Same boundary as `readMetadataChangeType`: `metadata` is opaque to
 * extensions, so the one place that knows its real shape stays here rather
 * than spreading casts across the surfaces that hand extensions file views.
 * A file the engine could not parse into hunks — binary, skipped — reads as
 * zero rather than throwing.
 */
export function readMetadataHunkCount(metadata: unknown): number {
  const hunks = (metadata as { hunks?: unknown } | null | undefined)?.hunks;
  return Array.isArray(hunks) ? hunks.length : 0;
}

/** Proxies already built for shared objects, so repeated views stay identical. */
const readOnlyDeepViews = new WeakMap<object, unknown>();

/** Report whether a value is JSON-shaped data a read-only proxy can stand in for. */
function isProxyableData(value: unknown): value is object {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return true;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Lazily wrap one shared object so extensions can read it but never write it.
 *
 * The file views deliberately share `metadata`, `stats`, and `agent` with the
 * live review model instead of copying them — `metadata` alone is the whole
 * parsed diff, and eagerly deep-freezing it would walk the model on every
 * conversion. The proxy defers the cost to the moment an extension actually
 * reaches in: reads pass through and hand back wrapped objects (so the guard
 * is deep), while writes, deletes, and redefinitions are refused — a
 * strict-mode assignment throws inside the extension, exactly like writing to
 * the frozen view itself. Proxies are cached per source object, so converting
 * again hands out the identical view.
 *
 * Only plain objects and arrays are wrapped: the diff model is JSON-shaped,
 * and proxying an exotic object (a Map, a class instance) would break its
 * internal-slot methods, so anything else reads through unwrapped. A property
 * that is already non-configurable and non-writable is returned as-is — the
 * proxy `get` invariant requires its identity, and it cannot be reassigned
 * anyway.
 */
export function toReadOnlyDeepView<T>(value: T): T {
  if (!isProxyableData(value)) {
    return value;
  }

  const cached = readOnlyDeepViews.get(value);
  if (cached !== undefined) {
    return cached as T;
  }

  const proxy = new Proxy(value, {
    get(target, property) {
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      const result = Reflect.get(target, property, target);
      if (descriptor !== undefined && !descriptor.configurable && !descriptor.writable) {
        return result;
      }

      return toReadOnlyDeepView(result);
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
  });
  readOnlyDeepViews.set(value, proxy);
  return proxy as T;
}

/**
 * Build the read-only file-list view extension UI code receives.
 *
 * The same isolation story as `toReadOnlyChangesetView` — frozen shallow
 * copies, with the nested state every copy shares (`metadata`, `stats`,
 * `agent`) behind `toReadOnlyDeepView` — factored out so surfaces that hand
 * extensions a file list without a changeset envelope (a custom sidebar's
 * props, a command's selection) guard it identically. `changeType` is filled
 * from the diff metadata when the file does not carry it already.
 */
export function toReadOnlyFileViews(files: readonly ExtensionDiffFile[]): ExtensionDiffFile[] {
  const frozenFiles = files.map((file) => {
    if (file === null || typeof file !== "object") {
      return file;
    }

    const changeType = file.changeType ?? readMetadataChangeType(file.metadata);
    return Object.freeze({
      ...file,
      ...(changeType ? { changeType } : {}),
      metadata: toReadOnlyDeepView(file.metadata),
      stats: toReadOnlyDeepView(file.stats),
      agent: toReadOnlyDeepView(file.agent),
    });
  }) as ExtensionDiffFile[];

  return Object.freeze(frozenFiles) as ExtensionDiffFile[];
}

/**
 * Build the payload handlers receive: a frozen copy, with a frozen changeset view.
 *
 * Done here, once per emit, rather than at each call site — every event gets the
 * protection automatically and a future one cannot forget it. The envelope is
 * frozen as well as the changeset, because handlers for one event share a single
 * payload object: without it, a handler that deletes or overwrites a field
 * changes what every later handler sees, which is the same isolation failure as
 * mutating the changeset, one level up.
 *
 * The caller's own object is never frozen — only the copy handed outward.
 */
function toHandlerPayload<Event extends ExtensionEventName>(
  payload: ExtensionEventPayloads[Event],
): ExtensionEventPayloads[Event] {
  const changeset = (payload as { changeset?: unknown }).changeset;
  if (changeset === null || typeof changeset !== "object") {
    return Object.freeze({ ...payload }) as ExtensionEventPayloads[Event];
  }

  return Object.freeze({
    ...payload,
    changeset: toReadOnlyChangesetView(changeset as ExtensionChangeset),
  }) as ExtensionEventPayloads[Event];
}

/**
 * Invoke every handler for one event, isolating each from the others.
 *
 * A handler that throws synchronously or rejects is reported through
 * `ctx.notify` naming its extension and never reaches the caller, so one bad
 * extension cannot take down navigation, reload, or exit.
 */
function runExtensionEventHandlers<Event extends ExtensionEventName>(
  result: ExtensionLoadResult,
  event: Event,
  rawPayload: ExtensionEventPayloads[Event],
  /** Restrict delivery to handlers owned by these extensions; all of them when omitted. */
  extensionIds?: ReadonlySet<string>,
): Promise<void>[] {
  const registered = result.registry.eventHandlers[event];
  const handlers = extensionIds
    ? registered.filter((entry) => extensionIds.has(entry.extensionId))
    : registered;
  const settled: Promise<void>[] = [];

  if (handlers.length === 0) {
    return settled;
  }

  const payload = toHandlerPayload(rawPayload);

  for (const { extensionId, handler } of handlers) {
    /** Turn one handler failure into a warning instead of an app-level error. */
    const report = (error: unknown) => {
      result.context.notify(
        `Extension ${extensionId} failed handling ${event} • ${describeError(error)}`,
        "warning",
      );
    };

    try {
      const returned = handler(payload, result.context);
      if (returned && typeof (returned as PromiseLike<void>).then === "function") {
        settled.push(Promise.resolve(returned).catch(report));
      }
    } catch (error) {
      report(error);
    }
  }

  return settled;
}

/**
 * Emit one lifecycle event without blocking the caller.
 *
 * Async handlers are started and detached: the UI thread never waits on
 * extension code, which is what keeps a slow handler from stalling a reload or
 * a selection change.
 */
export function emitExtensionEvent<Event extends ExtensionEventName>(
  result: ExtensionLoadResult | undefined,
  event: Event,
  payload: ExtensionEventPayloads[Event],
) {
  if (!result) {
    return;
  }

  runExtensionEventHandlers(result, event, payload);
}

/**
 * Emit one lifecycle event to a named subset of the loaded extensions.
 *
 * This exists for `startup`, which is a per-extension promise ("once, after the
 * app mounts with its first changeset") rather than a per-session one. Granting
 * repo trust mid-session loads extensions that missed the mount emit entirely,
 * and re-emitting to everyone would fire `startup` a second time for the
 * extensions that already had it. Delivering to just the newly loaded ones
 * keeps both halves of the promise.
 */
export function emitExtensionEventToExtensions<Event extends ExtensionEventName>(
  result: ExtensionLoadResult | undefined,
  event: Event,
  payload: ExtensionEventPayloads[Event],
  extensionIds: ReadonlySet<string>,
) {
  if (!result || extensionIds.size === 0) {
    return;
  }

  runExtensionEventHandlers(result, event, payload, extensionIds);
}

/**
 * Emit one lifecycle event and wait for its async handlers, up to a bound.
 *
 * Only `shutdown` needs this: everything else is fire-and-forget. The returned
 * promise always resolves, either when every handler settled or when the
 * timeout elapsed, so exit is delayed by at most `timeoutMs`.
 */
export async function emitExtensionEventBounded<Event extends ExtensionEventName>(
  result: ExtensionLoadResult | undefined,
  event: Event,
  payload: ExtensionEventPayloads[Event],
  timeoutMs = EXTENSION_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  if (!result) {
    return;
  }

  const pending = runExtensionEventHandlers(result, event, payload);
  if (pending.length === 0) {
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);

  if (timer) {
    clearTimeout(timer);
  }
}
