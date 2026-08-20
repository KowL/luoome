# Safety and errors

## Advice is not trade

- Advice, StrategySignal, WatchTrigger and event reminders are information for a human decision.
- Never place or cancel an order, call a broker, or interpret a local holding/trade record as market execution.
- Never hide counter-evidence, risks, disclaimers or expiry because confidence is high.
- Encourage outcome recording only after the user reports what actually happened.

When presenting Advice, preserve these fields when returned:

| Field | Requirement |
|---|---|
| `decision` | Report as a recommendation, not an instruction |
| `confidence` | Report as uncertainty, never probability of guaranteed profit |
| `horizon` | State the intended time horizon |
| `reasoning.premise` | Summarize the core thesis |
| `reasoning.evidence` | Include the most relevant supporting evidence |
| `reasoning.counterEvidence` | Always include material opposing evidence |
| `risks` | Always include material risks |
| `disclaimers` | Preserve the returned disclaimers |
| `validUntil` | State when the Advice expires |

## Side-effect confirmation

- Read calls may run without confirmation when they are scoped to the user's request.
- Advice calls should be deliberate because they may invoke an LLM and incur cost.
- Write and external calls require an explicit, transaction-specific authorization. A general request such as “manage my portfolio” is not authorization for an unspecified mutation.
- If write/external tools are not exposed, explain the required MCP configuration; do not use shell commands as a bypass.
- Research embedding calls may send query text or private Vault chunks to the configured provider. Confirm that exact transfer, preserve incomplete/fallback diagnostics, and never paste credentials or private text into error reports.

## ToolResult handling

luoome tools return a success or failure envelope. Do not claim success from transport completion alone.

```json
{
  "ok": false,
  "error": {
    "kind": "adapter_error",
    "recoverable": true
  }
}
```

Handle error kinds conservatively:

| Kind | Response |
|---|---|
| `invalid_input` | Correct only fields justified by the schema or ask the user |
| `not_found` | Re-resolve the subject; do not guess an ID |
| `invariant_violation` | Stop the mutation and report the conflicting invariant |
| `adapter_error` | Retry only when marked recoverable and useful; otherwise report source unavailability |
| `llm_error` | Retry at most once when retryable; offer factual data without fabricated advice |
| `permission_denied` | Explain the missing MCP exposure/authorization |
| `internal` | Report a luoome defect without exposing secrets |

## Context budget

- Apply filters, `limit`, `since` and `until` where supported.
- List first to resolve IDs, then fetch only required details.
- Prefer batch capabilities to repetitive calls, while respecting external-call confirmation.
- Do not repeatedly invoke advice tools to obtain a preferred answer.
- Redact credentials, tokens and private data from logs or copied errors.

The project's full security model is documented in [docs/SECURITY.md](../../../docs/SECURITY.md).
