import type { AdviceReasoning } from '@luoome/core';

const PROMPT_INJECTION_PATTERNS = [
  /ignore (?:all )?previous instructions/gi,
  /you (?:are|must)(?: now)?/gi,
  /system:\s*/gi,
  /<\|.*?\|>/g, // chat template 标记
];

/** Advice 落库前的文本安全边界：模型文本只作为展示证据，不能携带可执行提示词。 */
export const sanitizeAdviceText = (value: string): string => {
  let sanitized = value;
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[redacted]');
  }
  return sanitized;
};

export const sanitizeAdviceReasoning = (reasoning: AdviceReasoning): AdviceReasoning => ({
  premise: sanitizeAdviceText(reasoning.premise),
  evidence: reasoning.evidence.map(sanitizeAdviceText),
  counterEvidence: reasoning.counterEvidence.map(sanitizeAdviceText),
});

export const sanitizeAdviceRisks = (risks: readonly string[]): readonly string[] =>
  risks.map(sanitizeAdviceText);
