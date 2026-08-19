/**
 * TrueScript Production Starter Architecture
 * High-rigor runtime invariant contracts + nominal branded types
 */

// Branded Nominal Type System
export type Brand<K, T> = K & { readonly __brand: T };
export type UserId = Brand<string, 'UserId'>;
export type ExecutionScore = Brand<number, 'ExecutionScore'>;

export function makeUserId(raw: string): UserId {
  assertInvariant(raw.length >= 4, `UserId must be at least 4 chars long, got: '${raw}'`);
  return raw as UserId;
}

export function makeScore(raw: number): ExecutionScore {
  assertInvariant(raw >= 0.0 && raw <= 100.0, `Score must be in range [0, 100], got: ${raw}`);
  return raw as ExecutionScore;
}

export class ContractViolationError extends Error {
  constructor(message: string) {
    super(`[TrueScript Contract Violation]: ${message}`);
    this.name = 'ContractViolationError';
  }
}

export function assertInvariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ContractViolationError(message);
  }
}

export interface AgentTaskContract {
  readonly id: UserId;
  readonly score: ExecutionScore;
  readonly status: 'PENDING' | 'EXECUTING' | 'SUCCESS' | 'FAILED';
}

export class TrueScriptEngine {
  public executeContract(task: AgentTaskContract): Readonly<AgentTaskContract> {
    // Pre-condition assertion
    assertInvariant(task.status === 'PENDING', `Task status must be PENDING, got: ${task.status}`);

    const nextScore = makeScore(Math.min(100, task.score + 10));
    const result: AgentTaskContract = {
      id: task.id,
      score: nextScore,
      status: 'SUCCESS'
    };

    // Post-condition assertion
    assertInvariant(result.score >= task.score, 'Post-condition failed: Score decreased during execution');
    return Object.freeze(result);
  }
}

// Verification runner
if (typeof require !== 'undefined' && require.main === module) {
  const engine = new TrueScriptEngine();
  const userId = makeUserId('usr_9901');
  const score = makeScore(85.0);

  const initialTask: AgentTaskContract = {
    id: userId,
    score: score,
    status: 'PENDING'
  };

  const output = engine.executeContract(initialTask);
  console.log('[TrueScript Verified Output]:', output);
}
