# durable-apis

[![npm package][npm-image]][npm-url]
![Build Status](https://github.com/dabblewriter/durable-apis/actions/workflows/verify.yml/badge.svg)
[![Open Issues][issues-image]][issues-url]
<a href="https://github.com/dabblewriter/durable-apis" target="\_parent">
  <img alt="" src="https://img.shields.io/github/stars/dabblewriter/durable-apis.svg?style=social&label=Star" />
</a>
<a href="https://twitter.com/jac_" target="\_parent">
  <img alt="" src="https://img.shields.io/twitter/follow/jac_.svg?style=social&label=Follow" />
</a>

Simplifies usage of [Cloudflare Durable Objects](https://blog.cloudflare.com/introducing-workers-durable-objects/), allowing a **functional programming style**, **lightweight object definitions**, and **direct access** to object methods from within Workers (no need for request building/handling). Heavily influenced by and loosely forked from https://github.com/kwhitley/itty-durable/.

## Features
- Removes nearly all boilerplate from writing **and** using Durable Objects
- Exposes only desired APIs to be called from outside
- First class Typescript support
- Allows a functional programming style in contrast to the object oriented style of Durable Objects
- Extends existing APIs rather than replacing them

## Example
##### types.ts (type definitions for your Worker and Durable Object)
```ts
export interface CounterAPI {
  get(): number
  increment(): number
  add(a: number, b: number): number
}

export interface Env {
  Counter: DurableObjectNamespaceExt<CounterAPI>
}
```

##### Counter.ts (your Durable Object function)
```ts
import { createDurable } from 'durable-apis'
import { Env } from './types'

export const Counter = createDurable(({ blockConcurrencyWhile, storage }: DurableObjectState, env: Env): CounterAPI => {
  let counter = 0
  blockConcurrencyWhile(async () => conuter = (await storage.get('data')) || 0)

  // Will return the current value of counter
  async function get() {
    return counter
  }

  // Will return the current value of counter
  function increment() {
    storage.put('data', ++counter)
    return counter
  }

  // Note that any serializable params can passed through from the Worker without issue.
  function add(a: number, b: number) {
    return a + b
  }

  // Only public-facing API will be exposed for calling from Workers
  // Adding a fetch method will catch any requests not handled by the API, allowing for Websocket request handling, etc.
  return { get, increment, add }
}
```

##### Worker.js (your CF Worker function)
```js
import { ThrowableRouter, missing } from 'itty-router-extras'
import { withDurables } from 'durable-apis'
import { Env } from './types';

// export the durable class, per spec
export { Counter } from './Counter'

const router = ThrowableRouter({ base: '/counter' })

router
  // add upstream middleware, allowing Durable access off the request
  .all('*', withDurables())

  // get the durable value...
  .get('/', (req: Request, { Counter }: Env) => Counter.get('test').get())

  // By using { autoReturn: true } in createDurable(), this method returns the contents
  .get('/increment', (req: Request, { Counter }: Env) => Counter.get('test').increment())

  // you can pass any serializable params to a method... (e.g. /counter/add/3/4 => 7)
  .get('/add/:a?/:b?',
    ({ params: { a, b }}: Request, { Counter }: Env) => Counter.get('test').add(Number(a), Number(b))
  )

  // 404 for everything else
  .all('*', () => missing('Are you sure about that?'))

// with itty, and using ES6 module syntax (required for DO), this is all you need
export default {
  fetch: router.handle
}

/*
Example Interactions:

GET /counter                                => 0
GET /counter/increment                      => 1
GET /counter/increment                      => 2
GET /counter/increment                      => 3
GET /counter/add/20/3                       => 23
*/
```

## How it Works
This library works via a two part process:

1. First of all, we create a function to implement your Durable Object (through `createDurable()`). This embeds a tiny internal [itty-router](https://www.npmjs.com/package/itty-router) to handle fetch requests. Using this removes the boilerplate from your objects themselves, allowing them to be **only** business logic. Durable Objects defined on your `env` object will be extended automatically the same way `withDurables()` does inside Workers.

2. Next, we expose the `withDurables()` middleware for use within your Workers (it is designed for drop-in use with [itty-router](https://www.npmjs.com/package/itty-router), but should work with virtually any typical Worker router, and `extendEnv()` can be used with no router). This replaces your stubs on the `env` object with extended versions of themselves. Using these extended stubs, you can call methods on the Durable Object directly, rather than manually creating fetch requests to do so (that's all handled internally, communicating with the embedded router within the Durable Objects themselves).

## Installation

```
npm install durable-apis
```

# API

### `createDurable((state: DurableObjectState, env: Env)): Function`
Factory function to create the DurableApi function that wraps your API.

*Note:* if you're confused at how a function can replace a class, it is a simple quirk with how JavaScript treats classes. If something is returned from the constructor of a class, it is returned in the `new Class()` assignment. This means for a function `myFunc()` that returns a value, the two statements `obj = myFunc()` and `obj = new myFunc()` are equal.

### `withDurables(): function`
Recommended middleware to extend Durable Object namespaces with an updated `get()` method on the `env` object. Using the new stubs returned allows you to skip manually creating/sending requests or handling response parsing.

### `extendEnv(env: Env): Env`
If not using middleware, use this to extend the Durable Object stubs `get()` method on the `env` object with an updated version that will let you call API methods directly on the stub. Using these stubs allows you to skip manually creating/sending requests or handling response parsing.

### `DurableObjectNamespace.get(id?: string | DurableObjectId): DurableObjectNamespaceExt`
The new `get()` method will still work the way it did before, taking a `DurableObjectId` and returning a stub that you can call `fetch()` on. But you can also call other methods on the stub which will be proxied to the Durable Object. In addition, if you pass a string to `get()` that is 64 characters long (the length of a Durable Object id), it will automatically convert that to an id object (using `idFromString()`) and return the stub. If you pass a string that is not 64 characters long, it will be treated as the name and converted to the id (using `idFromName`) before returning the stub. If you pass nothing, a new id will be created (using `newUniqueId()`) and the stub will be returned.

### `DurableObjectNamespaceExt<T>`
Typescript interface which will add the interface methods for `T` to the stub proxy. This allows Typescript users to define their `env` object with the specific APIs that their Durable Objects implement, helping avoid errors in code. The methods return types are all wrapped in `Promise`s automatically if the method does not already return a `Promise` since calling a Durable Object will always be an asyncronous operation.

## Special Thanks
Thanks to Kevin Whitley for the [Itty Router](https://github.com/kwhitley/itty-router/) library and for work on [Itty Durable](https://github.com/kwhitley/itty-durable/) which this was modeled after.
