export class PromiseBackend {
  static setGlobal(globalObject = window) {
    PromiseBackend.global = globalObject;
  }

  static flush(recursiveFlush = false) {
    var i = (PromiseBackend.queue && PromiseBackend.queue.length), task;
    if (!i) {
      throw new Error('Nothing to flush!');
    }
    if (!recursiveFlush) {
      while (i--) {
        task = PromiseBackend.queue.shift();
        task.call(null);
      }
    }
    else {
      while(PromiseBackend.queue.length) {
        task = PromiseBackend.queue.shift();
        task.call(null);
      }
    }

    return PromiseBackend;
  }

  static executeAsap(fn) {
    PromiseBackend.queue = PromiseBackend.queue || [];
    PromiseBackend.queue.push(fn);
  }

  static restoreNativePromise() {
    if (!PromiseBackend.__OriginalPromise__) {
      throw new ReferenceError('__OriginalPromise__ is not set. restoreNativePromise should only be called after calling "patchWithMock()"')
    }
    PromiseBackend.global.Promise = PromiseBackend.__OriginalPromise__;
  }

  static patchWithMock() {
    PromiseBackend.global = PromiseBackend.global ||
        (typeof window !== 'undefined' ? window : global);
    PromiseBackend.__OriginalPromise__ = PromiseBackend.global.Promise;
    PromiseBackend.global.Promise = PromiseMock;
  }

  static verifyNoOutstandingTasks() {
    if (PromiseBackend.queue && PromiseBackend.queue.length) {
      throw new Error('Pending tasks to be flushed');
    }
  }

  static forkZone() {
    return zone.fork({
      onZoneEnter: function() {
        PromiseBackend.patchWithMock();
      },
      onZoneLeave: function() {
        PromiseBackend.restoreNativePromise();
        PromiseBackend.verifyNoOutstandingTasks();
        PromiseBackend.queue = undefined;
      },
      onError: function (e) {
        console.log('error!', e);
        throw new Error(e);
      }
    });
  }
}

var promiseRaw = {};

export class PromiseMock {
  constructor(resolver) {
    if (resolver === promiseRaw)
      return;
    if (typeof resolver !== 'function')
      throw new TypeError;
    var promise = promiseInit(this);
    try {
      resolver((x) => { promiseResolve(promise, x) },
               (r) => { promiseReject(promise, r) });
    } catch (e) {
      promiseReject(promise, e);
    }
    this.backend = new PromiseBackend();
  }

  catch(onReject) {
    return chain(this, undefined, onReject)
  }

  // Extended functionality for multi-unwrapping chaining and coercive 'then'.
  then(onResolve, onReject) {
    if (typeof onResolve !== 'function') onResolve = idResolveHandler;
    if (typeof onReject !== 'function') onReject = idRejectHandler;
    var that = this;
    var constructor = this.constructor;
    return chain(this, function(x) {
      x = promiseCoerce(constructor, x);
      return x === that ? onReject(new TypeError) :
          isPromise(x) ? x.then(onResolve, onReject) : onResolve(x)
    }, onReject);
  }

  // Convenience.

  static resolve(x) {
    if (this === $Promise) {
      // Optimized case, avoid extra closure.
      return promiseSet(new $Promise(promiseRaw), +1, x);
    } else {
      return new this(function(resolve, reject) { resolve(x) });
    }
  }

  static reject(r) {
    if (this === $Promise) {
      // Optimized case, avoid extra closure.
      return promiseSet(new $Promise(promiseRaw), -1, r);
    } else {
      return new this((resolve, reject) => { reject(r) });
    }
  }

  // Combinators.

  static cast(x) {
    if (x instanceof this)
      return x;
    if (isPromise(x)) {
      var result = getDeferred(this);
      chain(x, result.resolve, result.reject);
      return result.promise;
    }
    return this.resolve(x);

  }

  static all(values) {
    var deferred = getDeferred(this);
    var resolutions = [];
    try {
      var count = values.length;
      if (count === 0) {
        deferred.resolve(resolutions);
      } else {
        for (var i = 0; i < values.length; i++) {
          this.resolve(values[i]).then(
              function(i, x) {
                resolutions[i] = x;
                if (--count === 0)
                  deferred.resolve(resolutions);
              }.bind(undefined, i),
              (r) => { deferred.reject(r); });
        }
      }
    } catch (e) {
      deferred.reject(e);
    }
    return deferred.promise;
  }

  static race(values) {
    var deferred = getDeferred(this);
    try {
      // TODO(arv): values should be an iterable
      for (var i = 0; i < values.length; i++) {
        this.resolve(values[i]).then(
            (x) => { deferred.resolve(x); },
            (r) => { deferred.reject(r); });
      }
    } catch (e) {
      deferred.reject(e);
    }
    return deferred.promise;
  }
}

var $Promise = PromiseMock;
var $PromiseReject = $Promise.reject;

function promiseResolve(promise, x) {
  promiseDone(promise, +1, x, promise.onResolve_);
}

function promiseReject(promise, r) {
  promiseDone(promise, -1, r, promise.onReject_);
}

function promiseDone(promise, status, value, reactions) {
  if (promise.status_ !== 0)
    return;
  promiseEnqueue(value, reactions);
  promiseSet(promise, status, value);
}

function promiseEnqueue(value, tasks) {
  PromiseBackend.executeAsap(function () {
    for (var i = 0; i < tasks.length; i += 2) {
      promiseHandle(value, tasks[i], tasks[i + 1])
    }
  });
}

function promiseHandle(value, handler, deferred) {
  try {
    var result = handler(value);
    if (result === deferred.promise)
      throw new TypeError;
    else if (isPromise(result))
      chain(result, deferred.resolve, deferred.reject);
    else
      deferred.resolve(result);
  } catch (e) {
    // TODO(arv): perhaps log uncaught exceptions below.
    try { deferred.reject(e) } catch(e) {}
  }
}

// This should really be a WeakMap.
var thenableSymbol = '@@thenable';

function isObject(x) {
  return x && (typeof x === 'object' || typeof x === 'function');
}

function promiseCoerce(constructor, x) {
  if (!isPromise(x) && isObject(x)) {
    var then;
    try {
      then = x.then;
    } catch (r) {
      var promise = $PromiseReject.call(constructor, r);
      x[thenableSymbol] = promise;
      return promise;
    }
    if (typeof then === 'function') {
      var p = x[thenableSymbol];
      if (p) {
        return p;
      } else {
        var deferred = getDeferred(constructor);
        x[thenableSymbol] = deferred.promise;
        try {
          then.call(x, deferred.resolve, deferred.reject);
        } catch (r) {
          deferred.reject(r);
        }
        return deferred.promise;
      }
    }
  }
  return x;
}




function isPromise(x) {
  return x && typeof x === 'object' && x.status_ !== undefined;
}

function idResolveHandler(x) {
  return x;
}

function idRejectHandler(x) {
  throw x;
}

// Simple chaining (a.k.a. flatMap).
function chain(promise,
               onResolve = idResolveHandler,
               onReject = idRejectHandler) {
  var deferred = getDeferred(promise.constructor);
  switch (promise.status_) {
    case undefined:
      throw TypeError;
    case 0:
      promise.onResolve_.push(onResolve, deferred);
      promise.onReject_.push(onReject, deferred);
      break;
    case +1:
      promiseEnqueue(promise.value_, [onResolve, deferred]);
      break;
    case -1:
      promiseEnqueue(promise.value_, [onReject, deferred]);
      break;
  }
  return deferred.promise;
}

function getDeferred(C) {
  if (this === $Promise) {
    // Optimized case, avoid extra closure.
    var promise = promiseInit(new $Promise(promiseRaw));
    return {
      promise: promise,
      resolve: (x) => { promiseResolve(promise, x) },
      reject: (r) => { promiseReject(promise, r) }
    };
  } else {
    var result = {};
    result.promise = new C((resolve, reject) => {
      result.resolve = resolve;
      result.reject = reject;
    });
    return result;
  }
}

function promiseSet(promise, status, value, onResolve, onReject) {
  promise.status_ = status;
  promise.value_ = value;
  promise.onResolve_ = onResolve;
  promise.onReject_ = onReject;
  return promise;
}

function promiseInit(promise) {
  return promiseSet(promise, 0, undefined, [], []);
}

