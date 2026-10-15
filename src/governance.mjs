// One governed tool call (docs/design.md §3.1, §3.3). Built on agentsafe-guard's guardTool, which already does the hard
// parts: sign as the agent, ask MetaMynd, run the tool only on allow/observe, capture or release the hold, and resume an
// approved escalation exactly once with exactly the approved arguments. This module adds what is MCP-specific:
//   - the arguments are checked against the reviewed mapping before anything is asked;
//   - refusals and holds come back as `isError: true` tool results the model can explain (docs/hosts.md);
//   - a held call is journalled, so the same call made again resumes the approval instead of asking afresh.

import { journalKey } from './journal.mjs';

/** @typedef {import('./config.mjs').ToolMapping} ToolMapping */
/** @typedef {{ content: Array<{ type: string, text?: string }>, isError?: boolean, [k: string]: unknown }} CallToolResult */
/** @typedef {(mapping: ToolMapping, args: Record<string, unknown>) => Promise<CallToolResult>} CallUpstream */

/** JSON-RPC codes an upstream answers before running anything: the tool or its arguments were rejected outright. */
const REJECTED_BEFORE_RUNNING = new Set([-32601, -32602]);
const MAX_TEXT = 2000;

/**
 * How the gateway's guard decides (docs/design.md §3.1, decision 4): EVERY call at the MetaMynd gate, reads included.
 * The guard's default is local-first: a permitted call that moves no money is decided on this computer against the
 * cached signed bundle and only reported to MetaMynd ("agent-reported"). That suits an SDK a developer embeds; the
 * gateway governs an AI app on its owner's behalf, so the gate decides, records the decision as evidence, and every
 * allowed call is held and captured (at 0 for a read). Found in the first real Claude Desktop run (2026-10-15): seven
 * searches were allowed locally and the dashboard showed "0 allowed, +7 agent-reported".
 */
export const GUARD_OPTIONS = Object.freeze({ mode: /** @type {'remote'} */ ('remote') });

/** The upstream refused the call before running it (unknown tool, invalid params): nothing ran, so the hold is released. */
class UpstreamRejected extends Error {
  /** @param {unknown} cause */
  constructor(cause) { super(cause instanceof Error ? cause.message : String(cause)); this.name = 'UpstreamRejected'; }
}
/** The tool reported an error and its mapping says it is safely retryable (`onToolError: "void"`): release the hold. */
class ToolErrorReleased extends Error {
  /** @param {CallToolResult} result */
  constructor(result) { super('tool reported an error'); this.name = 'ToolErrorReleased'; this.result = result; }
}

/** @param {string} text @returns {CallToolResult} */
const errorResult = (text) => ({ content: [{ type: 'text', text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text }], isError: true });

/** @param {Record<string, unknown>} obj @param {string} dotted */
function pick(obj, dotted) {
  /** @type {unknown} */
  let v = obj;
  for (const part of dotted.split('.')) v = v && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v)[part] : undefined;
  return v;
}

/**
 * Check a call's arguments against its reviewed mapping. Returns the problem, or null.
 * @param {ToolMapping} mapping
 * @param {unknown} args
 */
export function argumentProblem(mapping, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return 'the arguments must be an object';
  const a = /** @type {Record<string, unknown>} */ (args);
  const extra = Object.keys(a).filter((k) => !mapping.allowedArgs.includes(k));
  if (extra.length) return `argument(s) not allowed for this tool: ${extra.join(', ')}`;
  if (mapping.amount) {
    const amount = pick(a, mapping.amount);
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return `"${mapping.amount}" must be a number of at least 0`;
  }
  if (mapping.currency) {
    const currency = pick(a, mapping.currency);
    if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) return `"${mapping.currency}" must be a 3-letter currency code`;
  }
  if (mapping.merchant) {
    const merchant = pick(a, mapping.merchant);
    if (typeof merchant !== 'string' || !merchant.trim()) return `"${mapping.merchant}" must name who is paid`;
  }
  return null;
}

/**
 * What MetaMynd is asked: the mapped value fields, the operator's context, and the complete arguments as the payload.
 * @param {ToolMapping} mapping
 * @param {Record<string, unknown>} args
 */
export function mapRequest(mapping, args) {
  /** @type {Record<string, unknown>} */
  const req = { context: { ...mapping.context, tool: mapping.exposedName }, payload: args };
  if (mapping.amount) req.amount = pick(args, mapping.amount);
  if (mapping.currency) req.currency = String(pick(args, mapping.currency)).toUpperCase();
  if (mapping.merchant) req.merchant = pick(args, mapping.merchant);
  return req;
}

/**
 * @param {{
 *   guard: import('@metamynd/agentsafe-guard').Guard,
 *   journal: import('./journal.mjs').Journal,
 *   callUpstream: CallUpstream,
 *   escalationWaitMs?: number,
 *   log?: (entry: Record<string, unknown>) => void,
 * }} deps
 */
export function createGovernance({ guard, journal, callUpstream, escalationWaitMs = 0, log = () => {} }) {
  /** @type {Map<string, import('@metamynd/agentsafe-guard').GuardedTool<Record<string, unknown>, CallToolResult>>} */
  const tools = new Map();

  /** @param {ToolMapping} mapping */
  function guardedFor(mapping) {
    let tool = tools.get(mapping.exposedName);
    if (!tool) {
      tool = guard.guardTool(
        mapping.action,
        async (/** @type {Record<string, unknown>} */ args) => {
          let result;
          try {
            result = await callUpstream(mapping, args);
          } catch (err) {
            const code = /** @type {{ code?: unknown }} */ (err)?.code;
            if (typeof code === 'number' && REJECTED_BEFORE_RUNNING.has(code)) throw new UpstreamRejected(err);
            throw err;
          }
          if (result.isError && mapping.onToolError === 'void') throw new ToolErrorReleased(result);
          return result;
        },
        (args) => /** @type {any} */ (mapRequest(mapping, args)),
        // Release the hold only when nothing ran (or the reviewer marked the tool safely retryable); otherwise it stays
        // counted against the limits, because the tool may have acted.
        { releaseOnError: (err) => err instanceof UpstreamRejected || err instanceof ToolErrorReleased },
      );
      tools.set(mapping.exposedName, tool);
    }
    return tool;
  }

  /** @param {string | null | undefined} escalationId */
  const heldResult = (escalationId) => errorResult(
    `MetaMynd is holding this call for approval by a person${escalationId ? ` (reference ${escalationId})` : ''}. Nothing has run. ` +
    'Once it is approved, make the same call again with the same arguments and it will go through.',
  );

  /**
   * Run one call. Never throws for a governance outcome: refusals and holds are tool results.
   * @param {ToolMapping} mapping
   * @param {unknown} rawArgs
   * @returns {Promise<CallToolResult>}
   */
  async function call(mapping, rawArgs) {
    const problem = argumentProblem(mapping, rawArgs);
    if (problem) return errorResult(`Not sent: ${problem}.`);
    const args = /** @type {Record<string, unknown>} */ (rawArgs ?? {});
    const key = journalKey(mapping.exposedName, args);
    const held = journal.get(key);
    const tool = guardedFor(mapping);
    const waitMs = Math.max(1, escalationWaitMs);
    try {
      const result = held ? await tool.resume(held.escalationId, args, { timeoutMs: waitMs, intervalMs: 1000 }) : await tool(args);
      if (held) await journal.delete(key);
      log({ event: 'call', tool: mapping.exposedName, outcome: held ? 'resumed' : 'allowed' });
      return result;
    } catch (err) {
      if (err instanceof ToolErrorReleased) return /** @type {CallToolResult} */ (err.result);
      if (err instanceof UpstreamRejected) return errorResult(`The tool refused the call before running it: ${err.message}`);
      const e = /** @type {{ name?: string, governance?: import('@metamynd/agentsafe-guard').Verdict }} */ (err);
      if (e?.name === 'GovernanceBlocked' && e.governance) {
        const v = e.governance;
        if (v.decision === 'escalate') {
          const escalationId = v.escalationId ?? held?.escalationId ?? null;
          if (escalationId && !held) {
            await journal.put(key, { escalationId, exposedName: mapping.exposedName, heldAt: new Date().toISOString() });
            if (escalationWaitMs > 0) return call(mapping, args); // wait briefly for a decision, then answer
          }
          log({ event: 'call', tool: mapping.exposedName, outcome: 'held', escalationId });
          return heldResult(escalationId);
        }
        if (held) await journal.delete(key); // rejected, expired or already used: the approval is spent
        log({ event: 'call', tool: mapping.exposedName, outcome: 'refused', reasonCode: v.reasonCode });
        return errorResult(`MetaMynd refused this call (${v.reasonCode}). The tool was not run.${v.hint ? ` ${v.hint}` : ''}`);
      }
      log({ event: 'call', tool: mapping.exposedName, outcome: 'error', error: err instanceof Error ? err.message : String(err) });
      return errorResult(`The tool did not answer (${err instanceof Error ? err.message : String(err)}). It may or may not have acted; check before trying again.`);
    }
  }

  return { call };
}
