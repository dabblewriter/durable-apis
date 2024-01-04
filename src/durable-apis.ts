import { IRequest, Router, RouterType } from 'itty-router';
import {
  StatusError,
  error,
  json,
  withContent,
} from 'itty-router-extras';

export type EmptyObj = {[key: string]: any};
const URL = 'https://durable/';
const maxRetries = 10;
const retryOn = new RegExp([
  'Network connection lost',
  'Cannot resolve Durable Object due to transient issue on remote node',
  'Durable Object reset because its code was updated',
  'The Durable Object\'s code has been updated',
].join('|'));

export type Object = Record<string, any>;
export type DurableInitConstructor<Env, T> = {new (state: DurableObjectState, env: Env): T};
export type DurableInitFunction<Env, T> = (state: DurableObjectState, env: Env) => T;

export interface BasicDurable<Env = EmptyObj> {
  (state: DurableObjectState, env: Env): {
    fetch: (request: Request) => Response | Promise<Response>;
  };
}

export type PromisifiedObject<T> = {
  [K in keyof T]: T[K] extends (...args: any) => Promise<any>
    ? T[K]
    : T[K] extends (...args: infer A) => any
    ? (...args: A) => Promise<ReturnType<T[K]>>
    : T[K];
}

export type DurableAPIStub<T> = DurableObjectStub & PromisifiedObject<T>;


export type DurableInit<Env = EmptyObj, T extends Object = Object> =
  DurableInitConstructor<Env, T> | DurableInitFunction<Env, T>;

/**
 * createDurable creates a new Durable Object with a public API that can be called directly from a Worker or another
 * Durable Object that has used extendEnv, withDurables, or createDurable.
 *
 * Example:
 * ```js
 * import { DurableObjectNamespaceExt, createDurable, extendEnv } from './durable-stub';
 *
 * interface Env {
 *   Counter: DurableObjectNamespaceExt;
 * }
 *
 * // Durable Object
 * export const Counter = createDurable((state: DurableObjectState, env: Env) => {
 *   let counter = 0;
 *   state.blockConcurrencyWhile(async () => counter = await state.storage.get('data') || 0);
 *
 *   return {
 *     increment() {
 *       state.storage.put('data', ++counter);
 *       return counter;
 *     },
 *
 *     add(a, b) {
 *       return Number(a) + Number(b)
 *     }
 *   };
 * })
 *
 * // Worker
 * export default {
 *   fetch(request: Request, env: Env) {
 *     extendEnv(env);
 *     const count = await env.Counter.increment();
 *     return new Response(count);
 *   }
 * }
 * ```
 */
export function createDurable<Env = EmptyObj, T extends Object = Object>(durable: DurableInit<Env, T>): BasicDurable<Env> {
  return function(state: DurableObjectState, env: Env) {
    extendEnv(env);
    const api = (durable as DurableInitFunction<Env, T>)(state, env);
    const router = Router().post('/:prop', withContent as any, async (request: IRequest) => {
      const { prop } = request.params as {prop: keyof T};
      const { content } = request;

      if (typeof api[prop] !== 'function') {
        throw new StatusError(500, `Durable Object does not contain method ${prop as string}()`)
      }
      const response = await (prop === 'fetch' ? api[prop](request) : api[prop](...content));
      if (response instanceof Response) {
        response.headers.set('X-Direct-Response', 'true');
        return response;
      }
      return createResponse(response);
    });

    return {
      fetch: (request: Request) => request.url.startsWith(URL)
        ? router.handle(request).catch(err => error(err.status || 500, err.message))
        : api.fetch?.(request) || error(500, 'Durable Object cannot handle request')
    }
  }
}

export class DurableAPI<Env = EmptyObj> implements DurableObject {
  private durableAPIRouter: RouterType;

  constructor(protected state: DurableObjectState, protected env: Env) {
    extendEnv(env);

    this.durableAPIRouter = Router().post('/:prop', withContent as any, async (request: IRequest) => {
      const { prop } = request.params;
      const { content } = request;

      if (typeof this[prop] !== 'function') {
        throw new StatusError(500, `Durable Object does not contain method ${prop as string}()`)
      }

      const response = await (prop === 'fetch'
        ? this.handleFetch(request as unknown as Request)
        : this[prop](...content));

      if (response instanceof Response) {
        response.headers.set('X-Direct-Response', 'true');
        return response;
      }

      return createResponse(response);
    });
  }

  /**
   * Handles the fetch event for the Durable Object. This method is called by the Durable Object runtime.
   * This method is intended to be final and should not be overridden. Use handleFetch instead.
   */
  fetch(request: Request) {
    if (request.url.startsWith(URL)) {
      return this.durableAPIRouter.handle(request).catch(err => error(err.status || 500, err.message))
    }
    return this.handleFetch(request);
  }

  /**
   * Handles the fetch event for the Durable Object when a subclass needs to accept websockets or handle requests
   * explicitly that are not from a DurableAPI call.
   */
  handleFetch?(request: Request): Response | Promise<Response> {
    return new Response(
      `{"status":500,"error":"Durable Object cannot handle request"}`,
      {status: 500, headers: {'Content-Type': 'application/json'}}
    );
  }
}

export function withDurables(request: Request, env: object) {
  extendEnv(env);
}

export function extendEnv(env: EmptyObj) {
  for (const value of Object.values(env)) {
    if (value && typeof value.idFromName === 'function') {
      extendNamespace(value as DurableObjectNamespace);
    }
  }
  return env;
}

export function getDurable<T = DurableObjectStub>(namespace: DurableObjectNamespace, id?: string | DurableObjectId, options?: any) {
  return getDurableGet<T>(namespace)(id, options);
}

export type LocationHint = 'wnam' | 'enam' | 'sam' | 'weur' | 'eeur' | 'apac' | 'oc' | 'afr' | 'me';
export type DurableObjectGetOptions = { locationHint?: LocationHint };

export interface DurableObjectNamespaceExt<T = DurableObjectStub> extends DurableObjectNamespace {
  get(id?: string | DurableObjectId, options?: DurableObjectGetOptions): DurableAPIStub<T>;
}

function extendNamespace<T = DurableObjectStub>(namespace: DurableObjectNamespace) {
  if (!(namespace.get as any).extended) {
    namespace.get = getDurableGet(namespace);
    (namespace.get as any).extended = true;
  }
  return namespace as DurableObjectNamespaceExt<T>;
}

function getDurableGet<T = DurableObjectStub>(namespace: DurableObjectNamespace) {
  const get = namespace.get;
  return (id?: string | DurableObjectId, options?: any) => {
    if (!id) {
      id = namespace.newUniqueId();
    } else if (typeof id === 'string') {
      id = id.length === 64 ? namespace.idFromString(id) : namespace.idFromName(id);
    }

    const stub = get.call(namespace, id, options);
    const methods: { [name: string]: (...args: any[]) => any } = {
      fetch: (...args: any[]) => stub.fetch(...args),
    };
    return new Proxy(stub, {
      // special case for fetch because of breaking behavior
      get: (obj, prop: string) => prop in methods
        ? methods[prop]
        : prop in obj
        ? obj[prop]
        : (methods[prop] = (...args: any[]) => stubFetch(obj, prop, args)),
    }) as DurableAPIStub<T>;
  };
}

async function stubFetch(obj: DurableObjectStub, prop: string, content: any, retries = 0) {
  return obj.fetch(createRequest(prop, content)).then(transformResponse).catch(err => {
    if (!shouldRetry(err, retries)) return Promise.reject(err);
    // Retry up to 11 times over 30 seconds with exponential backoff. 20ms, 40ms, etc
    return new Promise(resolve => setTimeout(resolve, Math.pow(2, retries) * 10)).then(() => {
      return stubFetch(obj, prop, content, retries + 1);
    });
  });
}

function createRequest(prop: string, content: any) {
  return new Request(`${URL}${prop}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(content)
  });
}

function createResponse(data: any) {
  try {
    return json(data);
  } catch(err) {
    return new Response(data);
  }
}

async function transformResponse(response: Response) {
  if (response.headers.get('X-Direct-Response') === 'true') {
    const headers = new Headers(response.headers);
    headers.delete('X-Direct-Response');
    response = new Response(response.body, { ...response, headers });
    return response;
  }
  try {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (err) {}
    return text;
  } catch (err) {}
  return response;
}

function shouldRetry(err: any, retries: number) {
  if (retries > maxRetries) return false;
  return retryOn.test(err + '');
}
