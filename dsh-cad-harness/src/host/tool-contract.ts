// The tool-output contract, enforced at REGISTRATION time (2026-10-23 audit, FIX-A1/A3).
//
// WHY THIS EXISTS
// ---------------
// A tool declares `output.schema`, and the harness validates the body's value against it
// at the runtime boundary (`ToolRuntime.createSuccessResult`). The value never reaches
// the model if it violates the schema — so a schema that disagrees with its own body is
// not a cosmetic defect, it is a broken tool.
//
// That property was not being tested anywhere: every `scripts/accept-*.mjs` calls
// `def.execute()` directly, i.e. below the boundary. Four tools shipped with a schema
// disagreeing with their body (validate_assembly required two keys it never returned;
// check_assembly returned two keys it never declared; preflight returned `timings` it
// never declared; check_printability required `profiles[].timings` that its profile
// entries never carry) and every acceptance run stayed green.
//
// WHAT THIS DOES
// --------------
// Wraps a definition's `execute` so the value is validated against the SAME compiled
// schema the runtime uses, and fails with the tool name and the exact JSON paths. Tests
// and direct callers therefore enforce the contract too, instead of discovering it in a
// live session.
//
// Cost: one JSON-Schema walk over a value the tool already serialises for the model —
// sub-millisecond beside a compile or a simulation.
//
// The marker exists so an acceptance can prove the wrapper is actually installed on every
// registered tool (a silently-not-applied wrapper would reproduce the original bug).

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { classifyError, envelopeOf, envelopeText, withEnvelope, type ErrorEnvelope } from '../shared/error-envelope.ts';

/** Attached to a wrapped execute so `accept-tool-output.mjs` can see the guard is live. */
export const OUTPUT_CHECKED = Symbol.for('dsh-cad-harness.outputChecked');

interface ContractDefinition {
  name: string;
  execute?: unknown;
  output?: { schema?: unknown };
}


/** Remove a leading `<legacy op>: ` from a delegated message (surface layer only). */
function stripLegacyPrefix(cause: string, legacyStage: string): string {
  const name = legacyStage.split(' action=')[0];
  const prefix = `${name}: `;
  return cause.startsWith(prefix) ? cause.slice(prefix.length) : cause;
}

/**
 * The stage a caller can recognize: the surface name, plus the action when one was
 * supplied. Legacy op names (`run_python`, `bind_project`) are NOT callable after the
 * facade cutover, so an error that leads with one sends the model to a dead end.
 */
function stageFor(name: string, args: unknown): string {
  const action = (args as { action?: unknown } | null | undefined)?.action;
  if (typeof action === 'string' && action && action !== 'catalog' && action !== 'help') {
    return `${name} action=${action}`;
  }
  return name;
}

/**
 * Return `definition` with its `execute` guarded by its own declared output schema.
 *
 * A definition without an execute or without a schema is returned untouched: this is a
 * self-check, not a place to invent contracts for tools that declare none (the audit
 * enforces "every tool declares an output schema" separately).
 */
export function withOutputContract<T extends ContractDefinition>(definition: T): T {
  const execute = definition.execute;
  const schema = definition.output?.schema;
  if (typeof execute !== 'function' || !schema) return definition;

  const guarded = async (args: unknown, exec: unknown): Promise<unknown> => {
    try {
      const value = await (execute as (a: unknown, e: unknown) => Promise<unknown>)(args, exec);
      const violations = validateJsonSchemaValue(schema as never, value, 'value');
      if (violations.length > 0) {
        throw new Error(
          `${definition.name}: the body's value does not match its declared output schema ` +
          `(the runtime would reject it before the model sees it):\n  - ${violations.join('\n  - ')}`,
        );
      }
      return value;
    } catch (error) {
      // The tool runtime serializes only `error.message` (dsh-tools
      // toolErrorResult), so the envelope MUST be in the text. Custom Error
      // properties are kept for direct callers, but they are not the channel.
      //
      // A surface delegates to an already-wrapped legacy tool: re-envelope from the
      // inner CAUSE instead of re-classifying the inner TEXT, so the prefix appears
      // once and the stage is the callable surface, not the legacy op.
      const stage = stageFor(definition.name, args);
      const inner = envelopeOf(error);
      // A surface delegates to a legacy tool whose body may still prefix its message
      // with the op name (`set_datums: no usable anchors`). Drop only that prefix:
      // the stage already says what to call, and repeating the dead name is the exact
      // defect this wrapper exists to remove.
      const cause = inner ? stripLegacyPrefix(inner.cause, inner.stage) : '';
      const envelope: ErrorEnvelope = inner
        ? { ...inner, stage, cause, message: cause }
        : classifyError(error, stage);
      const wrapped = withEnvelope(new Error(envelopeText(envelope)), envelope);
      throw wrapped;
    }
  };
  Object.defineProperty(guarded, OUTPUT_CHECKED, { value: true });
  return { ...definition, execute: guarded };
}
