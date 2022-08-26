import { Router } from 'itty-router';
import {
  error,
  json,
  StatusError,
  withContent,
} from 'itty-router-extras';

type EmptyObj = {[key: string]: any};
const URL = 'https://durable/';

export type DurableInit<Env = EmptyObj, T extends DurableObjectAPI = DurableObjectAPI> = (state: DurableObjectState, env: Env) => T;

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
export function createDurable<Env = EmptyObj, T extends DurableObjectAPI = DurableObjectAPI>(durable: DurableInit<Env, T>): BasicDurable<Env> {
  return (state: DurableObjectState, env: Env) => {
    extendEnv(env);
    const api = durable(state, env);
    const router = Router().post('/:prop', withContent, async (request: Request) => {
      const { prop } = (request as any).params as {prop: keyof T};
      const { content } = request as any;

      if (typeof api[prop] !== 'function') {
        throw new StatusError(500, `Durable Object does not contain method ${prop as string}()`)
      }
      const response = await (prop === 'fetch' ? api[prop](request) : api[prop](...content));
      return response instanceof Response ? response : (response ? json(response) : new Response())
    });

    return {
      fetch: (request: Request) => request.url.startsWith(URL)
        ? router.handle(request).catch(err => error(err.status || 500, err.message))
        : (api as unknown as DurableObjectAPIWithFetch).fetch?.(request) || error(500, 'Durable Object cannot handle request')
    }
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

export interface DurableObjectNamespaceExt<T = DurableObjectStub> extends DurableObjectNamespace {
  get(id?: string | DurableObjectId): DurableObjectStub & PromisifiedObject<T>;
}

export interface DurableObjectAPI {
  [key: string]: (...args: any[]) => any;
}

export interface DurableObjectAPIWithFetch extends DurableObjectAPI {
  fetch: (request: Request) => Response;
}

function extendNamespace(namespace: DurableObjectNamespace) {
  const get = namespace.get.bind(namespace);
  namespace.get = (id?: string | DurableObjectId) => {
    if (!id) {
      id = namespace.newUniqueId();
    } else if (typeof id === 'string') {
      id = id.length === 64 ? namespace.idFromString(id) : namespace.idFromName(id);
    }

    const stub = get(id);
    return new Proxy(stub, {
      get: (obj, prop: string) => prop in obj
        ? obj[prop as keyof DurableObjectStub]
        : (...args: any[]) => stubFetch(obj, prop, args),
    })
  };
  return namespace;
}

async function stubFetch(obj: DurableObjectStub, prop: string, content: any) {
  return obj.fetch(createRequest(prop, content)).then(transformResponse)
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

function transformResponse(response: Response) {
  try {
    return response.json();
  } catch (err) {}
  try {
    return response.text();
  } catch (err) {}
  return response;
}

interface BasicDurable<Env = EmptyObj> {
  (state: DurableObjectState, env: Env): {
    fetch: (request: Request) => Response | Promise<Response>;
  };
}

type PromisifiedObject<T> = {
  [K in keyof T]: T[K] extends (...args: any) => Promise<any>
    ? T[K]
    : T[K] extends (...args: infer A) => any
    ? (...args: A) => Promise<ReturnType<T[K]>>
    : never;
}
