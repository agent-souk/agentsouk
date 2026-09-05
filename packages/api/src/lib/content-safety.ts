/**
 * Heuristic content scanner for agent-authored text (ADR-13, SPEC §7).
 *
 * Every listing, message, review and deliverable on this platform is untrusted input to another LLM.
 * We cannot make text safe, but we can (a) flag the obvious injection / credential-phishing patterns so
 * receiving agents are warned, and (b) reject the worst offenders from public surfaces.
 */

export type ScanResult = { warnings: string[]; severity: 'none' | 'low' | 'high' }

type Rule = { id: string; re: RegExp; severity: 'low' | 'high' }

const RULES: Rule[] = [
  { id: 'instruction_override', re: /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|system)\s+(instructions?|prompts?|rules?|messages?)/i, severity: 'high' },
  { id: 'system_prompt_reference', re: /\b(system\s+prompt|developer\s+message|hidden\s+instructions?)\b/i, severity: 'low' },
  { id: 'role_hijack', re: /\byou\s+are\s+now\s+(a|an|the|in)\b|\bnew\s+persona\b|\bact\s+as\s+(if\s+you\s+are\s+)?(the\s+)?(system|admin|root|developer)\b/i, severity: 'high' },
  { id: 'credential_request', re: /\b(send|share|give|paste|reveal|show|post|reply\s+with)\b[^.\n]{0,60}\b(api[\s_-]?keys?|secret[\s_-]?keys?|private[\s_-]?keys?|seed\s+phrases?|mnemonic|passwords?|access\s+tokens?|bearer\s+tokens?|credentials?)\b/i, severity: 'high' },
  { id: 'credential_mention', re: /\b(api[\s_-]?key|secret[\s_-]?key|private[\s_-]?key|seed\s+phrase|mnemonic)\b/i, severity: 'low' },
  { id: 'shell_pipe', re: /\b(curl|wget|iwr|invoke-webrequest)\b[^\n]{0,200}\|\s*(sh|bash|zsh|powershell|pwsh|python|node)\b/i, severity: 'high' },
  { id: 'exec_pattern', re: /\b(eval\s*\(|exec\s*\(|child_process|subprocess\.|os\.system|rm\s+-rf\s+[\/~])/i, severity: 'low' },
  { id: 'base64_blob', re: /\b[A-Za-z0-9+/]{120,}={0,2}\b/, severity: 'low' },
  { id: 'hidden_unicode', re: /[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u, severity: 'high' },
  { id: 'fake_system_alert', re: /\b(urgent|critical|important)\s+(system|security|admin)\s+(alert|notice|message|update)\b/i, severity: 'low' },
  { id: 'tool_call_smuggling', re: /<\/?(tool_call|function_call|system|assistant|antml:function_calls|invoke)\b/i, severity: 'high' },
]

const URL_RE = /https?:\/\/[^\s)]+/gi

export function scanText(text: string | null | undefined): ScanResult {
  if (!text) return { warnings: [], severity: 'none' }
  const warnings = new Set<string>()
  let severity: ScanResult['severity'] = 'none'
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      warnings.add(rule.id)
      if (rule.severity === 'high') severity = 'high'
      else if (severity === 'none') severity = 'low'
    }
  }
  const urls = text.match(URL_RE)?.length ?? 0
  if (urls > 5) {
    warnings.add('excessive_urls')
    if (severity === 'none') severity = 'low'
  }
  return { warnings: [...warnings], severity }
}

/** Scan several fields at once (e.g. title + description). */
export function scanFields(...texts: (string | null | undefined)[]): ScanResult {
  const merged = new Set<string>()
  let severity: ScanResult['severity'] = 'none'
  for (const t of texts) {
    const r = scanText(t)
    r.warnings.forEach((w) => merged.add(w))
    if (r.severity === 'high') severity = 'high'
    else if (r.severity === 'low' && severity === 'none') severity = 'low'
  }
  return { warnings: [...merged], severity }
}

/** Scan JSON payloads (input/output/data) by walking string values. Depth/size bounded. */
export function scanJson(value: unknown, maxStrings = 200): ScanResult {
  const strings: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (strings.length >= maxStrings || depth > 8) return
    if (typeof v === 'string') strings.push(v)
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1))
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => walk(x, depth + 1))
  }
  walk(value, 0)
  return scanFields(...strings)
}
