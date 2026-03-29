// ============================================================
// CIRCUIT-BREAKER.JS — Tracks consecutive failures per service
// States: CLOSED (normal), OPEN (failing fast), HALF_OPEN (testing)
// ============================================================

const breakers = new Map();

const DEFAULTS = {
  failureThreshold: 5,     // open after 5 consecutive failures
  recoveryTimeout:  60000, // try again after 60 seconds
  successThreshold: 2,     // close after 2 consecutive successes in HALF_OPEN
};

export function getBreaker(name) {
  if (!breakers.has(name)) {
    breakers.set(name, {
      name,
      state:       'CLOSED',
      failures:    0,
      successes:   0,
      lastFailure: null,
      openedAt:    null,
    });
  }
  return breakers.get(name);
}

export async function callWithBreaker(serviceName, fn) {
  const breaker = getBreaker(serviceName);

  if (breaker.state === 'OPEN') {
    const age = Date.now() - breaker.openedAt;
    if (age < DEFAULTS.recoveryTimeout) {
      throw new Error(`[CircuitBreaker] ${serviceName} is OPEN — fast failing. Retry in ${Math.ceil((DEFAULTS.recoveryTimeout - age) / 1000)}s`);
    }
    breaker.state    = 'HALF_OPEN';
    breaker.successes = 0;
  }

  try {
    const result = await fn();
    if (breaker.state === 'HALF_OPEN') {
      breaker.successes++;
      if (breaker.successes >= DEFAULTS.successThreshold) {
        breaker.state    = 'CLOSED';
        breaker.failures = 0;
        console.log(`[CircuitBreaker] ${serviceName} CLOSED — recovered`);
      }
    } else {
      breaker.failures = 0;
    }
    return result;
  } catch (err) {
    breaker.failures++;
    breaker.lastFailure = new Date().toISOString();
    if (breaker.state === 'HALF_OPEN' || breaker.failures >= DEFAULTS.failureThreshold) {
      breaker.state    = 'OPEN';
      breaker.openedAt = Date.now();
      console.error(`[CircuitBreaker] ${serviceName} OPENED after ${breaker.failures} failures`);
    }
    throw err;
  }
}

export function getBreakerStatus() {
  const status = {};
  breakers.forEach((b, name) => {
    status[name] = { state: b.state, failures: b.failures, lastFailure: b.lastFailure };
  });
  return status;
}
