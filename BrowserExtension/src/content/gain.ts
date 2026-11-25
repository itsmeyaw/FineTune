// Runs inside every page frame, in the page's own (main) world: scales everything the page plays by the Tab Volume.
// Plain code on purpose: it ships as a standalone bundle and must work without the page's cooperation.
// oxlint-disable typescript/unbound-method, typescript/no-unsafe-type-assertion -- patching prototypes means holding their original methods and replacing them with differently typed ones.
import { VOLUME_EVENT } from "./channel.ts";

export interface GainEnv {
  readonly HTMLMediaElement: typeof HTMLMediaElement;
  readonly Element: typeof Element;
  readonly document: Document;
  readonly MutationObserver: typeof MutationObserver;
  readonly AudioNode?: typeof AudioNode;
  readonly AudioDestinationNode?: typeof AudioDestinationNode;
  readonly AudioContext?: typeof AudioContext;
  readonly GainNode?: typeof GainNode;
}

export interface Gain {
  /** 0…1; anything else is clamped, NaN means 100%. */
  readonly setVolume: (volume: number) => void;
}

const clamp = (volume: number) => (Number.isNaN(volume) ? 1 : Math.min(1, Math.max(0, volume)));

/** Patches the page's media and Web Audio APIs in place. Call once per frame. */
export function installGain(env: GainEnv): Gain {
  let tab = 1;
  const apply: Array<() => void> = [];

  // HTMLMediaElement: the speakers get `site volume × tab volume`. The page keeps reading and writing its own volume.
  const mediaProto = env.HTMLMediaElement.prototype;
  const volume = Object.getOwnPropertyDescriptor(mediaProto, "volume");
  const nativeGet = volume?.get;
  const nativeSet = volume?.set;
  const nativePlay = mediaProto.play;
  if (volume && nativeGet && nativeSet) {
    const siteVolumes = new WeakMap<HTMLMediaElement, number>();
    const tracked = new Set<WeakRef<HTMLMediaElement>>();
    const track = (element: HTMLMediaElement) => {
      if (siteVolumes.has(element)) return;
      const site = Number(nativeGet.call(element));
      siteVolumes.set(element, site);
      tracked.add(new WeakRef(element));
      if (tab !== 1) nativeSet.call(element, site * tab);
    };
    Object.defineProperty(mediaProto, "volume", {
      ...volume,
      get(this: HTMLMediaElement) {
        return siteVolumes.get(this) ?? nativeGet.call(this);
      },
      set(this: HTMLMediaElement, value: number) {
        // The browser validates the value and throws for the page, as it would without us.
        nativeSet.call(this, value);
        siteVolumes.delete(this);
        track(this);
      },
    });
    mediaProto.play = function (this: HTMLMediaElement) {
      track(this);
      return Reflect.apply(nativePlay, this, []);
    };
    apply.push(() => {
      for (const ref of tracked) {
        const element = ref.deref();
        const site = element && siteVolumes.get(element);
        if (element && site !== undefined) nativeSet.call(element, site * tab);
        else tracked.delete(ref);
      }
    });

    const scan = (root: ParentNode) => {
      for (const element of root.querySelectorAll<HTMLMediaElement>("audio,video")) track(element);
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) watch(element.shadowRoot);
      }
    };
    const watch = (root: ShadowRoot | Document) => {
      scan(root);
      new env.MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof env.HTMLMediaElement) track(node);
            if (node instanceof env.Element) scan(node);
          }
        }
      }).observe(root, { childList: true, subtree: true });
    };
    const nativeAttachShadow = env.Element.prototype.attachShadow;
    env.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const root = Reflect.apply(nativeAttachShadow, this, [init]);
      watch(root);
      return root;
    };
    watch(env.document);
  }

  // Web Audio: everything sent to a context's speakers goes through one master gain node instead.
  const { AudioNode, AudioDestinationNode, AudioContext, GainNode } = env;
  if (AudioNode && AudioDestinationNode && AudioContext && GainNode) {
    const masters = new Set<WeakRef<GainNode>>();
    const masterOf = new WeakMap<BaseAudioContext, GainNode>();
    const nativeConnect = AudioNode.prototype.connect;
    const nativeDisconnect = AudioNode.prototype.disconnect;
    const redirect = (target: unknown): unknown => {
      if (!(target instanceof AudioDestinationNode)) return target;
      const context = target.context;
      if (!(context instanceof AudioContext)) return target;
      let master = masterOf.get(context);
      if (!master) {
        master = new GainNode(context, { gain: tab });
        Reflect.apply(nativeConnect, master, [target]);
        masterOf.set(context, master);
        masters.add(new WeakRef(master));
      }
      return master;
    };
    AudioNode.prototype.connect = function (this: AudioNode, target: unknown, ...rest: unknown[]) {
      const result: unknown = Reflect.apply(nativeConnect, this, [redirect(target), ...rest]);
      return target instanceof AudioDestinationNode ? target : result;
    } as typeof AudioNode.prototype.connect;
    AudioNode.prototype.disconnect = function (this: AudioNode, ...args: unknown[]) {
      return Reflect.apply(
        nativeDisconnect,
        this,
        args.length > 0 ? [redirect(args[0]), ...args.slice(1)] : args,
      );
    } as typeof AudioNode.prototype.disconnect;
    apply.push(() => {
      for (const ref of masters) {
        const master = ref.deref();
        if (master) master.gain.value = tab;
        else masters.delete(ref);
      }
    });
  }

  return {
    setVolume: (next) => {
      tab = clamp(next);
      for (const run of apply) run();
    },
  };
}

/** Installs the gain once per frame and drives it from the relay's volume events. */
export function attachGain(env: GainEnv & Pick<EventTarget, "addEventListener">): void {
  const key = Symbol.for("finetune.gain");
  if (Reflect.has(env, key)) return;
  Reflect.defineProperty(env, key, { value: true });
  const gain = installGain(env);
  env.addEventListener(VOLUME_EVENT, (event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    if (typeof detail === "number") gain.setVolume(detail);
  });
}
