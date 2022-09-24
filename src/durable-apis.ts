import { Router } from 'itty-router';
import {
  error,
  json,
  StatusError,
  withContent,
} from 'itty-router-extras';

type EmptyObj = {[key: string]: any};
const URL = 'https://durable/';

type Object = Record<string, any>;
export type DurableInitConstructor<Env, T> = {new (state: DurableObjectState, env: Env): T};
export type DurableInitFunction<Env, T> = (state: DurableObjectState, env: Env) => T;

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
    const router = Router().post('/:prop', withContent, async (request: Request) => {
      const { prop } = (request as any).params as {prop: keyof T};
      const { content } = request as any;

      if (typeof api[prop] !== 'function') {
        throw new StatusError(500, `Durable Object does not contain method ${prop as string}()`)
      }
      const response = await (prop === 'fetch' ? api[prop](request) : api[prop](...content));
      return response instanceof Response ? response : createResponse(response);
    });

    return {
      fetch: (request: Request) => request.url.startsWith(URL)
        ? router.handle(request).catch(err => error(err.status || 500, err.message))
        : api.fetch?.(request) || error(500, 'Durable Object cannot handle request')
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
  get(id?: string | DurableObjectId): DurableAPIStub<T>;
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
      // special case for fetch because of breaking behavior
      get: (obj, prop: string) => prop === 'fetch'
        ? (...args: any[]) => obj.fetch(...args)
        : prop in obj
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

function createResponse(data: any) {
  try {
    return json(data);
  } catch(err) {
    return new Response(data);
  }
}

async function transformResponse(response: Response) {
  try {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (err) {}
    return text;
  } catch (err) {}
  return response;
}
