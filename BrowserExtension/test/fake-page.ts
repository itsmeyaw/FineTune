// Just enough of a page (media elements, mutation observer, shadow roots, Web Audio) to run the gain script under node.
// Every page gets its own classes, because the gain script patches prototypes in place.
import type { GainEnv } from "../src/content/gain.ts";

export function makePage() {
  class Media {
    /** What the speakers get: the browser's own volume, whatever the page sees. */
    output = 1;
    shadowRoot: Root | undefined;
    get volume(): number {
      return this.output;
    }
    set volume(value: number) {
      if (!(value >= 0 && value <= 1)) throw new RangeError("IndexSizeError");
      this.output = value;
    }
    play() {
      return Promise.resolve();
    }
    querySelectorAll() {
      return [];
    }
  }

  class Root {
    children: Media[] = [];
    observers: Observer[] = [];
    querySelectorAll(selector: string) {
      return selector === "*" ? this.children : this.children.filter((child) => "volume" in child);
    }
    /** Page script adds nodes; observers hear about them. */
    append(...nodes: Media[]) {
      this.children.push(...nodes);
      for (const observer of this.observers) observer.callback([{ addedNodes: nodes }]);
    }
  }

  class Observer {
    readonly callback: (records: Array<{ addedNodes: Media[] }>) => void;
    constructor(callback: (records: Array<{ addedNodes: Media[] }>) => void) {
      this.callback = callback;
    }
    observe(root: Root) {
      root.observers.push(this);
    }
  }

  class Element extends Media {
    attachShadow() {
      this.shadowRoot = new Root();
      return this.shadowRoot;
    }
  }

  class AudioNode {
    readonly connections: unknown[] = [];
    readonly context: AudioContext | undefined;
    constructor(context?: AudioContext) {
      this.context = context;
    }
    connect(target: unknown) {
      this.connections.push(target);
      return target;
    }
    disconnect(target?: unknown) {
      const index = this.connections.indexOf(target);
      if (index >= 0) this.connections.splice(index, 1);
    }
  }
  class AudioDestinationNode extends AudioNode {}
  class GainNode extends AudioNode {
    readonly gain: { value: number };
    constructor(context: AudioContext, options: { gain?: number } = {}) {
      super(context);
      this.gain = { value: options.gain ?? 1 };
    }
  }
  class AudioContext {
    readonly destination = new AudioDestinationNode(this);
  }
  class OfflineAudioContext {
    readonly destination = new AudioDestinationNode(this as unknown as AudioContext);
  }

  const document = new Root();
  const env = {
    HTMLMediaElement: Media,
    Element,
    document,
    MutationObserver: Observer,
    AudioNode,
    AudioDestinationNode,
    AudioContext,
    GainNode,
  } as unknown as GainEnv;
  return {
    env,
    document,
    Media,
    Element,
    AudioNode,
    GainNode,
    AudioContext,
    OfflineAudioContext,
  };
}
